import type { Tool } from "./index.js";

/**
 * Hands a piece of work to another agent on the board and waits for its answer.
 * The target runs a full turn of its own (own session, own tools, own model),
 * so work can be chained: think -> build the image -> publish the post.
 */
export function createDelegateTool(): Tool {
  return {
    name: "agent_delegate",
    description:
      "Hand a task to another agent on the office board and wait for its reply. " +
      "Use it to split work between characters, and to chain stages (for example: you plan, a designer makes the image, a publisher posts it). " +
      "The colleague runs its own turn with its own tools and conversation; its final answer comes back here as the tool result.",
    parameters: {
      type: "object",
      properties: {
        to: {
          type: "string",
          description:
            "Agent id or name of the colleague on the board (for example \"sirius\" or \"นักวาด\").",
        },
        task: {
          type: "string",
          description:
            "The work for that colleague, written as a complete instruction: the goal, the inputs it needs, what to produce, and who to hand the result to next (if anyone).",
        },
      },
      required: ["to", "task"],
      additionalProperties: false,
    },
    async handler(args, ctx) {
      const to = typeof args.to === "string" ? args.to.trim() : "";
      const task = typeof args.task === "string" ? args.task.trim() : "";
      if (!to) throw new Error('"to" is required: the id or name of the colleague.');
      if (!task) throw new Error('"task" is required: a complete instruction for the colleague.');
      if (!ctx.delegate) {
        throw new Error(
          "agent-to-agent handoff is not available here: only board characters can delegate to a colleague.",
        );
      }
      return ctx.delegate(to, task);
    },
  };
}
