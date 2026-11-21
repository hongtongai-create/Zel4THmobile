import type { Config } from "./config.js";
import type { ExtensionManager } from "./extensions/index.js";
import type { Logger } from "./log.js";
import type { ModelCatalog, ResolvedModel } from "./models.js";
import { chatCompletion } from "./models.js";
import type { SessionStore } from "./store.js";
import type { ToolRegistry } from "./tools/index.js";
import type { UsageEntry, UsageLedger } from "./usage.js";
import { costOf, describeCost, formatMoney, mergeUsage, tokenCounts } from "./usage.js";
import type {
  AgentEvent,
  ChatMessage,
  EventListener,
  Session,
  SessionChannel,
  Usage,
} from "./types.js";

const SYSTEM_RULES = `You are a personal assistant agent reachable from chat channels (Telegram and a web control board) and you run as a long-lived gateway process.

Operating rules:
- Do all actions yourself with your tools. Never claim you did something you did not do.
- If a request needs a capability you do not have (a tool is missing), say which capability is missing instead of pretending.
- Keep replies short and chat-friendly: no markdown tables, no long headings. Use plain text with short lines.
- Match the language the user writes in (Thai or English).
- When you call a tool, base your answer on the tool's actual result. If it failed, report the error plainly.
- Never reveal API keys, tokens or internal configuration.`;

export type AgentDeps = {
  config: Config;
  store: SessionStore;
  catalog: ModelCatalog;
  tools: ToolRegistry;
  log: Logger;
  ledger?: UsageLedger;
  extensions?: ExtensionManager;
};

export type RunResult = {
  text: string;
  session: Session;
  usage: Usage | null;
  /** Estimated USD cost for the turn; null when no price is configured. */
  costUsd: number | null;
};

export class AgentHarness {
  private readonly deps: AgentDeps;

  constructor(deps: AgentDeps) {
    this.deps = deps;
  }

  get catalog(): ModelCatalog {
    return this.deps.catalog;
  }

  get tools(): ToolRegistry {
    return this.deps.tools;
  }

  get store(): SessionStore {
    return this.deps.store;
  }

  get extensions(): ExtensionManager | null {
    return this.deps.extensions ?? null;
  }

  private systemPrompt(model: string): string {
    const { config, tools } = this.deps;
    const lines = [SYSTEM_RULES, "", `Current model: ${model}`];

    const capabilities: string[] = ["Chat via Telegram and the web board."];
    if (config.facebook) {
      capabilities.push(
        `Publish posts to the Facebook Page ${config.facebook.pageName ?? config.facebook.pageId} yourself, without asking the user to do it manually.`,
      );
    }
    lines.push("", "Your capabilities:", ...capabilities.map((line) => `- ${line}`));

    const toolList = tools.describe();
    if (toolList) lines.push("", "Available tools:", toolList);

    const extensions = this.deps.extensions;
    if (extensions) {
      if (extensions.skillList.length > 0 || extensions.pluginList.length > 0) {
        capabilities.push(
          "Use your installed skills and plugins (listed below) when a request matches them.",
        );
      }
      capabilities.push(
        "Grow your own capabilities: the extensions tool can search a clawhub registry and install skills, plugins or MCP servers.",
      );
      const sections = extensions.promptSections();
      if (sections.length > 0) lines.push("", ...sections);
    }

    return lines.join("\n");
  }

  /** Keep the system message plus a recent, tool-call-safe window of history. */
  private trim(messages: ChatMessage[], limit: number): ChatMessage[] {
    if (messages.length <= limit) return messages;
    const system = messages[0]?.role === "system" ? messages[0] : null;
    const rest = system ? messages.slice(1) : messages;
    const target = limit - (system ? 1 : 0);
    let start = rest.length - target;
    if (start < 0) start = 0;
    // Never begin the window on a tool result: it needs its assistant tool_calls.
    while (start < rest.length && rest[start].role === "tool") start += 1;
    return system ? [system, ...rest.slice(start)] : rest.slice(start);
  }

