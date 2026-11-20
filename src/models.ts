import type { ProviderConfig } from "./config.js";
import type { ChatMessage, ToolCall, Usage } from "./types.js";

export type ModelInfo = {
  ref: string;
  providerId: string;
  providerLabel: string;
  model: string;
  default: boolean;
};

export type ResolvedModel = {
  ref: string;
  providerId: string;
  providerLabel: string;
  model: string;
  baseUrl: string;
  apiKey: string | null;
};

export type ToolDefinition = {
  type: "function";
  function: { name: string; description: string; parameters: Record<string, unknown> };
};

export type ChatRequest = {
  model: ResolvedModel;
  messages: ChatMessage[];
  tools?: ToolDefinition[];
  temperature?: number;
};

export type ChatResponse = {
  message: ChatMessage;
  usage: Usage | null;
};

export class ModelCatalog {
  private readonly providers: ProviderConfig[];
  private readonly preferredDefault: string | null;

  constructor(providers: ProviderConfig[], preferredDefault: string | null) {
    this.providers = providers;
    this.preferredDefault = preferredDefault;
  }

  get isEmpty(): boolean {
    return this.providers.length === 0;
  }

  defaultRef(): string | null {
    if (this.preferredDefault && this.has(this.preferredDefault)) return this.preferredDefault;
    const first = this.providers[0];
    if (!first) return null;
    return `${first.id}:${first.models[0] ?? "default"}`;
  }

  list(): ModelInfo[] {
    const fallback = this.defaultRef();
    return this.providers.flatMap((provider) =>
      provider.models.map((model) => {
        const ref = `${provider.id}:${model}`;
        return {
          ref,
          providerId: provider.id,
          providerLabel: provider.label,
          model,
          default: ref === fallback,
        };
      }),
    );
  }

  has(ref: string): boolean {
    try {
      this.resolve(ref);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Accepts `provider:model`. Unknown providers throw a readable error;
   * unknown models on a known provider are allowed (bring your own model id).
   */
  resolve(ref: string): ResolvedModel {
    const trimmed = ref.trim();
    if (!trimmed) throw new Error("Model reference is empty. Use provider:model, e.g. openai:gpt-4o-mini");

    const sep = trimmed.indexOf(":");
    let providerId: string;
    let model: string;

    if (sep === -1) {
      const provider = this.providers[0];
      if (!provider) throw new Error("No model providers configured.");
      providerId = provider.id;
      model = trimmed;
    } else {
      providerId = trimmed.slice(0, sep);
      model = trimmed.slice(sep + 1);
    }

    const provider = this.providers.find((candidate) => candidate.id === providerId);
    if (!provider) {
      const known = this.providers.map((candidate) => candidate.id).join(", ") || "(none)";
      throw new Error(`Unknown model provider "${providerId}". Configured providers: ${known}`);
    }
    if (!model.trim()) {
      throw new Error(`Model reference "${trimmed}" is missing a model name (provider:model).`);
    }

    return {
      ref: `${provider.id}:${model}`,
      providerId: provider.id,
      providerLabel: provider.label,
      model,
      baseUrl: provider.baseUrl,
      apiKey: provider.apiKey,
    };
  }
}

type RawToolCall = {
  id?: string;
  type?: string;
  function?: { name?: string; arguments?: string };
};

type RawResponse = {
  choices?: Array<{ message?: { content?: string | null; tool_calls?: RawToolCall[] } }>;
  usage?: Usage;
  error?: { message?: string };
};

export async function chatCompletion(request: ChatRequest): Promise<ChatResponse> {
  const { model, messages } = request;
  const body: Record<string, unknown> = {
    model: model.model,
    messages,
    stream: false,
  };
  if (request.tools && request.tools.length > 0) {
    body.tools = request.tools;
    body.tool_choice = "auto";
  }
  if (typeof request.temperature === "number") body.temperature = request.temperature;

  const headers: Record<string, string> = { "content-type": "application/json" };
  if (model.apiKey) headers.authorization = `Bearer ${model.apiKey}`;

  const url = `${model.baseUrl.replace(/\/+$/, "")}/chat/completions`;
  const response = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(180_000),
  });
  const text = await response.text();

  if (!response.ok) {
    throw new Error(
      `Model request failed (${response.status} from ${model.providerId}/${model.model}): ${text.slice(0, 500)}`,
    );
  }

  let parsed: RawResponse;
  try {
    parsed = JSON.parse(text) as RawResponse;
  } catch {
    throw new Error(`Model returned a non-JSON response: ${text.slice(0, 300)}`);
  }

  const choice = parsed.choices?.[0]?.message;
  if (!choice) {
    throw new Error(`Model response had no choices: ${text.slice(0, 300)}`);
  }

  const message: ChatMessage = {
    role: "assistant",
    content: typeof choice.content === "string" ? choice.content : null,
  };

  const rawCalls = Array.isArray(choice.tool_calls) ? choice.tool_calls : [];
  const toolCalls: ToolCall[] = [];
  rawCalls.forEach((call, index) => {
    const name = call.function?.name;
    if (!name) return;
    toolCalls.push({
      id: call.id ?? `call_${index}_${Date.now()}`,
      type: "function",
      function: {
        name,
        arguments: typeof call.function?.arguments === "string" ? call.function.arguments : "{}",
      },
    });
  });
  if (toolCalls.length > 0) message.tool_calls = toolCalls;

  return { message, usage: parsed.usage ?? null };
}
