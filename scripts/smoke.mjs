#!/usr/bin/env node
/**
 * End-to-end smoke test for the gateway, agent loop and tool execution.
 * Runs against the compiled dist/ build with a stub OpenAI-compatible server
 * and a stub Graph API endpoint, so no real keys or network calls are needed.
 *
 *   npm run build && npm run smoke
 */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { WebSocket } from "ws";

let modelCalls = 0;
let graphCalls = 0;
const graphBodies = [];

const stub = createServer((req, res) => {
  let body = "";
  req.on("data", (chunk) => {
    body += chunk;
  });
  req.on("end", () => {
    if (req.url === "/v1/chat/completions") {
      modelCalls += 1;
      const payload = JSON.parse(body);
      assert.equal(payload.tool_choice, "auto", "tools should be offered to the model");
      assert.ok(
        payload.tools.some((tool) => tool.function.name === "facebook_post"),
        "facebook_post tool should be registered",
      );
      res.writeHead(200, { "content-type": "application/json" });
      if (modelCalls === 1) {
        res.end(
          JSON.stringify({
            choices: [
              {
                message: {
                  role: "assistant",
                  content: null,
                  tool_calls: [
                    {
                      id: "call_smoke_1",
                      type: "function",
                      function: {
                        name: "facebook_post",
                        arguments: JSON.stringify({ message: "hello from the harness" }),
                      },
                    },
                  ],
                },
              },
            ],
            usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
          }),
        );
        return;
      }
      res.end(
        JSON.stringify({
          choices: [{ message: { role: "assistant", content: "Posted to Facebook." } }],
          usage: { prompt_tokens: 20, completion_tokens: 4, total_tokens: 24 },
        }),
      );
      return;
    }

    if (req.url === "/v21.0/1234567890/feed") {
      graphCalls += 1;
      graphBodies.push(body);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ id: "1234567890_987654321" }));
      return;
    }

    res.writeHead(404, { "content-type": "text/plain" });
    res.end("not found");
  });
});

/** Attach the frame collector before `open` so the greeting frame is never missed. */
function openClient(url) {
  const socket = new WebSocket(url);
  const inbox = collectFrames(socket);
  const opened = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("websocket open timeout")), 5000);
    socket.once("open", () => {
      clearTimeout(timer);
      resolve();
    });
    socket.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
  return { socket, inbox, opened };
}

function collectFrames(socket) {
  const frames = [];
  const waiters = [];
  socket.on("message", (data) => {
    const frame = JSON.parse(data.toString());
    frames.push(frame);
    for (const waiter of [...waiters]) {
      if (waiter.predicate(frame)) {
        waiters.splice(waiters.indexOf(waiter), 1);
        waiter.resolve(frame);
      }
    }
  });
  return {
    frames,
    next(predicate, label, timeoutMs = 8000) {
      const existing = frames.find(predicate);
      if (existing) return Promise.resolve(existing);
      return new Promise((resolve, reject) => {
        const waiter = { predicate, resolve };
        waiters.push(waiter);
        setTimeout(() => {
          const index = waiters.indexOf(waiter);
          if (index >= 0) waiters.splice(index, 1);
          reject(new Error(`timed out waiting for ${label}`));
        }, timeoutMs);
      });
    },
  };
}

