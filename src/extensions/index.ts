import path from "node:path";
import type { Config } from "../config.js";
import type { Logger } from "../log.js";
import type { Tool, ToolRegistry } from "../tools/index.js";
import type { ApprovalAction } from "./approvals.js";
import { HubClient, describeEntry } from "./hub.js";
import { loadMcpConfig, startMcpServers, type McpRuntime } from "./mcp.js";
import { loadPlugins } from "./plugins.js";
import { loadSkills } from "./skills.js";
import type { ExtensionDiagnostic, InstalledEntry, LoadedPlugin, Skill } from "./types.js";

export type ExtensionSummary = {
  skills: string[];
  plugins: string[];
  mcp: string[];
  registry: string | null;
  /** Tool names each plugin contributes, so the board can offer per-tool rules. */
  pluginTools: Record<string, string[]>;
};

/**
 * Owns everything the agent can grow into: markdown skills, JS plugins and
 * MCP servers. `reload()` re-reads them from disk, so an install takes effect
 * without restarting the gateway.
 */
export class ExtensionManager {
  private skills: Skill[] = [];
  private plugins: LoadedPlugin[] = [];
  private mcp: McpRuntime[] = [];
  private owned = new Set<string>();
  /** Tool instances we registered, so we never unregister someone else's tool. */
  private registered = new Map<string, Tool>();
  private registry: ToolRegistry | null = null;
  private pluginDiagnostics: ExtensionDiagnostic[] = [];
  private toolDiagnostics: ExtensionDiagnostic[] = [];
  private readonly allowOverride: boolean;

  readonly hub: HubClient;
  readonly dir: string;

  constructor(
    config: Config,
    private readonly log: Logger,
  ) {
    this.dir = config.extensionsDir;
    this.hub = new HubClient(config.clawhubUrl, config.extensionsDir, log);
    this.allowOverride = config.allowToolOverride;
  }

  get skillList(): Skill[] {
    return this.skills;
  }

  get pluginList(): LoadedPlugin[] {
    return this.plugins;
  }

  async init(): Promise<void> {
    this.skills = await loadSkills(path.join(this.dir, "skills"));
    const loaded = await loadPlugins(path.join(this.dir, "plugins"), this.log);
    this.plugins = loaded.plugins;
    this.pluginDiagnostics = loaded.diagnostics;
    this.toolDiagnostics = [];

    const servers = await loadMcpConfig(path.join(this.dir, "mcp.json"));
    this.mcp = await startMcpServers(servers, this.log);

    this.log.info(
      `extensions: ${this.skills.length} skill(s), ${this.plugins.length} plugin(s), ${this.mcp.length} mcp server(s)`,
    );
  }

  summary(): ExtensionSummary {
    return {
      skills: this.skills.map((skill) => skill.name),
      plugins: this.plugins.map((plugin) => plugin.name),
      mcp: this.mcp.map((runtime) => runtime.name),
      registry: this.hub.registryUrl,
      pluginTools: Object.fromEntries(
        this.plugins.map((plugin) => [plugin.name, plugin.tools.map((tool) => tool.name)]),
      ),
    };
  }

  /** Tool names this manager registered (plugins + MCP), so a caller can hide some. */
  ownedToolNames(): Set<string> {
    return new Set(this.owned);
  }

  /**
   * Extension tools an agent profile may not use. An empty set means "no
   * filtering": the profile allows everything it has installed.
   */
  blockedTools(selection: {
    plugins: string[] | null;
    mcp: string[] | null;
    /** Named extension tools this caller may never invoke, whatever else it allows. */
    denyTools?: string[] | null;
  }): Set<string> {
    const blocked = new Set<string>();
    for (const name of selection.denyTools ?? []) if (this.owned.has(name)) blocked.add(name);
    if (selection.plugins === null && selection.mcp === null) return blocked;

    const allowed = new Set<string>();
    for (const plugin of this.plugins) {
      if (selection.plugins === null || selection.plugins.includes(plugin.name)) {
        for (const tool of plugin.tools) allowed.add(tool.name);
      }
    }
    for (const runtime of this.mcp) {
      if (selection.mcp === null || selection.mcp.includes(runtime.name)) {
        for (const tool of runtime.tools) allowed.add(tool.name);
      }
    }
    for (const name of this.owned) if (!allowed.has(name)) blocked.add(name);
    return blocked;
  }

  /** Skill bodies and plugin prompts, rendered into the system prompt. */
  promptSections(selection?: { skills: string[] | null; plugins: string[] | null } | null): string[] {
    const sections: string[] = [];
    const skills =
      selection && selection.skills !== null
        ? this.skills.filter((skill) => selection.skills!.includes(skill.name))
        : this.skills;
    if (skills.length > 0) {
      sections.push(
        "Skills (instructions you have installed; follow them when relevant):",
        ...skills.map((skill) => `## Skill: ${skill.name}\n${skill.body}`),
      );
    }
    for (const plugin of this.plugins) {
      if (!plugin.prompt) continue;
      if (selection && selection.plugins !== null && !selection.plugins.includes(plugin.name)) continue;
      sections.push(`## Plugin: ${plugin.name}\n${plugin.prompt}`);
    }
    return sections;
  }

