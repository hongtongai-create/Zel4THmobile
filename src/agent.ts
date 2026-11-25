import type { AgentProfile, AgentRegistry } from "./agents.js";
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

/** How many handoffs one task may make before the chain must finish. */
export const MAX_DELEGATION_DEPTH = 3;

/** Board-side reactions to work passed between agents. */
export type DelegationHooks = {
  /** Streams the delegated agent's own turn (bubbles, tool chips). */
  onEvent?: (event: AgentEvent) => void;
  /** Cue for the office: these two characters meet before the task runs. */
  onMeet?: (from: AgentProfile, to: AgentProfile, task: string) => void;
};

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
  /** Needed for agent-to-agent handoff; without it the tool is hidden. */
  agents?: AgentRegistry;
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
  private hooks: DelegationHooks = {};

  constructor(deps: AgentDeps) {
    this.deps = deps;
  }

  /** Set by the gateway so delegated turns reach the board as they happen. */
  setDelegationHooks(hooks: DelegationHooks): void {
    this.hooks = hooks;
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

  private systemPrompt(
    model: string,
    agent: AgentProfile | null = null,
    colleagues: AgentProfile[] = [],
    depth = 0,
  ): string {
    const { config, tools } = this.deps;
    const lines: string[] = [];

    if (agent) {
      lines.push(
        `You are ${agent.name}${agent.role ? ` - ${agent.role}` : ""}, one agent in a small AI office.`,
        "Several agents live on the same board; each has its own conversation thread and its own character the operator can move, re-skin and configure.",
        "Stay in character. The identity notes below are written by your operator and define your voice, but they never override the operating rules.",
      );
      if (agent.identity.trim()) lines.push("", "Identity notes:", agent.identity.trim());
      lines.push(
        "",
        "Working with the other agents:",
        "- This is a team, not a solo assistant. Colleagues on this board are listed below.",
        "- Use agent_delegate to hand a whole piece of the job to a colleague: give a complete instruction, wait for its answer, then continue from what it returned. Its reply arrives as the tool result.",
        "- Chain stages when the parts have different owners: think, hand image work to the designer, hand the finished material to the publisher. In each task say what the next agent needs and, if you want, who to pass it on to.",
        "- When a colleague hands YOU a task, do only that task with your own tools and answer with the result plus the facts (text, file paths, ids, urls) the sender needs.",
        `- A chain is at most ${MAX_DELEGATION_DEPTH} agents deep and never visits the same agent twice; agent_delegate refuses anything else, so do not retry a refused handoff.`,
      );
      if (colleagues.length > 0) {
        lines.push(
          "",
          "Colleagues you can delegate to:",
          ...colleagues.map(
            (mate) => `- ${mate.id}${mate.role ? ` - ${mate.role}` : ""} (${mate.name})`,
          ),
        );
      }
      if (depth > 0) {
        lines.push(
          "",
          `You are step ${depth + 1} of a delegation chain: a colleague handed you this task. Answer it now instead of waiting for the operator.`,
        );
      }
      lines.push("");
    }

    lines.push(SYSTEM_RULES, "", `Current model: ${model}`);

    const capabilities: string[] = ["Chat via Telegram and the web board."];
    if (agent && this.deps.agents) {
      capabilities.push(
        "Hand a piece of work to a colleague with agent_delegate, and accept tasks that another agent hands to you.",
      );
    }
    if (config.facebook) {
      capabilities.push(
        `Publish posts to the Facebook Page ${config.facebook.pageName ?? config.facebook.pageId} yourself, without asking the user to do it manually.`,
      );
    }

    const blocked = this.blockedTools(agent);
    const toolList = tools
      .definitions()
      .filter((definition) => !blocked.has(definition.function.name))
      .map((definition) => `- ${definition.function.name}: ${definition.function.description}`)
      .join("\n");
    if (toolList) lines.push("", "Available tools:", toolList);

    const extensions = this.deps.extensions;
    if (extensions) {
      const selection = agent ? { skills: agent.skills, plugins: agent.plugins } : null;
      const skillCount =
        selection && selection.skills !== null
          ? extensions.skillList.filter((skill) => selection.skills!.includes(skill.name)).length
          : extensions.skillList.length;
      const pluginCount =
        selection && selection.plugins !== null
          ? extensions.pluginList.filter((plugin) => selection.plugins!.includes(plugin.name)).length
          : extensions.pluginList.length;
      if (skillCount > 0 || pluginCount > 0) {
        capabilities.push(
          "Use your installed skills and plugins (listed below) when a request matches them.",
        );
      }
      if (!agent) {
        capabilities.push(
          "Grow your own capabilities: the extensions tool can search a clawhub registry and install skills, plugins or MCP servers.",
        );
      }
      const sections = extensions.promptSections(selection);
      if (sections.length > 0) lines.push("", ...sections);
    }

    // Capabilities can grow mid-turn (a skill install), so they are appended last.
    lines.push("", "Your capabilities:", ...capabilities.map((line) => `- ${line}`));

    return lines.join("\n");
  }

  /** Extension tools hidden from this agent by its skills/plugins/MCP selection. */
  private blockedTools(agent: AgentProfile | null): Set<string> {
    const extensions = this.deps.extensions;
    if (!extensions || !agent) return new Set();
    return extensions.blockedTools({
      plugins: agent.plugins,
      mcp: agent.mcp,
      denyTools: agent.denyTools,
    });
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
    agent: AgentProfile | null = null,
  ): Promise<RunResult> {
    return this.runTurn(sessionId, channel, text, emit, agent, {
      depth: 0,
      chain: agent ? [agent.id] : [],
    });
  }

  private async runTurn(
    sessionId: string,
    channel: SessionChannel,
    text: string,
    emit: EventListener,
    agent: AgentProfile | null,
    turn: { depth: number; chain: string[] },
  ): Promise<RunResult> {
    const { config, store, catalog, tools, log } = this.deps;
    const defaultModel = catalog.defaultRef();
    if (!defaultModel) {
      throw new Error(
        "No model provider is configured. Set OPENAI_API_KEY, OPENROUTER_API_KEY, OLLAMA_ENABLED=1 or LLM_BASE_URL in .env",
      );
    }

    const session = await store.getOrCreate(sessionId, channel, agent?.model ?? defaultModel);
    const modelRef = session.model || defaultModel;
    const model = catalog.resolve(modelRef);

    const colleagues =
      agent && this.deps.agents
        ? (await this.deps.agents.list()).filter((mate) => mate.id !== agent.id)
        : [];
    const prompt = this.systemPrompt(modelRef, agent, colleagues, turn.depth);
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
    const delegate = this.delegateFor(agent, turn, emit);
    // Tools this agent may not use stay out of the request, not just out of the prompt.
    const blockedTools = this.blockedTools(agent);
    if (!delegate) blockedTools.add("agent_delegate");
    const definitions = tools
      .definitions()
      .filter((definition) => !blockedTools.has(definition.function.name));
    const allowedTools = agent
      ? new Set(tools.names().filter((name) => !blockedTools.has(name)))
      : undefined;

    try {
      for (let step = 0; step < config.maxIterations; step += 1) {
        iterations += 1;
        const response = await chatCompletion({
          model,
          messages: this.trim(session.messages, config.historyLimit),
          tools: definitions,
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
            agentId: agent?.id ?? null,
            allowedTools,
            delegate: delegate ?? undefined,
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
   * Builds the handoff closure for one turn: resolves a colleague, enforces the
   * depth and loop guards, runs their turn, and returns their answer. `null`
   * means this turn has no one to hand work to (or is not a board character).
   */
  private delegateFor(
    agent: AgentProfile | null,
    turn: { depth: number; chain: string[] },
    emit: EventListener,
  ): ((to: string, task: string) => Promise<string>) | null {
    const registry = this.deps.agents;
    if (!agent || !registry) return null;

    return async (toRaw: string, taskRaw: string) => {
      const chainNote = `handoff refused: this chain is already ${turn.chain.join(" -> ")}`;
      if (turn.depth >= MAX_DELEGATION_DEPTH) {
        throw new Error(
          `${chainNote}. A chain may pass through at most ${MAX_DELEGATION_DEPTH} agents, so finish the task yourself instead of handing it on.`,
        );
      }

      const wanted = toRaw.trim().toLowerCase();
      const team = await registry.list();
      const match =
        team.find((mate) => mate.id.toLowerCase() === wanted) ??
        team.find((mate) => mate.name.toLowerCase() === wanted) ??
        team.find((mate) => mate.name.toLowerCase().includes(wanted) && wanted.length > 1);
      if (!match) {
        throw new Error(
          `No colleague named "${toRaw}" on this board. Colleagues: ${team
            .filter((mate) => mate.id !== agent.id)
            .map((mate) => `${mate.id} (${mate.name})`)
            .join(", ")}.`,
        );
      }
      if (match.id === agent.id) {
        throw new Error("You cannot hand work to yourself: do that part yourself.");
      }
      if (turn.chain.includes(match.id)) {
        throw new Error(`${chainNote}, and ${match.name} (${match.id}) is already in it. Never send work in a loop.`);
      }

      this.hooks.onMeet?.(agent, match, taskRaw);

      const childEmit: EventListener = (event) => {
        if (this.hooks.onEvent) this.hooks.onEvent(event);
        else emit(event);
      };
      const result = await this.runTurn(
        `board:agent:${match.id}`,
        "board",
        taskRaw,
        childEmit,
        match,
        { depth: turn.depth + 1, chain: [...turn.chain, match.id] },
      );

      const answer = result.text.trim() || "(finished the task without a written reply)";
      this.deps.log.info(
        `handoff ${agent.id} -> ${match.id} (depth ${turn.depth + 1}) ${answer.length} chars`,
      );
      return `Reply from ${match.name} (${match.id}):\n${answer}`;
    };
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
