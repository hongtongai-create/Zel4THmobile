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

export type InstalledEntry = {
  name: string;
  kind: ExtensionKind;
  version: string | null;
  description: string | null;
};
