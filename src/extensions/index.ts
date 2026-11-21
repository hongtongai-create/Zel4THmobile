import path from "node:path";
import type { Config } from "../config.js";
import type { Logger } from "../log.js";
import type { ToolRegistry } from "../tools/index.js";
import { HubClient, describeEntry } from "./hub.js";
import { loadMcpConfig, startMcpServers, type McpRuntime } from "./mcp.js";
import { loadPlugins } from "./plugins.js";
import { loadSkills } from "./skills.js";
import type { InstalledEntry, LoadedPlugin, Skill } from "./types.js";

export type ExtensionSummary = {
  skills: string[];
  plugins: string[];
  mcp: string[];
  registry: string | null;
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
  private registry: ToolRegistry | null = null;

  readonly hub: HubClient;
  readonly dir: string;

  constructor(
    config: Config,
    private readonly log: Logger,
  ) {
    this.dir = config.extensionsDir;
    this.hub = new HubClient(config.clawhubUrl, config.extensionsDir, log);
  }

  get skillList(): Skill[] {
    return this.skills;
  }

  get pluginList(): LoadedPlugin[] {
    return this.plugins;
  }

  async init(): Promise<void> {
    this.skills = await loadSkills(path.join(this.dir, "skills"));
    this.plugins = await loadPlugins(path.join(this.dir, "plugins"), this.log);

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
    };
  }

  /** Skill bodies and plugin prompts, rendered into the system prompt. */
  promptSections(): string[] {
    const sections: string[] = [];
    if (this.skills.length > 0) {
      sections.push(
        "Skills (instructions you have installed; follow them when relevant):",
        ...this.skills.map((skill) => `## Skill: ${skill.name}\n${skill.body}`),
      );
    }
    for (const plugin of this.plugins) {
      if (plugin.prompt) sections.push(`## Plugin: ${plugin.name}\n${plugin.prompt}`);
    }
    return sections;
  }

  /** Extra tools contributed by plugins and MCP servers. */
  extensionTools() {
    return [...this.plugins.flatMap((plugin) => plugin.tools), ...this.mcp.flatMap((runtime) => runtime.tools)];
  }

  register(registry: ToolRegistry): void {
    this.registry = registry;
    for (const name of this.owned) registry.unregister(name);
    this.owned.clear();

    for (const tool of this.extensionTools()) {
      const existing = registry.names().includes(tool.name);
      if (existing) this.log.warn(`extension tool "${tool.name}" overrides an existing tool`);
      registry.register(tool);
      this.owned.add(tool.name);
    }
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
