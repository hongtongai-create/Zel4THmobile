export type ChatRole = "system" | "user" | "assistant" | "tool";

export type ToolCall = {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
};

export type ChatMessage = {
  role: ChatRole;
  content: string | null;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
  name?: string;
};

export type SessionChannel = "board" | "telegram" | "line" | "cli";

export type Session = {
  id: string;
  channel: SessionChannel;
  title: string | null;
  model: string;
  createdAt: string;
  updatedAt: string;
  messages: ChatMessage[];
};

export type Usage = {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
};

export type AgentEvent =
  | { type: "turn.start"; sessionId: string; model: string }
  | { type: "tool.start"; sessionId: string; callId: string; name: string; args: unknown }
  | {
      type: "tool.result";
      sessionId: string;
      callId: string;
      name: string;
      ok: boolean;
      preview: string;
    }
  | { type: "assistant.message"; sessionId: string; text: string }
  | {
      type: "turn.end";
      sessionId: string;
      iterations: number;
      usage: Usage | null;
      /** Estimated USD cost for the turn; null when no price is configured. */
      costUsd: number | null;
    }
  | { type: "error"; sessionId: string; message: string };

export type EventListener = (event: AgentEvent) => void;
