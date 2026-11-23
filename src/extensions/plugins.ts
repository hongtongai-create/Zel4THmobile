import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { Logger } from "../log.js";
import type { Tool } from "../tools/index.js";
import type { ExtensionDiagnostic, LoadedPlugin } from "./types.js";

type PluginManifest = {
  name?: string;
  description?: string;
  entry?: string;
  prompt?: string;
};

type PluginModule = {
  tools?: unknown;
  prompt?: unknown;
  default?: unknown;
};

export type PluginLoadResult = {
  plugins: LoadedPlugin[];
  /** Every plugin directory found, with the reason it is or is not active. */
  diagnostics: ExtensionDiagnostic[];
};

function isTool(value: unknown): value is Tool {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.name === "string" &&
    candidate.name.length > 0 &&
    typeof candidate.description === "string" &&
    typeof candidate.handler === "function"
  );
}

function rawTools(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  return value === undefined ? [] : [value];
}

async function exists(file: string): Promise<boolean> {
  try {
    return (await stat(file)).isFile();
  } catch {
    return false;
  }
}

async function readManifest(dir: string, problems: string[]): Promise<PluginManifest> {
  for (const file of ["plugin.json", "package.json"]) {
    let raw: string;
    try {
      raw = await readFile(path.join(dir, file), "utf8");
    } catch {
      continue;
    }
    try {
      const parsed = JSON.parse(raw) as PluginManifest;
      if (parsed && typeof parsed === "object") return parsed;
      problems.push(`${file} is not a JSON object`);
    } catch (error) {
      problems.push(`${file} is not valid JSON: ${(error as Error).message}`);
    }
  }
  return {};
}

function diagnostic(
  name: string,
  status: ExtensionDiagnostic["status"],
  reason: string,
  tools: string[] = [],
  entry: string | null = null,
): ExtensionDiagnostic {
  return { kind: "plugin", name, status, reason, tools, entry };
}

/**
 * Reads `extensions/plugins/<name>/` and imports the module it points at.
 * A plugin exports `tools` (array of tools) and optionally `prompt` (string).
 * Every directory produces one diagnostic line, even when it is skipped, so an
 * operator can see why a plugin's tools never reach the model.
 */
export async function loadPlugins(dir: string, log: Logger): Promise<PluginLoadResult> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return {
      plugins: [],
      diagnostics: [diagnostic(path.basename(dir), "skipped", `plugins directory not found (${dir})`)],
    };
  }

  const plugins: LoadedPlugin[] = [];
  const diagnostics: ExtensionDiagnostic[] = [];

  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
    const pluginDir = path.join(dir, entry.name);
    const problems: string[] = [];
    const manifest = await readManifest(pluginDir, problems);
    const entryName = manifest.entry ?? "index.mjs";
    const entryFile = path.join(pluginDir, entryName);
    const label = manifest.name ?? entry.name;

    if (!(await exists(entryFile))) {
      log.warn(`plugin "${entry.name}" has no entry module (${entryName}), skipped`);
      diagnostics.push(
        diagnostic(entry.name, "skipped", `entry module "${entryName}" not found`, [], entryName),
      );
      continue;
    }

    try {
      // A fresh query string bypasses the ESM module cache so reload picks up edits.
      const url = `${pathToFileURL(entryFile).href}?v=${Date.now()}`;
      const loaded = (await import(url)) as PluginModule;
      const fallback = (loaded.default ?? {}) as PluginModule;
      const exported = [...rawTools(loaded.tools), ...rawTools(fallback.tools)];
      const tools = exported.filter(isTool);
      const invalid = exported.length - tools.length;
      const promptSource = loaded.prompt ?? fallback.prompt ?? manifest.prompt;
      const prompt = typeof promptSource === "string" && promptSource.trim() ? promptSource.trim() : null;

      if (tools.length === 0 && !prompt) {
        const reason =
          exported.length > 0
            ? `${exported.length} exported tool(s) do not match { name, description, handler }`
            : "module exports no tools and no prompt";
        log.warn(`plugin "${entry.name}" ${reason}, skipped`);
        diagnostics.push(diagnostic(entry.name, "skipped", reason, [], entryName));
        continue;
      }

      const notes = [
        `${tools.length} tool(s)${prompt ? " + prompt" : ""}`,
        invalid > 0 ? `${invalid} malformed export(s) ignored` : "",
        ...problems,
      ].filter(Boolean);

      plugins.push({
        name: label,
        description: manifest.description ?? "",
        prompt,
        tools,
        dir: pluginDir,
      });
      diagnostics.push(
        diagnostic(entry.name, "loaded", notes.join(", "), tools.map((tool) => tool.name), entryName),
      );
    } catch (error) {
      log.warn(`plugin "${entry.name}" failed to load: ${(error as Error).message}`);
      diagnostics.push(diagnostic(entry.name, "failed", `import failed: ${(error as Error).message}`, [], entryName));
    }
  }

  return { plugins, diagnostics };
}
