import { appendFile, mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import type { SessionChannel, Usage } from "./types.js";

/** Price in USD per 1M tokens. */
export type Price = { input: number; output: number };

/**
 * Parsed `MODEL_PRICES`. Lookup order: exact `provider:model`, then
 * `provider:*`, then the global `*` entry.
 */
export type PriceTable = {
  exact: Map<string, Price>;
  provider: Map<string, Price>;
  fallback: Price | null;
};

const EMPTY_PRICES: PriceTable = { exact: new Map(), provider: new Map(), fallback: null };

function parsePrice(raw: string): Price | null {
  // "0.20/0.60" (input/output) or "0.20" (same price for both).
  const [inputRaw, outputRaw] = raw.split("/");
  const input = Number.parseFloat((inputRaw ?? "").trim());
  if (!Number.isFinite(input) || input < 0) return null;
  const output = outputRaw === undefined ? input : Number.parseFloat(outputRaw.trim());
  if (!Number.isFinite(output) || output < 0) return null;
  return { input, output };
}

/**
 * `MODEL_PRICES` format: semicolon or newline separated entries of
 * `key=input/output` in USD per 1M tokens, e.g.
 *
 *   custom:nvidia/nemotron-3-ultra-550b-a55b=0.20/0.60;custom:*=0.10/0.30;*=1/3
 */
export function parsePrices(raw: string | null | undefined): PriceTable {
  if (!raw || !raw.trim()) return EMPTY_PRICES;
  const exact = new Map<string, Price>();
  const provider = new Map<string, Price>();
  let fallback: Price | null = null;

  for (const chunk of raw.split(/[;\n]+/)) {
    const entry = chunk.trim();
    if (!entry) continue;
    const eq = entry.lastIndexOf("=");
    if (eq <= 0) continue;
    const key = entry.slice(0, eq).trim();
    const price = parsePrice(entry.slice(eq + 1));
    if (!key || !price) continue;
    if (key === "*") fallback = price;
    else if (key.endsWith(":*")) provider.set(key.slice(0, -2), price);
    else exact.set(key, price);
  }

  return { exact, provider, fallback };
}

export function priceFor(table: PriceTable, ref: string, providerId: string): Price | null {
  return table.exact.get(ref) ?? table.provider.get(providerId) ?? table.fallback ?? null;
}

export function costOf(price: Price | null, promptTokens: number, completionTokens: number): number | null {
  if (!price) return null;
  return (promptTokens / 1_000_000) * price.input + (completionTokens / 1_000_000) * price.output;
}

/** Turn-level token counts, summed over every model call in the turn. */
export type TokenCounts = { prompt: number; completion: number; total: number; known: boolean };

function definedNumber(value: number | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function tokenCounts(usage: Usage | null): TokenCounts {
  if (!usage) return { prompt: 0, completion: 0, total: 0, known: false };
  const prompt = definedNumber(usage.prompt_tokens);
  const completion = definedNumber(usage.completion_tokens);
  const total = definedNumber(usage.total_tokens);
  if (prompt === null && completion === null && total === null) {
    return { prompt: 0, completion: 0, total: 0, known: false };
  }
  const promptTokens = prompt ?? 0;
  const completionTokens = completion ?? 0;
  return {
    prompt: promptTokens,
    completion: completionTokens,
    total: total ?? promptTokens + completionTokens,
    known: true,
  };
}

/** Add one model call's usage to the running total for the turn. */
export function mergeUsage(total: Usage | null, next: Usage | null): Usage | null {
  const incoming = tokenCounts(next);
  if (!incoming.known) return total;
  const running = tokenCounts(total);
  return {
    prompt_tokens: running.prompt + incoming.prompt,
    completion_tokens: running.completion + incoming.completion,
    total_tokens: running.total + incoming.total,
  };
}

export type UsageEntry = {
  at: string;
  sessionId: string;
  channel: SessionChannel;
  model: string;
  providerId: string;
  providerLabel: string;
  iterations: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  /** null when no price is configured for this model/provider. */
  costUsd: number | null;
};

export type UsageRollup = {
  turns: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  costUsd: number;
  unpricedTurns: number;
  lastUsedAt: string | null;
};

export type ModelUsage = UsageRollup & {
  model: string;
  providerId: string;
  providerLabel: string;
};

export type ProviderUsage = UsageRollup & {
  providerId: string;
  providerLabel: string;
  models: number;
};

export type UsageSummary = {
  models: ModelUsage[];
  providers: ProviderUsage[];
  total: UsageRollup;
  pricingConfigured: boolean;
};

function emptyRollup(): UsageRollup {
  return {
    turns: 0,
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
    costUsd: 0,
    unpricedTurns: 0,
    lastUsedAt: null,
  };
}

function addToRollup(rollup: UsageRollup, entry: UsageEntry): void {
  rollup.turns += 1;
  rollup.promptTokens += entry.promptTokens;
  rollup.completionTokens += entry.completionTokens;
  rollup.totalTokens += entry.totalTokens;
  if (typeof entry.costUsd === "number") rollup.costUsd += entry.costUsd;
  else rollup.unpricedTurns += 1;
  if (!rollup.lastUsedAt || entry.at > rollup.lastUsedAt) rollup.lastUsedAt = entry.at;
}

function cloneRollup(rollup: UsageRollup): UsageRollup {
  return { ...rollup };
}

function formatUsd(value: number): string {
  if (value === 0) return "$0";
  if (value < 0.01) return `$${value.toFixed(6)}`;
  return `$${value.toFixed(4)}`;
}

export function formatMoney(value: number): string {
  return formatUsd(value);
}

export function formatTokens(value: number): string {
  return value.toLocaleString("en-US");
}

/**
 * Append-only per-turn usage log (`data/usage.jsonl`) plus in-memory rollups
 * per model and per provider. The JSONL file is the source of truth: totals
 * are rebuilt from it at startup, so they survive restarts.
 */
export class UsageLedger {
  private readonly dir: string;
  private readonly file: string;
  private readonly prices: PriceTable;
  private readonly byModel = new Map<string, ModelUsage>();
  private readonly byProvider = new Map<string, ProviderUsage>();
  private readonly overall = emptyRollup();
  private writes: Promise<void> = Promise.resolve();
  private ready = false;

  constructor(dataDir: string, prices: PriceTable) {
    this.dir = dataDir;
    this.file = path.join(dataDir, "usage.jsonl");
    this.prices = prices;
  }

  get pricingConfigured(): boolean {
    return this.prices.exact.size > 0 || this.prices.provider.size > 0 || this.prices.fallback !== null;
  }

  priceFor(modelRef: string, providerId: string): Price | null {
    return priceFor(this.prices, modelRef, providerId);
  }

  async init(): Promise<void> {
    if (this.ready) return;
    await mkdir(this.dir, { recursive: true });
    try {
      const raw = await readFile(this.file, "utf8");
      for (const line of raw.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          this.apply(JSON.parse(trimmed) as UsageEntry);
        } catch {
          // Skip a truncated or hand-edited line instead of failing startup.
        }
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    this.ready = true;
  }

  private apply(entry: UsageEntry): void {
    const modelKey = entry.model;
    let model = this.byModel.get(modelKey);
    if (!model) {
      model = { model: entry.model, providerId: entry.providerId, providerLabel: entry.providerLabel, ...emptyRollup() };
      this.byModel.set(modelKey, model);
    }
    addToRollup(model, entry);

    let provider = this.byProvider.get(entry.providerId);
    if (!provider) {
      provider = { providerId: entry.providerId, providerLabel: entry.providerLabel, models: 0, ...emptyRollup() };
      this.byProvider.set(entry.providerId, provider);
    }
    addToRollup(provider, entry);
    provider.models = [...this.byModel.values()].filter((row) => row.providerId === entry.providerId).length;

    addToRollup(this.overall, entry);
  }

  async record(entry: UsageEntry): Promise<{ model: UsageRollup; provider: UsageRollup; total: UsageRollup }> {
    await this.init();
    this.apply(entry);
    const line = `${JSON.stringify(entry)}\n`;
    this.writes = this.writes.then(() => appendFile(this.file, line, "utf8")).catch(() => undefined);
    await this.writes;

    const model = this.byModel.get(entry.model);
    const provider = this.byProvider.get(entry.providerId);
    if (!model || !provider) throw new Error(`Usage ledger lost the rollup for ${entry.model}`);
    return {
      model: cloneRollup(model),
      provider: cloneRollup(provider),
      total: cloneRollup(this.overall),
    };
  }

  summary(): UsageSummary {
    return {
      models: [...this.byModel.values()]
        .map((row) => ({ ...row }))
        .sort((a, b) => b.costUsd - a.costUsd || b.totalTokens - a.totalTokens),
      providers: [...this.byProvider.values()]
        .map((row) => ({ ...row }))
        .sort((a, b) => b.costUsd - a.costUsd || b.totalTokens - a.totalTokens),
      total: cloneRollup(this.overall),
      pricingConfigured: this.pricingConfigured,
    };
  }
}

/** `cost=$0.0012` or `cost=n/a (set MODEL_PRICES)`. */
export function describeCost(costUsd: number | null): string {
  return costUsd === null ? "cost=n/a (set MODEL_PRICES)" : `cost=${formatUsd(costUsd)}`;
}
