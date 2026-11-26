import type { Config } from "../config.js";
import type { Logger } from "../log.js";
import type { ToolDefinition } from "../models.js";
import { createDelegateTool } from "./delegate.js";
import { createFacebookTool } from "./facebook.js";
import { createImageTool } from "./image.js";
import { createVideoTool } from "./video.js";

export type ToolContext = {
  sessionId: string;
  log: Logger;
  /** Set when a character runs the turn; used for audit and approvals. */
  agentId?: string | null;
  /**
   * Set only when a board character runs the turn: hands a task to a colleague
   * and resolves with that colleague's answer. Depth and loop guards live in
   * the harness, so a persona cannot walk around them.
   */
  delegate?: (to: string, task: string) => Promise<string>;
  /**
   * Extension tools this turn may call. Built-in tools are always allowed;
   * anything from a plugin or MCP server is checked here at invoke time, not
   * only hidden from the prompt.
   */
  allowedTools?: Set<string>;
};

/** Where a tool came from; extension tools are filtered per agent. */
export type ToolSource = "builtin" | "extension";

export type Tool = {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  handler: (args: Record<string, unknown>, ctx: ToolContext) => Promise<string>;
};

export type ToolOutcome = {
  ok: boolean;
  output: string;
};

export class ToolRegistry {
  private readonly tools = new Map<string, Tool>();
  private readonly sources = new Map<string, ToolSource>();

  register(tool: Tool, source: ToolSource = "builtin"): void {
    this.tools.set(tool.name, tool);
    this.sources.set(tool.name, source);
  }

  sourceOf(name: string): ToolSource | null {
    return this.sources.get(name) ?? null;
  }

  /** The tool currently registered under this name, if any. */
  get(name: string): Tool | undefined {
    return this.tools.get(name);
  }

  /** Used when extensions reload: their old tools must leave the registry first. */
  unregister(name: string): boolean {
    this.sources.delete(name);
    return this.tools.delete(name);
  }

  get size(): number {
    return this.tools.size;
  }

  names(): string[] {
    return [...this.tools.keys()];
  }

  /** Enabled tools, described for the model's `tools` field. */
  definitions(): ToolDefinition[] {
    return [...this.tools.values()].map((tool) => ({
      type: "function",
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
      },
    }));
  }

  describe(): string {
    return [...this.tools.values()]
      .map((tool) => `- ${tool.name}: ${tool.description}`)
      .join("\n");
  }

  async invoke(name: string, rawArgs: string, ctx: ToolContext): Promise<ToolOutcome> {
    const tool = this.tools.get(name);
    if (!tool) {
      return { ok: false, output: `Unknown tool "${name}". Available tools: ${this.names().join(", ") || "none"}` };
    }

    // Enforced here, so a persona that ignores its prompt still cannot reach
    // an extension another agent was given access to.
    if (
      ctx.allowedTools &&
      this.sourceOf(name) === "extension" &&
      !ctx.allowedTools.has(name)
    ) {
      return {
        ok: false,
        output: `Permission denied: tool "${name}" is not enabled for this agent. Its skills/plugins/MCP selection does not include it.`,
      };
    }

    let args: Record<string, unknown> = {};
    if (rawArgs.trim()) {
      try {
        const parsed = JSON.parse(rawArgs);
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          args = parsed as Record<string, unknown>;
        } else {
          return { ok: false, output: "Tool arguments must be a JSON object." };
        }
      } catch (error) {
        return { ok: false, output: `Tool arguments were not valid JSON: ${(error as Error).message}` };
      }
    }

    try {
      const output = await tool.handler(args, ctx);
      return { ok: true, output };
    } catch (error) {
      return { ok: false, output: `Tool failed: ${(error as Error).message}` };
    }
  }
}

export function createToolRegistry(config: Config): ToolRegistry {
  const registry = new ToolRegistry();
  if (config.facebook) registry.register(createFacebookTool(config.facebook));
  if (config.images) registry.register(createImageTool(config.images));
  if (config.videos) registry.register(createVideoTool(config.videos));
  registry.register(createDelegateTool());
  return registry;
}
