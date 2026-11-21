import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { Logger } from "../log.js";
import type { Tool } from "../tools/index.js";
import type { LoadedPlugin } from "./types.js";

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

async function exists(file: string): Promise<boolean> {
  try {
    return (await stat(file)).isFile();
  } catch {
    return false;
  }
}

async function readManifest(dir: string): Promise<PluginManifest> {
  for (const file of ["plugin.json", "package.json"]) {
    try {
      const raw = await readFile(path.join(dir, file), "utf8");
      const parsed = JSON.parse(raw) as PluginManifest;
      if (parsed && typeof parsed === "object") return parsed;
    } catch {
      // Try the next manifest name.
    }
  }
  return {};
}

function toolsFrom(value: unknown): Tool[] {
  if (Array.isArray(value)) return value.filter(isTool);
  return isTool(value) ? [value] : [];
}

/**
 * Reads `extensions/plugins/<name>/` and imports the module it points at.
 * A plugin exports `tools` (array of tools) and optionally `prompt` (string).
 */
export async function loadPlugins(dir: string, log: Logger): Promise<LoadedPlugin[]> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }

  const plugins: LoadedPlugin[] = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isDirectory()) continue;
    const pluginDir = path.join(dir, entry.name);
    const manifest = await readManifest(pluginDir);
    const entryFile = path.join(pluginDir, manifest.entry ?? "index.mjs");
    if (!(await exists(entryFile))) {
      log.warn(`plugin "${entry.name}" has no entry module (${manifest.entry ?? "index.mjs"}), skipped`);
      continue;
    }

    try {
      // A fresh query string bypasses the ESM module cache so reload picks up edits.
      const url = `${pathToFileURL(entryFile).href}?v=${Date.now()}`;
      const loaded = (await import(url)) as PluginModule;
      const fallback = (loaded.default ?? {}) as PluginModule;
      const tools = [...toolsFrom(loaded.tools), ...toolsFrom(fallback.tools)];
      const promptSource = loaded.prompt ?? fallback.prompt ?? manifest.prompt;
      const prompt = typeof promptSource === "string" && promptSource.trim() ? promptSource.trim() : null;

      if (tools.length === 0 && !prompt) {
        log.warn(`plugin "${entry.name}" exports no tools and no prompt, skipped`);
        continue;
      }

      plugins.push({
        name: manifest.name ?? entry.name,
        description: manifest.description ?? "",
        prompt,
        tools,
        dir: pluginDir,
      });
    } catch (error) {
      log.warn(`plugin "${entry.name}" failed to load: ${(error as Error).message}`);
    }
  }

  return plugins;
}
