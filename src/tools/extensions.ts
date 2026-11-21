import type { ExtensionManager } from "../extensions/index.js";
import type { Tool } from "./index.js";

const ACTIONS = ["list", "search", "install", "remove", "reload"] as const;

/**
 * Lets the agent manage its own capabilities: search a clawhub registry,
 * install a skill/plugin/MCP server, remove one, or reload everything.
 */
export function createExtensionsTool(manager: ExtensionManager): Tool {
  return {
    name: "extensions",
    description:
      "Manage this agent's own extensions from the clawhub registry. action=list shows installed skills, plugins and MCP servers; action=search finds installable ones (query optional); action=install adds one by name (optionally from another registry url); action=remove deletes one; action=reload re-reads them from disk. Installed skills and MCP tools become available immediately.",
    parameters: {
      type: "object",
      properties: {
        action: { type: "string", enum: [...ACTIONS] },
        name: { type: "string", description: "Extension name for install/remove." },
        query: { type: "string", description: "Search text for action=search." },
        url: { type: "string", description: "Optional registry index URL or path for search/install." },
      },
      required: ["action"],
    },
    async handler(args) {
      const action = String(args.action ?? "").trim();
      const name = typeof args.name === "string" ? args.name.trim() : "";
      const query = typeof args.query === "string" ? args.query : "";
      const url = typeof args.url === "string" && args.url.trim() ? args.url.trim() : undefined;

      switch (action) {
        case "list": {
          const installed = await manager.installed();
          return `${manager.formatSummary(manager.summary())}\n\ninstalled:\n${manager.formatEntries(installed)}`;
        }
        case "search": {
          const entries = await manager.hub.search(query, url);
          if (entries.length === 0) return `No registry entries matched "${query}".`;
          return manager.formatEntries(entries);
        }
        case "install": {
          if (!name) throw new Error("install needs a name, e.g. {\"action\":\"install\",\"name\":\"clock\"}");
          const installed = await manager.hub.installByName(name, url);
          const summary = await manager.reload();
          return `installed ${installed.kind} "${installed.name}".\n${manager.formatSummary(summary)}`;
        }
        case "remove": {
          if (!name) throw new Error("remove needs a name");
          const kind = await manager.hub.remove(name);
          const summary = await manager.reload();
          return `removed ${kind} "${name}".\n${manager.formatSummary(summary)}`;
        }
        case "reload": {
          const summary = await manager.reload();
          return manager.formatSummary(summary);
        }
        default:
          throw new Error(`Unknown action "${action}". Use one of: ${ACTIONS.join(", ")}`);
      }
    },
  };
}