async function main() {
  await new Promise((resolve) => stub.listen(0, "127.0.0.1", resolve));
  const stubPort = stub.address().port;
  const stubBase = `http://127.0.0.1:${stubPort}`;

  const dataDir = await mkdtemp(path.join(tmpdir(), "clawgate-smoke-"));

  Object.assign(process.env, {
    GATEWAY_TOKEN: "smoke-token",
    PORT: "0",
    HOST: "127.0.0.1",
    DATA_DIR: dataDir,
    LOG_LEVEL: "warn",
    LLM_BASE_URL: `${stubBase}/v1`,
    LLM_API_KEY: "smoke-key",
    LLM_MODELS: "smoke-model",
    DEFAULT_MODEL: "custom:smoke-model",
    MODEL_PRICES: "custom:smoke-model=1/2",
    FACEBOOK_PAGE_ID: "1234567890",
    FACEBOOK_PAGE_ACCESS_TOKEN: "smoke-page-token",
    FACEBOOK_GRAPH_BASE_URL: stubBase,
    FACEBOOK_GRAPH_VERSION: "v21.0",
  });

  const { loadConfig } = await import("../dist/config.js");
  const { AgentHarness } = await import("../dist/agent.js");
  const { ModelCatalog } = await import("../dist/models.js");
  const { SessionStore } = await import("../dist/store.js");
  const { createToolRegistry } = await import("../dist/tools/index.js");
  const { createGateway } = await import("../dist/gateway/server.js");
  const { createLogger } = await import("../dist/log.js");
  const { UsageLedger } = await import("../dist/usage.js");

  const config = loadConfig();
  const log = createLogger("smoke");
  const catalog = new ModelCatalog(config.providers, config.defaultModel);
  const store = new SessionStore(config.dataDir);
  await store.init();
  const tools = createToolRegistry(config);
  const ledger = new UsageLedger(config.dataDir, config.prices);
  await ledger.init();
  const harness = new AgentHarness({ config, store, catalog, tools, ledger, log });
  const gateway = createGateway({ config, harness, log: createLogger("gateway") });

  const port = await gateway.start(0, "127.0.0.1");
  const wsBase = `ws://127.0.0.1:${port}`;
  let failures = 0;

  const check = (label) => console.log(`  ok  ${label}`);

  try {
    // 1. HTTP health
    const health = await fetch(`http://127.0.0.1:${port}/api/health`);
    assert.equal(health.status, 200);
    assert.equal((await health.json()).ok, true);
    check("GET /api/health");

    // 2. Board assets are served
    const board = await fetch(`http://127.0.0.1:${port}/`);
    assert.equal(board.status, 200);
    assert.match(await board.text(), /clawgate/);
    check("board index.html served");

    // 3. Status endpoint requires the token
    const denied = await fetch(`http://127.0.0.1:${port}/api/status`);
    assert.equal(denied.status, 401);
    const allowed = await fetch(`http://127.0.0.1:${port}/api/status`, {
      headers: { authorization: "Bearer smoke-token" },
    });
    assert.equal(allowed.status, 200);
    check("token-gated /api/status");

    // 4. Websocket rejects a bad token
    const rejected = openClient(`${wsBase}/ws?token=wrong`);
    await assert.rejects(() => rejected.opened, /401/);
    check("websocket rejects invalid gateway token");

    // 5. Websocket accepts the gateway token and greets the board
    const client = openClient(`${wsBase}/ws?token=smoke-token`);
    await client.opened;
    const { socket, inbox } = client;
    const ready = await inbox.next((frame) => frame.type === "ready", "ready frame");
    assert.equal(ready.defaultModel, "custom:smoke-model");
    assert.deepEqual(ready.tools, ["facebook_post"]);
    check("ready frame carries models and tools");

    // 6. Model selection
    socket.send(JSON.stringify({ type: "models.list" }));
    const models = await inbox.next((frame) => frame.type === "models.list", "models.list");
    assert.equal(models.models.length, 1);
    assert.equal(models.models[0].ref, "custom:smoke-model");
    socket.send(JSON.stringify({ type: "model.set", sessionId: "board:smoke", model: "custom:smoke-model" }));
    const set = await inbox.next((frame) => frame.type === "model.set", "model.set");
    assert.equal(set.model, "custom:smoke-model");
    check("model listing and selection");

    // 7. Agent turn with a tool call
    socket.send(JSON.stringify({ type: "chat.send", sessionId: "board:smoke", text: "post hello" }));
    const start = await inbox.next(
      (frame) => frame.type === "event" && frame.event.type === "tool.start",
      "tool.start event",
    );
    assert.equal(start.event.name, "facebook_post");
    const result = await inbox.next(
      (frame) => frame.type === "event" && frame.event.type === "tool.result",
      "tool.result event",
    );
    assert.equal(result.event.ok, true, result.event.preview);
    assert.match(result.event.preview, /1234567890_987654321/);
    const answer = await inbox.next(
      (frame) => frame.type === "event" && frame.event.type === "assistant.message",
      "assistant.message event",
    );
    assert.equal(answer.event.text, "Posted to Facebook.");
    const end = await inbox.next(
      (frame) => frame.type === "event" && frame.event.type === "turn.end",
      "turn.end event",
    );
    assert.equal(end.event.iterations, 2);
    // Per-turn usage is summed over every model call in the turn (15 + 24).
    assert.equal(end.event.usage.total_tokens, 39);
    assert.equal(end.event.usage.prompt_tokens, 30);
    assert.equal(end.event.usage.completion_tokens, 9);
    // 30 prompt tokens at $1/M + 9 completion tokens at $2/M.
    assert.ok(Math.abs(end.event.costUsd - 0.000048) < 1e-12, `unexpected turn cost ${end.event.costUsd}`);
    check("agent loop: tool call -> tool result -> final answer");

    // 8. The stub Graph API actually received the page post
    assert.equal(graphCalls, 1);
    const posted = new URLSearchParams(graphBodies[0]);
    assert.equal(posted.get("message"), "hello from the harness");
    assert.equal(posted.get("access_token"), "smoke-page-token");
    check("facebook_post called Graph API with the page token");

    // 9. Session persisted and listed
    socket.send(JSON.stringify({ type: "sessions.list" }));
    const sessions = await inbox.next((frame) => frame.type === "sessions.list", "sessions.list");
    const session = sessions.sessions.find((entry) => entry.id === "board:smoke");
    assert.ok(session, "session should be listed");
    assert.equal(session.model, "custom:smoke-model");
    assert.ok(session.messages >= 4, `expected stored history, got ${session.messages}`);
    socket.send(JSON.stringify({ type: "session.history", sessionId: "board:smoke" }));
    const history = await inbox.next((frame) => frame.type === "session.history", "session.history");
    assert.deepEqual(
      history.messages.map((message) => message.role),
      ["user", "assistant", "assistant"],
    );
    check("session persistence and history replay");

    // 10. Reset clears the conversation
    socket.send(JSON.stringify({ type: "session.reset", sessionId: "board:smoke" }));
    await inbox.next((frame) => frame.type === "session.reset", "session.reset");
    const cleared = await store.get("board:smoke");
    assert.equal(cleared.messages.length, 0);
    check("session reset");

    // 11. Token usage and estimated cost are logged per turn and aggregated per provider
    const usage = ledger.summary();
    assert.equal(usage.total.turns, 1);
    assert.equal(usage.total.totalTokens, 39);
    assert.ok(Math.abs(usage.total.costUsd - 0.000048) < 1e-12, `unexpected ledger cost ${usage.total.costUsd}`);
    assert.equal(usage.models.length, 1);
    assert.equal(usage.models[0].model, "custom:smoke-model");
    assert.equal(usage.models[0].turns, 1);
    assert.equal(usage.providers.length, 1);
    assert.equal(usage.providers[0].providerId, "custom");
    assert.equal(usage.providers[0].promptTokens, 30);
    const usageLog = await readFile(path.join(dataDir, "usage.jsonl"), "utf8");
    const entry = JSON.parse(usageLog.trim().split("\n").at(-1));
    assert.equal(entry.model, "custom:smoke-model");
    assert.equal(entry.totalTokens, 39);
    assert.ok(Math.abs(entry.costUsd - 0.000048) < 1e-12, `unexpected logged cost ${entry.costUsd}`);
    check("usage ledger: per-turn tokens + cost persisted and rolled up per provider");

    socket.close();
  } finally {
    await gateway.stop();
    await new Promise((resolve) => stub.close(resolve));
    await rm(dataDir, { recursive: true, force: true });
  }

  if (failures > 0) {
    console.error(`${failures} check(s) failed`);
    process.exit(1);
  }
  console.log("\nsmoke: all checks passed");
}

main().catch((error) => {
  console.error("smoke failed:", error);
  process.exit(1);
});
