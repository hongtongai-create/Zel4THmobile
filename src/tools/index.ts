import type { Config } from "../config.js";
import type { Logger } from "../log.js";
import type { ToolDefinition } from "../models.js";
import { createFacebookTool } from "./facebook.js";

export type ToolContext = {
  sessionId: string;
  log: Logger;
};

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

  register(tool: Tool): void {
    this.tools.set(tool.name, tool);
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
  return registry;
}
