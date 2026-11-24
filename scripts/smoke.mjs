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
const modelRequests = [];
const lineReplies = [];

const stub = createServer((req, res) => {
  let body = "";
  req.on("data", (chunk) => {
    body += chunk;
  });
  req.on("end", () => {
    if (req.url === "/v1/chat/completions") {
      modelCalls += 1;
      const payload = JSON.parse(body);
      modelRequests.push(payload);
      assert.equal(payload.tool_choice, "auto", "tools should be offered to the model");
      assert.ok(
        payload.tools.some((tool) => tool.function.name === "facebook_post"),
        "facebook_post tool should be registered",
      );

      // Delegation scenarios: main hands the job to Nova, and a self-handoff is refused.
      const system = payload.messages[0]?.content ?? "";
      const lastUserIndex = payload.messages.map((message) => message.role).lastIndexOf("user");
      const lastUser = payload.messages[lastUserIndex]?.content ?? "";
      // Only a tool result from THIS turn means the tool call already happened; older
      // turns keep their tool messages in the stored history.
      const hasToolResult = payload.messages
        .slice(lastUserIndex + 1)
        .some((message) => message.role === "tool");
      const answer = (message) => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            choices: [{ message }],
            usage: { prompt_tokens: 5, completion_tokens: 5, total_tokens: 10 },
          }),
        );
        return true;
      };
      const delegateTo = (id, task) => ({
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: id,
            type: "function",
            function: { name: "agent_delegate", arguments: JSON.stringify({ to: id, task }) },
          },
        ],
      });
      if (lastUser.includes("delegate-check")) {
        if (hasToolResult) return answer({ role: "assistant", content: "Handed off and got the result." });
        return answer(delegateTo("nova", "make the image"));
      }
      if (lastUser.includes("loop-check")) {
        if (hasToolResult) return answer({ role: "assistant", content: "I will do it myself." });
        return answer(delegateTo("main", "pass this on again"));
      }
      if (lastUser === "make the image") {
        return answer({ role: "assistant", content: "IMAGE-OK" });
      }
      if (/You are Nova/.test(system) && !lastUser.includes("make the image")) {
        return answer({ role: "assistant", content: "Nova here." });
      }

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

    if (req.url === "/v2/bot/message/reply" || req.url === "/v2/bot/message/push") {
      lineReplies.push({ path: req.url, body: JSON.parse(body) });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({}));
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
    LINE_CHANNEL_SECRET: "smoke-line-secret",
    LINE_CHANNEL_ACCESS_TOKEN: "smoke-line-token",
    LINE_ALLOWED_SOURCE_IDS: "Uallowed",
    LINE_API_BASE_URL: stubBase,
  });

  const { loadConfig } = await import("../dist/config.js");
  const { AgentHarness } = await import("../dist/agent.js");
  const { ModelCatalog } = await import("../dist/models.js");
  const { SessionStore } = await import("../dist/store.js");
  const { createToolRegistry } = await import("../dist/tools/index.js");
  const { AgentRegistry } = await import("../dist/agents.js");
  const { createGateway } = await import("../dist/gateway/server.js");
  const { createLogger } = await import("../dist/log.js");
  const { UsageLedger } = await import("../dist/usage.js");
  const { LineChannel } = await import("../dist/channels/line.js");
  const { ApprovalQueue } = await import("../dist/extensions/approvals.js");
  const { ApprovalService } = await import("../dist/extensions/approval-service.js");
  const { ApprovalRelay } = await import("../dist/extensions/approval-relay.js");
  const { createHmac } = await import("node:crypto");

  const config = loadConfig();
  const log = createLogger("smoke");
  const catalog = new ModelCatalog(config.providers, config.defaultModel);
  const store = new SessionStore(config.dataDir);
  await store.init();
  const tools = createToolRegistry(config);
  const ledger = new UsageLedger(config.dataDir, config.prices);
  await ledger.init();
  const agents = new AgentRegistry(config.dataDir);
  const harness = new AgentHarness({ config, store, catalog, tools, ledger, log, agents });
  const approvals = new ApprovalQueue();
  const approvalService = new ApprovalService(approvals, () => harness.extensions ?? null);
  const line = new LineChannel(config.line, harness, createLogger("line"), undefined, {
    approvals: approvalService,
  });
  const gateway = createGateway({
    config,
    harness,
    log: createLogger("gateway"),
    agents,
    line,
    approvals,
    approvalService,
  });

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
    assert.deepEqual(ready.tools, ["facebook_post", "agent_delegate"]);
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

    // 12. Agents: create, configure, move, chat with a character, delete
    assert.ok(Array.isArray(ready.agents) && ready.agents.length === 1, "gateway seeds one default agent");
    assert.equal(ready.agents[0].id, "main");
    assert.equal(ready.office.scenes.length, 5, "scenes come from board/assets/office.json");
    assert.equal(ready.office.characters.length, 6);
    assert.equal(ready.office.characters[0].frames, 4, "characters use the 4-frame sprite sheet");
    check("ready frame carries agents and office assets");

    socket.send(
      JSON.stringify({
        type: "agent.create",
        name: "Nova",
        emoji: "✦",
        role: "writer",
        identity: "You write one-line posts.",
      }),
    );
    const created = await inbox.next(
      (frame) => frame.type === "agents.state" && frame.agents.some((agent) => agent.name === "Nova"),
      "agents.state after create",
    );
    const nova = created.agents.find((agent) => agent.name === "Nova");
    assert.equal(nova.role, "writer");
    assert.equal(nova.identity, "You write one-line posts.");
    check("agent.create broadcasts a new profile");

    socket.send(JSON.stringify({ type: "agent.update", id: nova.id, x: 12, y: 40, model: "custom:smoke-model" }));
    const moved = await inbox.next(
      (frame) => frame.type === "agents.state" && frame.agents.find((agent) => agent.id === nova.id)?.x === 12,
      "agents.state after update",
    );
    assert.equal(moved.agents.find((agent) => agent.id === nova.id).model, "custom:smoke-model");
    check("agent.update stores position and model");

    socket.send(JSON.stringify({ type: "office.scene", scene: "night" }));
    await inbox.next((frame) => frame.type === "agents.state" && frame.scene === "night", "scene broadcast");
    check("office.scene is shared with every board client");

    socket.send(
      JSON.stringify({
        type: "chat.send",
        sessionId: `board:agent:${nova.id}`,
        agentId: nova.id,
        text: "hello nova",
      }),
    );
    await inbox.next(
      (frame) =>
        frame.type === "event" &&
        frame.event.type === "turn.end" &&
        frame.event.sessionId === `board:agent:${nova.id}`,
      "turn.end for the character",
    );
    const novaSystem = modelRequests.at(-1).messages[0].content;
    assert.match(novaSystem, /Nova/);
    assert.match(novaSystem, /writer/);
    assert.match(novaSystem, /You write one-line posts\./);
    check("chatting with a character uses its identity, role and model");

    // 12b. Agent-to-agent handoff: one character passes work to a colleague.
    socket.send(
      JSON.stringify({
        type: "chat.send",
        sessionId: "board:agent:main",
        agentId: "main",
        text: "delegate-check",
      }),
    );
    const handoff = await inbox.next(
      (frame) =>
        frame.type === "event" &&
        frame.event.type === "tool.start" &&
        frame.event.name === "agent_delegate" &&
        frame.event.sessionId === "board:agent:main",
      "agent_delegate tool.start",
    );
    assert.equal(handoff.event.args.to, "nova");
    const talk = await inbox.next((frame) => frame.type === "office.talk", "office.talk frame");
    assert.equal(talk.from, "main");
    assert.equal(talk.to, nova.id);
    assert.match(talk.text, /make the image/);
    const handed = await inbox.next(
      (frame) =>
        frame.type === "event" &&
        frame.event.type === "tool.result" &&
        frame.event.name === "agent_delegate" &&
        frame.event.ok === true,
      "agent_delegate tool.result",
    );
    assert.match(handed.event.preview, /Nova/);
    assert.match(handed.event.preview, /IMAGE-OK/);
    const parentAnswer = await inbox.next(
      (frame) =>
        frame.type === "event" &&
        frame.event.type === "assistant.message" &&
        frame.event.sessionId === "board:agent:main",
      "main's answer after the handoff",
    );
    assert.equal(parentAnswer.event.text, "Handed off and got the result.");
    const novaSession = await store.get(`board:agent:${nova.id}`);
    assert.ok(
      novaSession.messages.some((message) => message.role === "user" && message.content === "make the image"),
      "the colleague ran the handed task in its own session",
    );
    const seats = await gateway.agents.list();
    assert.ok(
      Math.abs(seats.find((entry) => entry.id === "main").y - 51) < 0.001,
      "both characters walked to the same spot for the handoff",
    );
    check("agent_delegate: A hands work to B, B runs its own turn, A continues with the result");

    // 12c. A character cannot hand work to itself or loop a chain.
    socket.send(
      JSON.stringify({
        type: "chat.send",
        sessionId: "board:agent:main",
        agentId: "main",
        text: "loop-check",
      }),
    );
    const refused = await inbox.next(
      (frame) =>
        frame.type === "event" &&
        frame.event.type === "tool.result" &&
        frame.event.name === "agent_delegate" &&
        frame.event.ok === false,
      "refused self-handoff",
    );
    assert.match(refused.event.preview, /yourself/);
    check("agent_delegate: refusing to hand work back to yourself");

    socket.send(JSON.stringify({ type: "agent.delete", id: nova.id }));
    const afterDelete = await inbox.next(
      (frame) => frame.type === "agents.state" && !frame.agents.some((agent) => agent.id === nova.id),
      "agents.state after delete",
    );
    assert.equal(afterDelete.agents.length, 1);
    const stored = JSON.parse(await readFile(path.join(dataDir, "agents.json"), "utf8"));
    assert.equal(stored.agents.length, 1, "agents.json is persisted");
    assert.equal(stored.scene, "night");
    check("agent.delete and agents.json persistence");

    // 13. Extension changes proposed by an agent wait for the operator
    approvals.request({
      action: "install",
      name: "demo-plugin",
      sessionId: "board:agent:main",
      agentId: "main",
    });
    socket.send(JSON.stringify({ type: "approvals.list" }));
    const pending = await inbox.next((frame) => frame.type === "approvals.state", "approvals.state");
    assert.equal(pending.requests.length, 1);
    assert.equal(pending.writes, "confirm");
    socket.send(JSON.stringify({ type: "approval.reject", id: pending.requests[0].id }));
    const rejectResult = await inbox.next((frame) => frame.type === "approval.result", "approval.result");
    assert.equal(rejectResult.ok, true, rejectResult.message);
    assert.equal(approvals.list().length, 0, "a rejected request leaves the queue");
    check("extension changes wait for an explicit operator decision");

    socket.close();

    // 13. LINE channel: signed webhook, allowlist, dedupe, reply
    const lineSignature = (body) =>
      createHmac("sha256", "smoke-line-secret").update(body).digest("base64");
    const lineWebhook = (payload, signature) =>
      fetch(`http://127.0.0.1:${port}/webhooks/line`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(signature ? { "x-line-signature": signature } : {}),
        },
        body: payload,
      });
    const lineEvent = (eventId, text, userId = "Uallowed") =>
      JSON.stringify({
        destination: "Ubot",
        events: [
          {
            type: "message",
            webhookEventId: eventId,
            replyToken: `reply-${eventId}`,
            timestamp: Date.now(),
            source: { type: "user", userId },
            message: { type: "text", id: `msg-${eventId}`, text },
          },
        ],
      });
    const waitFor = async (predicate, label, timeoutMs = 6000) => {
      const started = Date.now();
      while (Date.now() - started < timeoutMs) {
        if (predicate()) return;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      throw new Error(`timed out waiting for ${label}`);
    };

    const unsigned = await lineWebhook(lineEvent("evt-0", "hi"), "not-a-signature");
    assert.equal(unsigned.status, 403);
    const callsBeforeLine = modelCalls;
    assert.equal(modelCalls, callsBeforeLine);
    check("LINE webhook rejects an invalid x-line-signature");

    const firstBody = lineEvent("evt-1", "สวัสดีจาก LINE");
    const accepted = await lineWebhook(firstBody, lineSignature(firstBody));
    assert.equal(accepted.status, 200);
    await waitFor(() => lineReplies.length === 1, "the first LINE reply");
    assert.equal(lineReplies[0].path, "/v2/bot/message/reply");
    assert.equal(lineReplies[0].body.replyToken, "reply-evt-1");
    assert.ok(lineReplies[0].body.messages[0].text.length > 0);
    check("LINE: signed webhook named the agent and answered via the reply API");

    const afterFirst = modelCalls;
    const duplicate = await lineWebhook(firstBody, lineSignature(firstBody));
    assert.equal(duplicate.status, 200);
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal(lineReplies.length, 1, "a redelivered webhook must not answer twice");
    assert.equal(modelCalls, afterFirst, "a redelivered webhook must not run another turn");
    check("LINE: redelivered webhookEventId is ignored");

    const strangerBody = lineEvent("evt-2", "hello", "Ustranger");
    const stranger = await lineWebhook(strangerBody, lineSignature(strangerBody));
    assert.equal(stranger.status, 200);
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal(lineReplies.length, 1, "a sender outside LINE_ALLOWED_SOURCE_IDS gets no answer");
    assert.equal(modelCalls, afterFirst, "a stranger must not reach the model");
    check("LINE: senders outside the allowlist are ignored by default");

    const status = await (
      await fetch(`http://127.0.0.1:${port}/api/status`, { headers: { authorization: "Bearer smoke-token" } })
    ).json();
    assert.equal(status.line.webhookVerified, true);
    assert.equal(status.line.replied, 1);
    assert.equal(status.line.rejected, 1);
    check("/api/status reports LINE as verified, replied and rejected counts");

    // 14. An approval request reaches the chat, and the chat can decide it.
    const relay = new ApprovalRelay(approvals, approvalService, createLogger("approvals"));
    relay.addSender("line:Uallowed", (text) => line.pushText("Uallowed", text));
    relay.start();
    const lineApproval = approvals.request({
      action: "install",
      name: "remote-chat",
      sessionId: "line:Uallowed",
    });
    await relay.idle();
    assert.equal(lineReplies.length, 2, "the allowed LINE chat gets one push notification");
    assert.equal(lineReplies[1].path, "/v2/bot/message/push");
    assert.equal(lineReplies[1].body.to, "Uallowed");
    const shortId = lineApproval.id.slice(0, 8);
    assert.match(lineReplies[1].body.messages[0].text, /remote-chat/);
    assert.match(lineReplies[1].body.messages[0].text, new RegExp(`approve ${shortId}`));
    check("a new approval request is pushed to the allowed LINE chat");

    const callsBeforeApproval = modelCalls;
    const listBody = lineEvent("evt-3", "approvals");
    assert.equal((await lineWebhook(listBody, lineSignature(listBody))).status, 200);
    await waitFor(() => lineReplies.length === 3, "the approval list reply");
    assert.match(lineReplies[2].body.messages[0].text, /remote-chat/);
    check("LINE: `approvals` lists the pending request");

    const rejectBody = lineEvent("evt-4", `reject ${shortId}`);
    assert.equal((await lineWebhook(rejectBody, lineSignature(rejectBody))).status, 200);
    await waitFor(() => lineReplies.length === 4, "the rejection reply");
    assert.match(lineReplies[3].body.messages[0].text, /ปฏิเสธ/);
    assert.equal(approvals.list().length, 0, "the chat decision clears the queue");
    assert.equal(modelCalls, callsBeforeApproval, "a chat command must not run a model turn");
    check("LINE: `reject <id>` resolves the request without a model turn");
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
