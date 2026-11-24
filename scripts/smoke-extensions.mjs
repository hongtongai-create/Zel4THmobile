#!/usr/bin/env node
/**
 * End-to-end test for the extension system: clawhub install of a skill, a JS
 * plugin and an MCP server, hot reload, tool invocation and safe paths.
 *
 *   npm run build && npm run smoke:ext
 */
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const MCP_SERVER = `
process.stdin.setEncoding("utf8");
let buffer = "";
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let index;
  while ((index = buffer.indexOf("\\n")) >= 0) {
    const line = buffer.slice(0, index);
    buffer = buffer.slice(index + 1);
    if (!line.trim()) continue;
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      continue;
    }
    if (message.id === undefined) continue;
    const respond = (result) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }) + "\\n");
    if (message.method === "initialize") {
      respond({ protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "demo", version: "1.0.0" } });
    } else if (message.method === "tools/list") {
      respond({
        tools: [
          {
            name: "echo",
            description: "Echo text back",
            inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
          },
        ],
      });
    } else if (message.method === "tools/call") {
      const text = message.params && message.params.arguments ? message.params.arguments.text : "";
      respond({ content: [{ type: "text", text: "echo:" + text }] });
    } else {
      respond({});
    }
  }
});
`;

const PLUGIN_MODULE = `
export const prompt = "プレフィックス: plugin prompt is in the system prompt";
export const tools = [
  {
    name: "shout",
    description: "Uppercase the given text",
    parameters: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
    async handler(args) {
      return String(args.text || "").toUpperCase();
    },
  },
];
`;

