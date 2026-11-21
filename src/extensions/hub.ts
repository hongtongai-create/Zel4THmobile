import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { Logger } from "../log.js";
import type { ExtensionKind, HubEntry, HubIndex, InstalledEntry, McpServerConfig } from "./types.js";

const NAME_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const MAX_FILE_BYTES = 512 * 1024;
const MAX_FILES_PER_ENTRY = 40;
const KINDS: ExtensionKind[] = ["skill", "plugin", "mcp"];

function assertName(name: string): void {
  if (!NAME_PATTERN.test(name)) {
    throw new Error(
      `Invalid extension name "${name}". Use lowercase letters, digits and . _ - (max 64 chars).`,
    );
  }
}

/** Rejects absolute paths and anything that climbs out of the extension directory. */
function safeRelativePath(key: string): string {
  const normalized = path.posix.normalize(key.replace(/\\/g, "/"));
  if (!normalized || normalized === "." || normalized === ".." || normalized.startsWith("../")) {
    throw new Error(`Unsafe file path in registry entry: "${key}"`);
  }
  if (normalized.startsWith("/") || /^[A-Za-z]:/.test(normalized)) {
    throw new Error(`Absolute file path in registry entry: "${key}"`);
  }
  return normalized;
}

function kindDir(kind: ExtensionKind): string {
  return kind === "skill" ? "skills" : "plugins";
}

/**
 * Client for a clawhub registry: a JSON index (over https, file: or a local path)
 * listing skills, plugins and MCP servers that can be installed into extensionsDir.
 */
export class HubClient {
  constructor(
    private readonly url: string | null,
    private readonly extensionsDir: string,
    private readonly log: Logger,
  ) {}

  get configured(): boolean {
    return Boolean(this.url);
  }

  get registryUrl(): string | null {
    return this.url;
  }

  get mcpConfigFile(): string {
    return path.join(this.extensionsDir, "mcp.json");
  }

  private get manifestFile(): string {
    return path.join(this.extensionsDir, "installed.json");
  }

  async fetchIndex(override?: string): Promise<HubIndex> {
    const source = (override ?? this.url ?? "").trim();
    if (!source) {
      throw new Error("No registry configured. Set CLAWHUB_URL in .env or pass a url to the install action.");
    }

    let text: string;
    if (/^https?:\/\//i.test(source)) {
      const response = await fetch(source, {
        headers: { accept: "application/json" },
        signal: AbortSignal.timeout(20_000),
      });
      if (!response.ok) throw new Error(`Registry returned HTTP ${response.status} for ${source}`);
      text = await response.text();
    } else if (/^file:/i.test(source)) {
      text = await readFile(new URL(source), "utf8");
    } else {
      text = await readFile(path.resolve(source), "utf8");
    }

    let parsed: HubIndex;
    try {
      parsed = JSON.parse(text) as HubIndex;
    } catch {
      throw new Error(`Registry index at ${source} is not valid JSON`);
    }
    if (!parsed || !Array.isArray(parsed.entries)) {
      throw new Error(`Registry index at ${source} is missing an "entries" array`);
    }
    return parsed;
  }

  async search(query: string, override?: string): Promise<HubEntry[]> {
    const index = await this.fetchIndex(override);
    const needle = query.trim().toLowerCase();
    if (!needle) return index.entries;
    return index.entries.filter((entry) => {
      const haystack = [entry.name, entry.description ?? "", entry.kind, ...(entry.tags ?? [])]
        .join(" ")
        .toLowerCase();
      return haystack.includes(needle);
    });
  }

  async find(name: string, override?: string): Promise<HubEntry> {
    const index = await this.fetchIndex(override);
    const entry = index.entries.find((candidate) => candidate.name === name.trim());
    if (!entry) {
      const available = index.entries.map((candidate) => `${candidate.name} (${candidate.kind})`).join(", ");
      throw new Error(`"${name}" is not in the registry. Available: ${available || "(none)"}`);
    }
    return entry;
  }

  async install(entry: HubEntry): Promise<InstalledEntry> {
    const name = (entry.name ?? "").trim();
    assertName(name);
    if (!KINDS.includes(entry.kind)) {
      throw new Error(`Unknown extension kind "${String(entry.kind)}" (expected skill, plugin or mcp)`);
    }

    if (entry.kind === "mcp") {
      await this.installMcp(name, entry);
    } else {
      await this.installFiles(name, entry.kind, entry.files);
    }

    const installed: InstalledEntry = {
      name,
      kind: entry.kind,
      version: entry.version ?? null,
      description: entry.description ?? null,
    };
    await this.recordManifest(installed);
    this.log.info(`installed ${entry.kind} "${name}"${entry.version ? ` v${entry.version}` : ""}`);
    return installed;
  }

  async installByName(name: string, override?: string): Promise<InstalledEntry> {
    const entry = await this.find(name, override);
    return this.install(entry);
  }