  /** Extra tools contributed by plugins and MCP servers. */
  extensionTools() {
    return [...this.plugins.flatMap((plugin) => plugin.tools), ...this.mcp.flatMap((runtime) => runtime.tools)];
  }

  /**
   * Read-only report of every extension directory plus any tool that was
   * refused because its name collides with an existing tool.
   */
  diagnostics(): ExtensionDiagnostic[] {
    return [...this.pluginDiagnostics, ...this.toolDiagnostics];
  }

  formatDiagnostics(): string {
    const lines = this.diagnostics().map((entry) => {
      const tools = entry.tools.length > 0 ? ` [${entry.tools.join(", ")}]` : "";
      return `${entry.status.padEnd(7)} ${entry.kind}:${entry.name}${tools} - ${entry.reason}`;
    });
    return lines.length > 0 ? lines.join("\n") : "no extension directories found";
  }

  register(registry: ToolRegistry): void {
    this.registry = registry;
    // Only remove what we put there: a built-in tool may share the name.
    for (const [name, tool] of this.registered) {
      if (registry.get(name) === tool) registry.unregister(name);
    }
    this.registered.clear();
    this.owned.clear();
    this.toolDiagnostics = [];

    for (const tool of this.extensionTools()) {
      const taken = registry.names().includes(tool.name) && !this.owned.has(tool.name);
      if (taken && !this.allowOverride) {
        const kind = this.plugins.some((plugin) => plugin.tools.includes(tool)) ? "plugin" : "mcp";
        this.log.warn(
          `extension tool "${tool.name}" conflicts with an existing tool, skipped (set EXTENSIONS_ALLOW_TOOL_OVERRIDE=1 to allow)`,
        );
        this.toolDiagnostics.push({
          kind,
          name: tool.name,
          status: "skipped",
          reason: "name conflicts with an existing tool",
          tools: [tool.name],
          entry: null,
        });
        continue;
      }
      if (taken) this.log.warn(`extension tool "${tool.name}" overrides an existing tool (allowed by config)`);
      registry.register(tool, "extension");
      this.owned.add(tool.name);
      this.registered.set(tool.name, tool);
    }
  }

  /** Runs an operator-approved extension change. Only the gateway calls this. */
  async applyApproved(input: { action: ApprovalAction; name: string; url?: string }): Promise<string> {
    if (input.action === "reload") {
      const summary = await this.reload();
      return `รีโหลด extension แล้ว\n${this.formatSummary(summary)}`;
    }
    if (input.action === "install") {
      if (!input.name) throw new Error("install needs a name");
      const installed = await this.hub.installByName(input.name, input.url);
      const summary = await this.reload();
      return `ติดตั้ง ${installed.kind} "${installed.name}" แล้ว\n${this.formatSummary(summary)}`;
    }
    if (!input.name) throw new Error("remove needs a name");
    const kind = await this.hub.remove(input.name);
    const summary = await this.reload();
    return `ถอน ${kind} "${input.name}" แล้ว\n${this.formatSummary(summary)}`;
  }

  /** Re-reads skills, plugins and MCP servers, then re-registers their tools. */
  async reload(): Promise<ExtensionSummary> {
    for (const runtime of this.mcp) await runtime.client.close().catch(() => undefined);
    this.mcp = [];
    this.skills = [];
    this.plugins = [];
    await this.init();
    if (this.registry) this.register(this.registry);
    return this.summary();
  }

  async installed(): Promise<InstalledEntry[]> {
    return this.hub.installed();
  }

  async close(): Promise<void> {
    for (const runtime of this.mcp) await runtime.client.close().catch(() => undefined);
    this.mcp = [];
  }

  formatSummary(summary: ExtensionSummary): string {
    const line = (label: string, items: string[]) => `${label}: ${items.length > 0 ? items.join(", ") : "none"}`;
    return [
      line("skills", summary.skills),
      line("plugins", summary.plugins),
      line("mcp", summary.mcp),
      `registry: ${summary.registry ?? "not configured"}`,
    ].join("\n");
  }

  formatEntries(entries: InstalledEntry[] | { name: string; kind: string; version?: string | null; description?: string | null }[]): string {
    if (entries.length === 0) return "nothing installed";
    return entries
      .map((entry) => describeEntry({ name: entry.name, kind: entry.kind as "skill" | "plugin" | "mcp", version: entry.version ?? undefined, description: entry.description ?? undefined }))
      .join("\n");
  }
}
