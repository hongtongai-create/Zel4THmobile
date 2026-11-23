import type { Tool } from "../tools/index.js";

export type ExtensionKind = "skill" | "plugin" | "mcp";

export type McpServerConfig = {
  command: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
};

/** One installable item in a clawhub index. */
export type HubEntry = {
  name: string;
  kind: ExtensionKind;
  version?: string;
  description?: string;
  tags?: string[];
  /** `skill` and `plugin` entries ship their files inline, keyed by relative path. */
  files?: Record<string, string>;
  /** `mcp` entries carry the command to spawn. */
  command?: string;
  args?: string[];
  env?: Record<string, string>;
};

export type HubIndex = {
  name?: string;
  version?: number;
  entries: HubEntry[];
};

export type Skill = {
  name: string;
  description: string;
  body: string;
  dir: string;
};

export type LoadedPlugin = {
  name: string;
  description: string;
  prompt: string | null;
  tools: Tool[];
  dir: string;
};

/**
 * One read-only load report line: what was discovered and why it is (not) live.
 * Reasons never contain secrets; they come from the loader itself.
 */
export type ExtensionDiagnostic = {
  kind: ExtensionKind;
  name: string;
  status: "loaded" | "skipped" | "failed";
  reason: string;
  tools: string[];
  entry: string | null;
};

export type InstalledEntry = {
  name: string;
  kind: ExtensionKind;
  version: string | null;
  description: string | null;
};
