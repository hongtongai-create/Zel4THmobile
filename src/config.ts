import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import type { PriceTable } from "./usage.js";
import { parsePrices } from "./usage.js";

export type ProviderConfig = {
  id: string;
  label: string;
  baseUrl: string;
  apiKey: string | null;
  models: string[];
};

export type FacebookConfig = {
  pageId: string;
  pageAccessToken: string;
  pageName: string | null;
  graphVersion: string;
  graphBaseUrl: string;
};

export type TelegramConfig = {
  botToken: string;
  allowedChatIds: string[];
};

export type Config = {
  gatewayToken: string;
  host: string;
  port: number;
  providers: ProviderConfig[];
  defaultModel: string | null;
  facebook: FacebookConfig | null;
  telegram: TelegramConfig | null;
  dataDir: string;
  boardDir: string;
  maxIterations: number;
  historyLimit: number;
  /** USD per 1M tokens, from `MODEL_PRICES`. Empty when no prices are set. */
  prices: PriceTable;
};

/** Minimal .env reader: real environment variables always win. */
export function loadDotEnv(file = ".env"): void {
  if (!existsSync(file)) return;
  const text = readFileSync(file, "utf8");
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    if (!key || process.env[key] !== undefined) continue;
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    process.env[key] = value;
  }
}

const DEFAULT_MODELS: Record<string, string[]> = {
  openai: ["gpt-4.1-mini", "gpt-4o-mini", "gpt-4o"],
  openrouter: ["openai/gpt-4.1-mini", "anthropic/claude-sonnet-4", "google/gemini-2.5-flash"],
  ollama: ["llama3.1", "qwen2.5:7b"],
  custom: ["default"],
};

function str(env: NodeJS.ProcessEnv, key: string): string | null {
  const value = env[key]?.trim();
  return value ? value : null;
}

function csv(env: NodeJS.ProcessEnv, key: string): string[] | null {
  const value = str(env, key);
  if (!value) return null;
  const items = value
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
  return items.length > 0 ? items : null;
}

function int(env: NodeJS.ProcessEnv, key: string, fallback: number): number {
  const raw = str(env, key);
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function buildProviders(env: NodeJS.ProcessEnv): ProviderConfig[] {
  const providers: ProviderConfig[] = [];

  const openaiKey = str(env, "OPENAI_API_KEY");
  if (openaiKey) {
    providers.push({
      id: "openai",
      label: "OpenAI",
      baseUrl: str(env, "OPENAI_BASE_URL") ?? "https://api.openai.com/v1",
      apiKey: openaiKey,
      models: csv(env, "OPENAI_MODELS") ?? DEFAULT_MODELS.openai!,
    });
  }

  const openrouterKey = str(env, "OPENROUTER_API_KEY");
  if (openrouterKey) {
    providers.push({
      id: "openrouter",
      label: "OpenRouter",
      baseUrl: str(env, "OPENROUTER_BASE_URL") ?? "https://openrouter.ai/api/v1",
      apiKey: openrouterKey,
      models: csv(env, "OPENROUTER_MODELS") ?? DEFAULT_MODELS.openrouter!,
    });
  }

  const ollamaBase = str(env, "OLLAMA_BASE_URL");
  if (str(env, "OLLAMA_ENABLED") === "1" || ollamaBase) {
    providers.push({
      id: "ollama",
      label: "Ollama (local)",
      baseUrl: ollamaBase ?? "http://127.0.0.1:11434/v1",
      apiKey: null,
      models: csv(env, "OLLAMA_MODELS") ?? DEFAULT_MODELS.ollama!,
    });
  }

  const customBase = str(env, "LLM_BASE_URL");
  if (customBase) {
    providers.push({
      id: "custom",
      label: str(env, "LLM_LABEL") ?? "Custom",
      baseUrl: customBase,
      apiKey: str(env, "LLM_API_KEY"),
      models: csv(env, "LLM_MODELS") ?? DEFAULT_MODELS.custom!,
    });
  }

  return providers;
}

function buildFacebook(env: NodeJS.ProcessEnv): FacebookConfig | null {
  const pageId = str(env, "FACEBOOK_PAGE_ID");
  const pageAccessToken = str(env, "FACEBOOK_PAGE_ACCESS_TOKEN");
  if (!pageId || !pageAccessToken) return null;
  return {
    pageId,
    pageAccessToken,
    pageName: str(env, "FACEBOOK_PAGE_NAME"),
    graphVersion: str(env, "FACEBOOK_GRAPH_VERSION") ?? "v21.0",
    graphBaseUrl: str(env, "FACEBOOK_GRAPH_BASE_URL") ?? "https://graph.facebook.com",
  };
}

function buildTelegram(env: NodeJS.ProcessEnv): TelegramConfig | null {
  const botToken = str(env, "TELEGRAM_BOT_TOKEN");
  if (!botToken) return null;
  return {
    botToken,
    allowedChatIds: csv(env, "TELEGRAM_ALLOWED_CHAT_IDS") ?? [],
  };
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const gatewayToken = str(env, "GATEWAY_TOKEN");
  if (!gatewayToken) {
    throw new Error(
      "GATEWAY_TOKEN is not set. The gateway refuses to start without a token (see .env.example).",
    );
  }

  const providers = buildProviders(env);
  const defaultModel = str(env, "DEFAULT_MODEL");

  return {
    gatewayToken,
    host: str(env, "HOST") ?? "0.0.0.0",
    port: int(env, "PORT", 8787),
    providers,
    defaultModel,
    facebook: buildFacebook(env),
    telegram: buildTelegram(env),
    dataDir: path.resolve(str(env, "DATA_DIR") ?? "data"),
    boardDir: path.resolve(str(env, "BOARD_DIR") ?? "board"),
    maxIterations: Math.max(1, int(env, "MAX_ITERATIONS", 8)),
    historyLimit: Math.max(6, int(env, "HISTORY_LIMIT", 60)),
    prices: parsePrices(str(env, "MODEL_PRICES")),
  };
}
