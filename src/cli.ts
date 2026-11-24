#!/usr/bin/env node
import path from "node:path";
import process from "node:process";
import { createInterface } from "node:readline/promises";
import { AgentHarness } from "./agent.js";
import { AgentRegistry } from "./agents.js";
import { LineChannel } from "./channels/line.js";
import { TelegramChannel } from "./channels/telegram.js";
import { loadConfig, loadDotEnv } from "./config.js";
import { ApprovalQueue } from "./extensions/approvals.js";
import { ApprovalRelay } from "./extensions/approval-relay.js";
import { ApprovalService } from "./extensions/approval-service.js";
import { ExtensionManager } from "./extensions/index.js";
import { HubClient, describeEntry } from "./extensions/hub.js";
import { createGateway } from "./gateway/server.js";
import { createLogger } from "./log.js";
import { ModelCatalog } from "./models.js";
import { SessionStore } from "./store.js";
import { createToolRegistry } from "./tools/index.js";
import { createExtensionsTool } from "./tools/extensions.js";
import type { AgentEvent } from "./types.js";
import type { UsageSummary } from "./usage.js";
import { UsageLedger, describeCost, formatMoney, formatTokens, tokenCounts } from "./usage.js";

const log = createLogger("cli");

loadDotEnv();

async function bootstrap(options: { extensions?: boolean } = {}) {
  const config = loadConfig();
  const catalog = new ModelCatalog(config.providers, config.defaultModel);
  const store = new SessionStore(config.dataDir);
  await store.init();
  const tools = createToolRegistry(config);
  const agents = new AgentRegistry(config.dataDir);
  await agents.list();
  const ledger = new UsageLedger(config.dataDir, config.prices);
  await ledger.init();

  const approvals = new ApprovalQueue();
  let extensions: ExtensionManager | null = null;
  if (options.extensions) {
    extensions = new ExtensionManager(config, createLogger("extensions"));
    await extensions.init();
    extensions.register(tools);
    tools.register(
      createExtensionsTool(extensions, {
        approvals,
        writes: config.agentExtensionWrites,
      }),
    );
  }

  const harness = new AgentHarness({
    config,
    store,
    catalog,
    tools,
    ledger,
    log: createLogger("agent"),
    extensions: extensions ?? undefined,
  });
  return { config, catalog, store, tools, ledger, extensions, harness, agents, approvals };
}

function printModels(catalog: ModelCatalog): void {
  const models = catalog.list();
  if (models.length === 0) {
    console.log("No models configured. Add a provider key to .env (see .env.example).");
    return;
  }
  const fallback = catalog.defaultRef();
  for (const model of models) {
    const marker = model.ref === fallback ? "*" : " ";
    console.log(`${marker} ${model.ref.padEnd(44)} ${model.providerLabel}`);
  }
  console.log("\n* = default model for new sessions");
}

function pad(value: string, width: number): string {
  return value.padEnd(width);
}

function padLeft(value: string, width: number): string {
  return value.padStart(width);
}

function costCell(costUsd: number, unpricedTurns: number): string {
  const base = formatMoney(costUsd);
  return unpricedTurns > 0 ? `${base} +${unpricedTurns}n/a` : base;
}

async function runUsage(): Promise<void> {
  const { ledger, config } = await bootstrap();
  const summary: UsageSummary = ledger.summary();

  if (summary.total.turns === 0) {
    console.log("No usage recorded yet. Run `clawgate gateway` or `clawgate chat` first.");
    return;
  }

  const width = Math.min(
    52,
    Math.max(20, ...summary.models.map((model) => model.model.length), "model".length),
  );
  console.log(
    `${pad("model", width)} ${padLeft("turns", 5)} ${padLeft("in", 12)} ${padLeft("out", 12)} ${padLeft("est. cost", 16)}`,
  );
  for (const model of summary.models) {
    console.log(
      `${pad(model.model, width)} ${padLeft(String(model.turns), 5)} ${padLeft(formatTokens(model.promptTokens), 12)} ${padLeft(formatTokens(model.completionTokens), 12)} ${padLeft(costCell(model.costUsd, model.unpricedTurns), 16)}`,
    );
  }

  console.log("");
  const providerWidth =
    Math.min(24, Math.max(8, ...summary.providers.map((provider) => provider.providerLabel.length), "provider".length));
  console.log(
    `${pad("provider", providerWidth)} ${padLeft("models", 6)} ${padLeft("turns", 5)} ${padLeft("in", 12)} ${padLeft("out", 12)} ${padLeft("est. cost", 16)}`,
  );
  for (const provider of summary.providers) {
    console.log(
      `${pad(provider.providerLabel, providerWidth)} ${padLeft(String(provider.models), 6)} ${padLeft(String(provider.turns), 5)} ${padLeft(formatTokens(provider.promptTokens), 12)} ${padLeft(formatTokens(provider.completionTokens), 12)} ${padLeft(costCell(provider.costUsd, provider.unpricedTurns), 16)}`,
    );
  }

  console.log("");
  console.log(
    `total: ${formatTokens(summary.total.totalTokens)} tokens over ${summary.total.turns} turn(s), est. ${formatMoney(summary.total.costUsd)}`,
  );
  if (!summary.pricingConfigured) {
    console.log("no prices set - add MODEL_PRICES to .env to get cost estimates (USD per 1M tokens)");
  } else if (summary.total.unpricedTurns > 0) {
    console.log(`${summary.total.unpricedTurns} turn(s) had no price configured for their model (shown as n/a)`);
  }
  console.log(`usage log: ${path.join(config.dataDir, "usage.jsonl")}`);
}