  async remove(name: string): Promise<ExtensionKind> {
    assertName(name);
    const removed: ExtensionKind[] = [];

    for (const kind of ["skill", "plugin"] as const) {
      const target = path.join(this.extensionsDir, kindDir(kind), name);
      try {
        await readdir(target);
      } catch {
        continue;
      }
      await rm(target, { recursive: true, force: true });
      removed.push(kind);
    }

    const servers = await this.readMcpServers();
    if (servers[name]) {
      delete servers[name];
      await this.writeMcpServers(servers);
      removed.push("mcp");
    }

    if (removed.length === 0) throw new Error(`No installed extension named "${name}"`);

    const manifest = (await this.readManifest()).filter((entry) => entry.name !== name);
    await this.writeFile(this.manifestFile, JSON.stringify(manifest, null, 2));
    this.log.info(`removed ${removed.join(", ")} "${name}"`);
    return removed[0];
  }

  /** Truth from disk: directories present plus MCP servers configured. */
  async installed(): Promise<InstalledEntry[]> {
    const manifest = await this.readManifest();
    const known = new Map(manifest.map((entry) => [`${entry.kind}:${entry.name}`, entry]));
    const result: InstalledEntry[] = [];

    for (const kind of ["skill", "plugin"] as const) {
      const dir = path.join(this.extensionsDir, kindDir(kind));
      let entries;
      try {
        entries = await readdir(dir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const recorded = known.get(`${kind}:${entry.name}`);
        result.push({
          name: recorded?.name ?? entry.name,
          kind,
          version: recorded?.version ?? null,
          description: recorded?.description ?? null,
        });
      }
    }

    for (const name of Object.keys(await this.readMcpServers())) {
      const recorded = known.get(`mcp:${name}`);
      result.push({
        name,
        kind: "mcp",
        version: recorded?.version ?? null,
        description: recorded?.description ?? null,
      });
    }

    return result.sort((a, b) => a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name));
  }

  private async installFiles(
    name: string,
    kind: "skill" | "plugin",
    files: Record<string, string> | undefined,
  ): Promise<void> {
    const entries = Object.entries(files ?? {});
    if (entries.length === 0) throw new Error(`Registry entry "${name}" ships no files`);
    if (entries.length > MAX_FILES_PER_ENTRY) {
      throw new Error(`Registry entry "${name}" has too many files (${entries.length} > ${MAX_FILES_PER_ENTRY})`);
    }

    if (kind === "skill" && !entries.some(([key]) => safeRelativePath(key) === "SKILL.md")) {
      throw new Error(`Skill "${name}" is missing SKILL.md`);
    }

    const base = path.join(this.extensionsDir, kindDir(kind), name);
    for (const [key, value] of entries) {
      const relative = safeRelativePath(key);
      if (typeof value !== "string") throw new Error(`File "${key}" in "${name}" is not a string`);
      if (Buffer.byteLength(value, "utf8") > MAX_FILE_BYTES) {
        throw new Error(`File "${key}" in "${name}" is too large`);
      }
      const target = path.join(base, relative);
      if (!target.startsWith(`${base}${path.sep}`)) {
        throw new Error(`File "${key}" in "${name}" escapes the extension directory`);
      }
      await this.writeFile(target, value);
    }
  }

  private async installMcp(name: string, entry: HubEntry): Promise<void> {
    const command = (entry.command ?? "").trim();
    if (!command) throw new Error(`MCP entry "${name}" has no command`);
    const servers = await this.readMcpServers();
    const config: McpServerConfig = { command };
    if (entry.args && entry.args.length > 0) config.args = entry.args;
    if (entry.env) config.env = entry.env;
    servers[name] = config;
    await this.writeMcpServers(servers);
  }

  private async readMcpServers(): Promise<Record<string, McpServerConfig>> {
    try {
      const parsed = JSON.parse(await readFile(this.mcpConfigFile, "utf8")) as {
        mcpServers?: Record<string, McpServerConfig>;
      };
      return parsed.mcpServers && typeof parsed.mcpServers === "object" ? parsed.mcpServers : {};
    } catch {
      return {};
    }
  }

  private async writeMcpServers(servers: Record<string, McpServerConfig>): Promise<void> {
    await this.writeFile(this.mcpConfigFile, `${JSON.stringify({ mcpServers: servers }, null, 2)}\n`);
  }

  private async readManifest(): Promise<InstalledEntry[]> {
    try {
      const parsed = JSON.parse(await readFile(this.manifestFile, "utf8")) as InstalledEntry[];
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }

  private async recordManifest(entry: InstalledEntry): Promise<void> {
    const manifest = (await this.readManifest()).filter(
      (existing) => !(existing.name === entry.name && existing.kind === entry.kind),
    );
    manifest.push(entry);
    await this.writeFile(this.manifestFile, `${JSON.stringify(manifest, null, 2)}\n`);
  }

  private async writeFile(file: string, contents: string): Promise<void> {
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, contents, "utf8");
  }
}

export function describeEntry(entry: HubEntry): string {
  const version = entry.version ? ` v${entry.version}` : "";
  const description = entry.description ? ` - ${entry.description}` : "";
  return `${entry.name} [${entry.kind}]${version}${description}`;
}

export function fileUrlFor(target: string): string {
  return pathToFileURL(path.resolve(target)).href;
}