  async run(
    sessionId: string,
    channel: SessionChannel,
    text: string,
    emit: EventListener = () => {},
  ): Promise<RunResult> {
    const { config, store, catalog, tools, log } = this.deps;
    const defaultModel = catalog.defaultRef();
    if (!defaultModel) {
      throw new Error(
        "No model provider is configured. Set OPENAI_API_KEY, OPENROUTER_API_KEY, OLLAMA_ENABLED=1 or LLM_BASE_URL in .env",
      );
    }

    const session = await store.getOrCreate(sessionId, channel, defaultModel);
    const modelRef = session.model || defaultModel;
    const model = catalog.resolve(modelRef);

    const prompt = this.systemPrompt(modelRef);
    if (session.messages.length === 0) {
      session.messages.push({ role: "system", content: prompt });
      session.title = text.slice(0, 60).replace(/\s+/g, " ").trim() || null;
    } else if (session.messages[0]?.role === "system" && session.messages[0].content !== prompt) {
      // Skills, plugins and MCP tools can change mid-session; keep the prompt current.
      session.messages[0] = { role: "system", content: prompt };
    }
    session.messages.push({ role: "user", content: text });
    session.updatedAt = new Date().toISOString();

    emit({ type: "turn.start", sessionId, model: modelRef });

    let iterations = 0;
    let usage: Usage | null = null;
    let finalText = "";

    try {
      for (let step = 0; step < config.maxIterations; step += 1) {
        iterations += 1;
        const response = await chatCompletion({
          model,
          messages: this.trim(session.messages, config.historyLimit),
          tools: tools.definitions(),
        });
        usage = mergeUsage(usage, response.usage);

        const assistant = response.message;
        session.messages.push(assistant);

        if (assistant.content && assistant.content.trim()) {
          finalText = assistant.content.trim();
          emit({ type: "assistant.message", sessionId, text: finalText });
        }

        const calls = assistant.tool_calls ?? [];
        if (calls.length === 0) break;

        for (const call of calls) {
          let parsedArgs: unknown = call.function.arguments;
          try {
            parsedArgs = JSON.parse(call.function.arguments);
          } catch {
            // Keep the raw string for display.
          }
          emit({
            type: "tool.start",
            sessionId,
            callId: call.id,
            name: call.function.name,
            args: parsedArgs,
          });

          const outcome = await tools.invoke(call.function.name, call.function.arguments, {
            sessionId,
            log,
          });

          emit({
            type: "tool.result",
            sessionId,
            callId: call.id,
            name: call.function.name,
            ok: outcome.ok,
            preview: outcome.output.slice(0, 800),
          });
          log.info(`tool ${call.function.name} ${outcome.ok ? "ok" : "failed"}`);

          session.messages.push({
            role: "tool",
            tool_call_id: call.id,
            name: call.function.name,
            content: outcome.output,
          });
        }

        session.updatedAt = new Date().toISOString();
        await store.save(session);
      }

      session.updatedAt = new Date().toISOString();
      await store.save(session);
      const costUsd = await this.recordTurnUsage(sessionId, channel, model, iterations, usage);
      emit({ type: "turn.end", sessionId, iterations, usage, costUsd });
      return { text: finalText, session, usage, costUsd };
    } catch (error) {
      const message = (error as Error).message;
      log.error(`turn failed for ${sessionId}: ${message}`);
      emit({ type: "error", sessionId, message });
      emit({ type: "turn.end", sessionId, iterations, usage, costUsd: null });
      await store.save(session).catch(() => undefined);
      throw error;
    }
  }

  /**
   * Appends one usage line per turn and logs tokens + estimated spend, both for
   * the turn and cumulatively for the provider. Never fails the turn itself.
   */
  private async recordTurnUsage(
    sessionId: string,
    channel: SessionChannel,
    model: ResolvedModel,
    iterations: number,
    usage: Usage | null,
  ): Promise<number | null> {
    const { ledger, log } = this.deps;
    if (!ledger) return null;

    const counts = tokenCounts(usage);
    const costUsd = counts.known
      ? costOf(ledger.priceFor(model.ref, model.providerId), counts.prompt, counts.completion)
      : null;
    const entry: UsageEntry = {
      at: new Date().toISOString(),
      sessionId,
      channel,
      model: model.ref,
      providerId: model.providerId,
      providerLabel: model.providerLabel,
      iterations,
      promptTokens: counts.prompt,
      completionTokens: counts.completion,
      totalTokens: counts.total,
      costUsd,
    };

    try {
      const rollup = await ledger.record(entry);
      const providerSpent =
        rollup.provider.unpricedTurns > 0
          ? `${formatMoney(rollup.provider.costUsd)}+${rollup.provider.unpricedTurns} unpriced`
          : formatMoney(rollup.provider.costUsd);
      log.info(
        `turn usage ${model.ref} provider=${model.providerLabel} prompt=${counts.prompt} completion=${counts.completion} total=${counts.total}` +
          `${counts.known ? "" : " (tokens unknown)"} ${describeCost(costUsd)}` +
          ` provider_spent=${providerSpent} provider_turns=${rollup.provider.turns}` +
          ` all_spent=${formatMoney(rollup.total.costUsd)}`,
      );
    } catch (error) {
      log.warn(`could not record usage for ${sessionId}: ${(error as Error).message}`);
    }

    return costUsd;
  }

  async setModel(sessionId: string, channel: SessionChannel, modelRef: string): Promise<Session> {
    const model = this.deps.catalog.resolve(modelRef);
    const session = await this.deps.store.getOrCreate(
      sessionId,
      channel,
      this.deps.catalog.defaultRef() ?? model.ref,
    );
    session.model = model.ref;
    session.updatedAt = new Date().toISOString();
    if (session.messages[0]?.role === "system") {
      session.messages[0] = { role: "system", content: this.systemPrompt(model.ref) };
    }
    await this.deps.store.save(session);
    return session;
  }

  async reset(sessionId: string): Promise<void> {
    await this.deps.store.reset(sessionId);
  }
}
