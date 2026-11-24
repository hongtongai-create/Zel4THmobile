import type { ApprovalQueue } from "../extensions/approvals.js";
import type { ExtensionManager } from "../extensions/index.js";
import type { Tool } from "./index.js";

const ACTIONS = ["list", "search", "install", "remove", "reload", "diagnostics"] as const;
const MUTATING = new Set(["install", "remove", "reload"]);

export type ExtensionWriteMode = "confirm" | "allow" | "deny";

export type ExtensionsToolOptions = {
  /** Operator approval queue; install/remove/reload wait here by default. */
  approvals?: ApprovalQueue;
  writes?: ExtensionWriteMode;
};

/**
 * Lets the agent manage its own capabilities: search a clawhub registry,
 * install a skill/plugin/MCP server, remove one, or reload everything.
 *
 * Mutating actions never run on the model's word alone: by default they are
 * queued for operator approval, and `EXTENSIONS_AGENT_WRITES=deny` blocks them
 * outright. Only an explicit `allow` setting runs them directly.
 */
export function createExtensionsTool(manager: ExtensionManager, options: ExtensionsToolOptions = {}): Tool {
  const writes = options.writes ?? "confirm";

  return {
    name: "extensions",
    description:
      "Inspect and manage this agent's extensions. action=list shows installed skills, plugins and MCP servers; action=search finds installable ones (query optional); action=diagnostics explains why a discovered plugin/skill is loaded, skipped or failed; action=install adds one by name (optionally from another registry url); action=remove deletes one; action=reload re-reads them from disk. install/remove/reload need the operator's approval and do not run immediately.",
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
    async handler(args, ctx) {
      const action = String(args.action ?? "").trim();
      const name = typeof args.name === "string" ? args.name.trim() : "";
      const query = typeof args.query === "string" ? args.query : "";
      const url = typeof args.url === "string" && args.url.trim() ? args.url.trim() : undefined;

      if (MUTATING.has(action)) {
        if (writes === "deny") {
          return `Operator policy blocks agent-driven extension changes (EXTENSIONS_AGENT_WRITES=deny). Nothing was ${action === "reload" ? "reloaded" : action === "install" ? "installed" : "removed"}.`;
        }
        if (writes === "confirm") {
          if (!options.approvals) {
            return "This change needs operator approval, but no approval queue is available. Nothing was changed.";
          }
          const request = options.approvals.request({
            action: action as "install" | "remove" | "reload",
            name,
            url,
            sessionId: ctx?.sessionId ?? "unknown",
            agentId: ctx?.agentId ?? null,
          });
          const label = name ? `${action} "${name}"` : action;
          const shortId = request.id.slice(0, 8);
          return [
            `Approval required: ${label} was not executed.`,
            `Request ${shortId} is waiting for the operator (board -> รออนุมัติ, or \`approve ${shortId}\` in Telegram/LINE).`,
            "Nothing was installed, removed or reloaded yet. Tell the operator what should be approved.",
          ].join("\n");
        }
      }

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
        case "diagnostics": {
          return manager.formatDiagnostics();
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