async function runGateway(): Promise<void> {
  const { config, catalog, tools, harness, extensions, agents, approvals } = await bootstrap({ extensions: true });

  if (catalog.isEmpty) {
    log.warn("no model providers configured - set OPENAI_API_KEY, OPENROUTER_API_KEY, OLLAMA_ENABLED=1 or LLM_BASE_URL");
  } else {
    log.info(`models: ${catalog.list().map((model) => model.ref).join(", ")}`);
  }
  log.info(`tools: ${tools.names().join(", ") || "none"}`);

  // One service decides approvals from every surface: board, Telegram and LINE.
  const approvalsService = new ApprovalService(approvals, () => harness.extensions ?? null);
  const relay = new ApprovalRelay(approvals, approvalsService, createLogger("approvals"));

  const line = config.line
    ? new LineChannel(config.line, harness, createLogger("line"), agents, { approvals: approvalsService })
    : null;
  const gateway = createGateway({
    config,
    harness,
    log: createLogger("gateway"),
    agents,
    approvals,
    approvalService: approvalsService,
    line: line ?? undefined,
  });
  const port = await gateway.start();

  console.log("");
  console.log(`  clawgate gateway listening on http://${config.host}:${port}`);
  console.log(`  board:  http://localhost:${port}/?token=${encodeURIComponent(config.gatewayToken)}`);
  console.log(`  socket: ws://localhost:${port}/ws`);
  if (config.line) {
    console.log(`  line:   POST ${config.line.webhookPath} (signature-checked webhook; expose it through a tunnel, not the phone itself)`);
  }
  console.log("");

  let telegram: TelegramChannel | null = null;
  if (config.telegram) {
    telegram = new TelegramChannel(config.telegram, harness, createLogger("telegram"), {
      approvals: approvalsService,
    });
    telegram.start();
    const bot = telegram;
    for (const chatId of config.telegram.allowedChatIds) {
      relay.addSender(`telegram:${chatId}`, (text) => bot.sendText(chatId, text));
    }
  } else {
    log.warn("telegram disabled - set TELEGRAM_BOT_TOKEN and TELEGRAM_ALLOWED_CHAT_IDS");
  }

  if (line && config.line) {
    const channel = line;
    for (const sourceId of config.line.allowedSourceIds) {
      relay.addSender(`line:${sourceId}`, (text) => channel.pushText(sourceId, text));
    }
    log.info(
      `line channel ready at ${config.line.webhookPath} (allowed sources: ${config.line.allowedSourceIds.join(", ") || "none - set LINE_ALLOWED_SOURCE_IDS"})`,
    );
  } else {
    log.warn("line disabled - set LINE_CHANNEL_SECRET and LINE_CHANNEL_ACCESS_TOKEN");
  }

  relay.start();
  const notified = relay;
  if (config.telegram || config.line) {
    log.info("approval requests are pushed to Telegram and LINE allowed chats");
  }

  const shutdown = async (signal: string) => {
    log.info(`${signal} received, shutting down`);
    notified.stop();
    await telegram?.stop();
    await gateway.stop();
    await extensions?.close();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

async function runChat(): Promise<void> {
  const { catalog, harness, extensions } = await bootstrap({ extensions: true });
  if (catalog.isEmpty) {
    console.error("No model providers configured. Add one to .env first.");
    process.exit(1);
  }

  const sessionId = "cli:main";
  const session = await harness.store.getOrCreate(sessionId, "cli", catalog.defaultRef() ?? "");
  console.log(`clawgate chat - session ${sessionId}, model ${session.model}`);
  console.log("commands: /model <ref>, /models, /reset, /exit\n");

  const rl = createInterface({ input: process.stdin, output: process.stdout });

  const printEvent = (event: AgentEvent) => {
    if (event.type === "tool.start") {
      const args = JSON.stringify(event.args);
      console.log(`\n  ⚙ ${event.name} ${args.length > 200 ? `${args.slice(0, 200)}…` : args}`);
    }
    if (event.type === "tool.result") {
      console.log(`  ${event.ok ? "✓" : "✗"} ${event.name}: ${event.preview.split("\n")[0]}`);
    }
  };

  while (true) {
    let line: string;
    try {
      line = (await rl.question("you › ")).trim();
    } catch {
      break;
    }
    if (!line) continue;
    if (line === "/exit" || line === "/quit") break;
    if (line === "/models") {
      printModels(catalog);
      continue;
    }
    if (line.startsWith("/model")) {
      const ref = line.slice("/model".length).trim();
      if (!ref) {
        console.log(`model: ${(await harness.store.get(sessionId))?.model}`);
      } else {
        const updated = await harness.setModel(sessionId, "cli", ref);
        console.log(`model set to ${updated.model}`);
      }
      continue;
    }
    if (line === "/reset") {
      await harness.reset(sessionId);
      console.log("conversation cleared");
      continue;
    }

    try {
      const result = await harness.run(sessionId, "cli", line, printEvent);
      console.log(`\nagent › ${result.text || "(no reply)"}`);
      const counts = tokenCounts(result.usage);
      if (counts.known) {
        console.log(
          `  tokens ${counts.prompt} in / ${counts.completion} out · ${describeCost(result.costUsd)}`,
        );
      }
      console.log("");
    } catch (error) {
      console.log(`\nerror: ${(error as Error).message}\n`);
    }
  }

  rl.close();
  await extensions?.close();
}

async function runExtensions(args: string[]): Promise<void> {
  const config = loadConfig();
  const hub = new HubClient(config.clawhubUrl, config.extensionsDir, createLogger("extensions"));
  const [action = "list"] = args;

  switch (action) {
    case "list": {
      const installed = await hub.installed();
      console.log(`extensions dir: ${config.extensionsDir}`);
      console.log(`registry: ${hub.registryUrl ?? "not configured (set CLAWHUB_URL)"}`);
      if (installed.length === 0) {
        console.log("nothing installed");
        return;
      }
      for (const entry of installed) {
        const version = entry.version ? ` v${entry.version}` : "";
        const description = entry.description ? ` - ${entry.description}` : "";
        console.log(`${entry.kind.padEnd(6)} ${entry.name}${version}${description}`);
      }
      return;
    }
    case "diagnostics": {
      const manager = new ExtensionManager(config, createLogger("extensions"));
      try {
        await manager.init();
        console.log(`extensions dir: ${config.extensionsDir}`);
        console.log(manager.formatDiagnostics());
      } finally {
        await manager.close();
      }
      return;
    }
    case "search": {
      const query = args.slice(1).join(" ");
      const entries = await hub.search(query);
      if (entries.length === 0) {
        console.log(`no registry entries matched "${query}"`);
        return;
      }
      for (const entry of entries) console.log(describeEntry(entry));
      return;
    }
    case "install": {
      const name = args[1]?.trim();
      if (!name) {
        console.error("usage: clawgate extensions install <name>");
        process.exit(1);
      }
      const installed = await hub.installByName(name);
      console.log(`installed ${installed.kind} "${installed.name}" into ${config.extensionsDir}`);
      console.log("restart the gateway, or ask the agent to run extensions action=reload");
      return;
    }
    case "remove": {
      const name = args[1]?.trim();
      if (!name) {
        console.error("usage: clawgate extensions remove <name>");
        process.exit(1);
      }
      const kind = await hub.remove(name);
      console.log(`removed ${kind} "${name}"`);
      return;
    }
    default:
      console.log(`unknown extensions action "${action}"

usage:
  clawgate extensions            list installed skills, plugins and MCP servers
  clawgate extensions search Q   search the clawhub registry
  clawgate extensions diagnostics  why each plugin/skill is loaded, skipped or failed
  clawgate extensions install N  install one (skill, plugin or mcp)
  clawgate extensions remove N   remove one`);
      process.exit(1);
  }
}

function printHelp(): void {
  console.log(`clawgate - agent harness

usage:
  clawgate gateway     start the board + websocket gateway (+ telegram if configured)
  clawgate chat        terminal chat with the agent
  clawgate models      list configured models
  clawgate usage       token usage and estimated cost per model and per provider
  clawgate extensions  list/search/install/remove skills, plugins and MCP servers

environment: see .env.example (GATEWAY_TOKEN is required)`);
}

async function main(): Promise<void> {
  const command = (process.argv[2] ?? "gateway").toLowerCase();
  switch (command) {
    case "gateway":
    case "serve":
      await runGateway();
      return;
    case "chat":
      await runChat();
      return;
    case "models":
      printModels((await bootstrap()).catalog);
      return;
    case "usage":
      await runUsage();
      return;
    case "extensions":
    case "ext":
      await runExtensions(process.argv.slice(3));
      return;
    case "help":
    case "--help":
    case "-h":
      printHelp();
      return;
    default:
      printHelp();
      process.exit(1);
  }
}

main().catch((error) => {
  console.error(`fatal: ${(error as Error).message}`);
  process.exit(1);
});