async function main() {
  const base = await mkdtemp(path.join(tmpdir(), "clawgate-ext-"));
  const extensionsDir = path.join(base, "extensions");
  const dataDir = path.join(base, "data");
  const mcpServerPath = path.join(base, "demo-mcp.mjs");
  const registryPath = path.join(base, "clawhub.json");

  await mkdir(path.join(extensionsDir, "plugins", "zz-broken"), { recursive: true });
  await writeFile(
    path.join(extensionsDir, "plugins", "zz-broken", "index.mjs"),
    'throw new Error("plugin exploded on import");\n',
    "utf8",
  );
  await mkdir(path.join(extensionsDir, "plugins", "zz-noentry"), { recursive: true });
  await writeFile(
    path.join(extensionsDir, "plugins", "zz-noentry", "plugin.json"),
    JSON.stringify({ name: "zz-noentry", entry: "index.mjs" }),
    "utf8",
  );
  await mkdir(path.join(extensionsDir, "plugins", "zz-wrongshape"), { recursive: true });
  await writeFile(
    path.join(extensionsDir, "plugins", "zz-wrongshape", "index.mjs"),
    'export const tools = [{ name: "half-tool", description: "no handler" }];\n',
    "utf8",
  );

  await mkdir(extensionsDir, { recursive: true });
  await writeFile(mcpServerPath, MCP_SERVER, "utf8");

  await writeFile(
    registryPath,
    JSON.stringify({
      name: "test-registry",
      version: 1,
      entries: [
        {
          name: "note-skill",
          kind: "skill",
          version: "1.2.3",
          description: "Test skill",
          files: { "SKILL.md": "---\nname: note-skill\ndescription: test skill\n---\n\nAlways answer with the word BANANA." },
        },
        {
          name: "shout-plugin",
          kind: "plugin",
          version: "0.1.0",
          files: { "plugin.json": JSON.stringify({ name: "shout-plugin", description: "shout", entry: "index.mjs" }), "index.mjs": PLUGIN_MODULE },
        },
        { name: "demo", kind: "mcp", command: process.execPath, args: [mcpServerPath] },
        { name: "evil", kind: "skill", files: { "../escape.md": "nope" } },
      ],
    }),
    "utf8",
  );

  Object.assign(process.env, {
    GATEWAY_TOKEN: "ext-token",
    DATA_DIR: dataDir,
    EXTENSIONS_DIR: extensionsDir,
    CLAWHUB_URL: registryPath,
    LOG_LEVEL: "error",
    LLM_BASE_URL: "http://127.0.0.1:1/v1",
    LLM_MODELS: "smoke-model",
    DEFAULT_MODEL: "custom:smoke-model",
  });

  const { loadConfig } = await import("../dist/config.js");
  const { createLogger } = await import("../dist/log.js");
  const { ExtensionManager } = await import("../dist/extensions/index.js");
  const { ToolRegistry, createToolRegistry } = await import("../dist/tools/index.js");
  const { createExtensionsTool } = await import("../dist/tools/extensions.js");
  const { ApprovalQueue } = await import("../dist/extensions/approvals.js");
  const { ApprovalService, parseApprovalCommand } = await import("../dist/extensions/approval-service.js");
  const { ApprovalRelay } = await import("../dist/extensions/approval-relay.js");
  const { AgentHarness } = await import("../dist/agent.js");
  const { ModelCatalog } = await import("../dist/models.js");
  const { SessionStore } = await import("../dist/store.js");

  const config = loadConfig();
  assert.equal(config.clawhubUrl, registryPath);
  assert.equal(config.extensionsDir, path.resolve(extensionsDir));

  const log = createLogger("smoke-ext");
  const manager = new ExtensionManager(config, log);
  const check = (label) => console.log(`  ok  ${label}`);

  try {
    await manager.init();
    const tools = createToolRegistry(config);
    manager.register(tools);
    // Setup installs run directly; the approval path is exercised further down.
    tools.register(createExtensionsTool(manager, { writes: "allow" }));

    assert.deepEqual(manager.summary().skills, []);
    assert.deepEqual(manager.summary().mcp, []);
    assert.equal(manager.promptSections().length, 0);
    check("empty extensions dir loads cleanly");

    // Loader diagnostics: a broken, incomplete or malformed plugin says why.
    const diagnostics = manager.diagnostics();
    const find = (name) => diagnostics.find((entry) => entry.name === name);
    assert.equal(find("zz-broken").status, "failed");
    assert.match(find("zz-broken").reason, /import failed/);
    assert.equal(find("zz-noentry").status, "skipped");
    assert.match(find("zz-noentry").reason, /not found/);
    assert.equal(find("zz-wrongshape").status, "skipped");
    assert.match(find("zz-wrongshape").reason, /do not match/);
    assert.match(manager.formatDiagnostics(), /plugin:zz-broken/);
    const viaTool = await tools.invoke("extensions", JSON.stringify({ action: "diagnostics" }), {
      sessionId: "cli:smoke",
      log,
    });
    assert.equal(viaTool.ok, true, viaTool.output);
    assert.match(viaTool.output, /zz-wrongshape/);
    check("loader diagnostics explain skipped and failed plugins");

    // The agent tool installs from the registry and reloads in one step.
    const extensionsTool = tools.names().includes("extensions");
    assert.ok(extensionsTool, "extensions tool must be registered");

    const search = await tools.invoke("extensions", JSON.stringify({ action: "search", query: "shout" }), {
      sessionId: "cli:smoke",
      log,
    });
    assert.equal(search.ok, true, search.output);
    assert.match(search.output, /shout-plugin \[plugin\]/);
    check("registry search");

    for (const name of ["note-skill", "shout-plugin", "demo"]) {
      const outcome = await tools.invoke("extensions", JSON.stringify({ action: "install", name }), {
        sessionId: "cli:smoke",
        log,
      });
      assert.equal(outcome.ok, true, outcome.output);
    }

    const summary = manager.summary();
    assert.deepEqual(summary.skills, ["note-skill"]);
    assert.deepEqual(summary.plugins, ["shout-plugin"]);
    assert.deepEqual(summary.mcp, ["demo"]);
    check("installed one skill, one plugin and one MCP server");

    assert.ok(tools.names().includes("shout"), `plugin tool missing: ${tools.names().join(",")}`);
    assert.ok(tools.names().includes("demo__echo"), `MCP tool missing: ${tools.names().join(",")}`);
    check("plugin and MCP tools registered");

    const pluginCall = await tools.invoke("shout", JSON.stringify({ text: "hi" }), { sessionId: "cli:smoke", log });
    assert.equal(pluginCall.ok, true, pluginCall.output);
    assert.equal(pluginCall.output, "HI");

    // Permissions are enforced when the tool runs, not only in the prompt.
    const deniedCall = await tools.invoke("shout", JSON.stringify({ text: "hi" }), {
      sessionId: "cli:smoke",
      log,
      allowedTools: new Set(),
    });
    assert.equal(deniedCall.ok, false);
    assert.match(deniedCall.output, /Permission denied/);
    const allowedCall = await tools.invoke("shout", JSON.stringify({ text: "hi" }), {
      sessionId: "cli:smoke",
      log,
      allowedTools: new Set(["shout"]),
    });
    assert.equal(allowedCall.ok, true, allowedCall.output);
    check("extension tool permission is enforced at invoke time");

    const mcpCall = await tools.invoke("demo__echo", JSON.stringify({ text: "hello" }), { sessionId: "cli:smoke", log });
    assert.equal(mcpCall.ok, true, mcpCall.output);
    assert.equal(mcpCall.output, "echo:hello");
    check("plugin tool and MCP tools actually execute");

    const sections = manager.promptSections().join("\n");
    assert.match(sections, /BANANA/, "skill body must reach the prompt");
    assert.match(sections, /plugin prompt is in the system prompt/);
    check("skill and plugin prompt text are injected into the system prompt");

    // Prove the prompt is really rendered by the harness, not just loaded.
    const catalog = new ModelCatalog(config.providers, config.defaultModel);
    const store = new SessionStore(config.dataDir);
    await store.init();
    const harness = new AgentHarness({ config, store, catalog, tools, log, extensions: manager });
    // `systemPrompt` is TypeScript-private only, so it is reachable here.
    const prompt = harness.systemPrompt("custom:smoke-model");
    assert.match(prompt, /Skill: note-skill/);
    assert.match(prompt, /demo__echo/);
    check("agent system prompt lists the skills and MCP tools");

    await assert.rejects(
      () => manager.hub.installByName("evil"),
      /Unsafe file path|Unsafe/,
      "path traversal must be rejected",
    );
    await assert.rejects(() => readFile(path.join(base, "escape.md"), "utf8"));
    check("registry refuses path traversal");

    const removed = await tools.invoke("extensions", JSON.stringify({ action: "remove", name: "demo" }), {
      sessionId: "cli:smoke",
      log,
    });
    assert.equal(removed.ok, true, removed.output);
    assert.ok(!manager.summary().mcp.includes("demo"));
    assert.ok(!tools.names().includes("demo__echo"), "removed MCP tools must leave the registry");
    check("remove unloads MCP server and its tools");

    const installed = await readFile(path.join(extensionsDir, "installed.json"), "utf8");
    assert.match(installed, /note-skill/);
    check("installed.json manifest records installed extensions");

    // A plugin must not silently replace a tool that already exists.
    tools.register({
      name: "shout",
      description: "builtin shout",
      parameters: { type: "object", properties: {} },
      async handler() {
        return "builtin";
      },
    });
    await manager.reload();
    const collision = manager.diagnostics().find((entry) => entry.status === "skipped" && /conflicts/.test(entry.reason));
    assert.ok(collision, "name collision must be reported");
    assert.equal(collision.name, "shout");
    const survivor = await tools.invoke("shout", "{}", { sessionId: "cli:smoke", log });
    assert.equal(survivor.output, "builtin", "the built-in tool must keep its name");
    check("plugin cannot override a built-in tool by default");

    // Mutating actions wait for an operator decision.
    const approvals = new ApprovalQueue();
    tools.register(createExtensionsTool(manager, { approvals, writes: "confirm" }));
    const queued = await tools.invoke(
      "extensions",
      JSON.stringify({ action: "install", name: "note-skill" }),
      { sessionId: "cli:smoke", log },
    );
    assert.equal(queued.ok, true, queued.output);
    assert.match(queued.output, /Approval required/);
    assert.equal(approvals.list().length, 1);
    const request = approvals.list()[0];
    assert.equal(request.action, "install");
    assert.equal(request.name, "note-skill");
    const approved = approvals.approve(request.id);
    assert.ok(approved, "approving a pending request must resolve it");
    const applied = await manager.applyApproved(approved);
    assert.match(applied, /note-skill/);
    assert.equal(approvals.list().length, 0);
    check("extension install is queued until the operator approves");

    // Chat surfaces share that queue: short ids, a list, a rejection.
    const service = new ApprovalService(approvals, () => manager);
    const sent = [];
    const relay = new ApprovalRelay(approvals, service, log);
    relay.addSender("test-chat", async (text) => {
      sent.push(text);
    });
    relay.start();
    assert.deepEqual(parseApprovalCommand("/approvals"), { kind: "list" });
    assert.equal(parseApprovalCommand("approve the plan"), null, "a sentence is not a command");
    const chatQueued = await tools.invoke(
      "extensions",
      JSON.stringify({ action: "install", name: "shout-plugin" }),
      { sessionId: "line:Uchat", log },
    );
    assert.match(chatQueued.output, /Approval required/);
    await relay.idle();
    assert.equal(sent.length, 1, "the chat is told once about a new request");
    assert.match(sent[0], /shout-plugin/);
    assert.equal(approvals.list().length, 1);
    assert.match(service.formatList(), /shout-plugin/);
    const shortId = approvals.list()[0].id.slice(0, 8);
    assert.deepEqual(parseApprovalCommand(`reject ${shortId}`), { kind: "reject", id: shortId });
    const chatRejected = service.reject(shortId);
    assert.equal(chatRejected.ok, true, chatRejected.message);
    assert.equal(service.list().length, 0);
    await relay.idle();
    assert.equal(sent.length, 1, "a resolved request is not announced again");
    check("chat approvals: notified once, listed, rejected by short id");

    tools.register(createExtensionsTool(manager, { approvals, writes: "deny" }));
    const blocked = await tools.invoke("extensions", JSON.stringify({ action: "reload" }), {
      sessionId: "cli:smoke",
      log,
    });
    assert.match(blocked.output, /blocks agent-driven/);
    check("EXTENSIONS_AGENT_WRITES=deny blocks every mutating action");
  } finally {
    await manager.close();
    await rm(base, { recursive: true, force: true });
  }

  console.log("\nsmoke:extensions: all checks passed");
}

main().catch((error) => {
  console.error("smoke:extensions failed:", error);
  process.exit(1);
});
