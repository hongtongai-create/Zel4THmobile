import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

export const MAX_AGENTS = 12;

/** `null` means "every installed item"; an array is an explicit allowlist. */
export type Selection = string[] | null;

export type AgentProfile = {
  id: string;
  name: string;
  emoji: string;
  /** Short line shown on the board and in the prompt ("นักเขียนคอนเทนต์"). */
  role: string;
  /** Free-form personality / instructions written by the operator. */
  identity: string;
  /** Model ref override; null follows the gateway default. */
  model: string | null;
  skills: Selection;
  plugins: Selection;
  mcp: Selection;
  /** Individual extension tools this agent may never call, by tool name. */
  denyTools: string[];
  color: string;
  /** Office character asset id, or an image path starting with "/". */
  sprite: string | null;
  /** Office position in percent of the stage. */
  x: number;
  y: number;
  createdAt: string;
  updatedAt: string;
};

type StoreFile = {
  version: 1;
  scene: string | null;
  agents: AgentProfile[];
};

const DEFAULT_AGENT: Omit<AgentProfile, "createdAt" | "updatedAt"> = {
  id: "main",
  name: "Claw",
  emoji: "◆",
  role: "ผู้ช่วยหลัก",
  identity:
    "คุณคือ Claw ผู้ช่วยหลักของทีม พูดสั้น ตรงประเด็น ลงมือทำเองด้วย tools\nYou are calm, practical and you finish what you start.",
  model: null,
  skills: null,
  plugins: null,
  mcp: null,
  denyTools: [],
  color: "#6ee7b7",
  sprite: "sirius",
  x: 34,
  y: 62,
};

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}

function slug(value: string): string {
  return value
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 24);
}

/** A plain list of names: missing or malformed input means "none". */
function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [
    ...new Set(
      value
        .filter((item): item is string => typeof item === "string")
        .map((item) => item.trim())
        .filter(Boolean),
    ),
  ];
}

function selection(value: unknown): Selection {
  if (!Array.isArray(value)) return null;
  const items = value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter(Boolean);
  return [...new Set(items)];
}

function shortText(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, max) : null;
}

/**
 * The agents that live on the board: one JSON file, no database.
 * Profiles own their identity text, default model and which installed
 * skills, plugins and MCP servers they are allowed to use.
 */
export class AgentRegistry {
  private readonly file: string;
  private data: StoreFile | null = null;
  private loading: Promise<void> | null = null;

  constructor(dataDir: string) {
    this.file = path.join(dataDir, "agents.json");
  }

  private async ensure(): Promise<void> {
    if (this.data) return;
    if (!this.loading) this.loading = this.load();
    await this.loading;
  }

  private async load(): Promise<void> {
    let parsed: StoreFile | null = null;
    try {
      const raw = await readFile(this.file, "utf8");
      const candidate = JSON.parse(raw) as Partial<StoreFile>;
      if (candidate && Array.isArray(candidate.agents)) {
        parsed = {
          version: 1,
          scene: typeof candidate.scene === "string" ? candidate.scene : null,
          agents: candidate.agents
            .filter((agent): agent is AgentProfile => Boolean(agent) && typeof agent.id === "string")
            .map((agent) => ({ ...agent, denyTools: stringList(agent.denyTools) })),
        };
      }
    } catch {
      parsed = null;
    }

    if (!parsed) {
      const now = new Date().toISOString();
      parsed = { version: 1, scene: null, agents: [{ ...DEFAULT_AGENT, createdAt: now, updatedAt: now }] };
      this.data = parsed;
      await this.persist();
      return;
    }

    if (parsed.agents.length === 0) {
      const now = new Date().toISOString();
      parsed.agents.push({ ...DEFAULT_AGENT, createdAt: now, updatedAt: now });
      this.data = parsed;
      await this.persist();
      return;
    }

    this.data = parsed;
  }

  private async persist(): Promise<void> {
    const data = this.data;
    if (!data) return;
    await mkdir(path.dirname(this.file), { recursive: true });
    const temp = `${this.file}.tmp`;
    await writeFile(temp, JSON.stringify(data, null, 2), "utf8");
    await rename(temp, this.file);
  }

  /** Selected office scene (asset id), shared by every board client. */
  get scene(): string | null {
    return this.data?.scene ?? null;
  }

  async list(): Promise<AgentProfile[]> {
    await this.ensure();
    return [...(this.data?.agents ?? [])];
  }

  async get(id: string): Promise<AgentProfile | null> {
    await this.ensure();
    return this.data?.agents.find((agent) => agent.id === id) ?? null;
  }

  async setScene(scene: string | null): Promise<void> {
    await this.ensure();
    if (!this.data) return;
    this.data.scene = scene && scene.trim() ? scene.trim().slice(0, 60) : null;
    await this.persist();
  }

  async create(input: Record<string, unknown>): Promise<AgentProfile> {
    await this.ensure();
    const data = this.data;
    if (!data) throw new Error("Agent store is unavailable.");
    if (data.agents.length >= MAX_AGENTS) {
      throw new Error(`มี agent ครบ ${MAX_AGENTS} ตัวแล้ว ลบตัวที่ไม่ใช้ก่อน`);
    }

    const name = shortText(input.name, 40) ?? `Agent ${data.agents.length + 1}`;
    const base = slug(name) || "agent";
    let id = base;
    let suffix = 2;
    while (data.agents.some((agent) => agent.id === id)) {
      id = `${base}-${suffix}`;
      suffix += 1;
    }

    const now = new Date().toISOString();
    const index = data.agents.length;
    const agent: AgentProfile = {
      id,
      name,
      emoji: shortText(input.emoji, 4) ?? "🤖",
      role: shortText(input.role, 120) ?? "",
      identity: typeof input.identity === "string" ? input.identity.slice(0, 4000) : "",
      model: shortText(input.model, 200),
      skills: selection(input.skills),
      plugins: selection(input.plugins),
      mcp: selection(input.mcp),
      denyTools: stringList(input.denyTools),
      color: shortText(input.color, 24) ?? "#6ee7b7",
      sprite: shortText(input.sprite, 200),
      x: 18 + ((index * 17) % 64),
      y: 46 + ((index * 13) % 26),
      createdAt: now,
      updatedAt: now,
    };
    data.agents.push(agent);
    await this.persist();
    return agent;
  }

  /** Applies the fields present in `patch`; unknown keys are ignored. */
  async update(id: string, patch: Record<string, unknown>): Promise<AgentProfile | null> {
    await this.ensure();
    const agent = this.data?.agents.find((candidate) => candidate.id === id);
    if (!agent) return null;

    if (typeof patch.name === "string" && patch.name.trim()) agent.name = patch.name.trim().slice(0, 40);
    if (typeof patch.emoji === "string") agent.emoji = patch.emoji.trim().slice(0, 4) || agent.emoji;
    if (typeof patch.role === "string") agent.role = patch.role.trim().slice(0, 120);
    if (typeof patch.identity === "string") agent.identity = patch.identity.slice(0, 4000);
    if ("model" in patch) agent.model = shortText(patch.model, 200);
    if ("skills" in patch) agent.skills = selection(patch.skills);
    if ("plugins" in patch) agent.plugins = selection(patch.plugins);
    if ("mcp" in patch) agent.mcp = selection(patch.mcp);
    if ("denyTools" in patch) agent.denyTools = stringList(patch.denyTools);
    if (typeof patch.color === "string" && patch.color.trim()) agent.color = patch.color.trim().slice(0, 24);
    if ("sprite" in patch) agent.sprite = shortText(patch.sprite, 200);
    if (typeof patch.x === "number") agent.x = clamp(patch.x, 2, 96);
    if (typeof patch.y === "number") agent.y = clamp(patch.y, 8, 94);
    agent.updatedAt = new Date().toISOString();
    await this.persist();
    return agent;
  }

  /** Never leaves the office empty. */
  async remove(id: string): Promise<boolean> {
    await this.ensure();
    const data = this.data;
    if (!data) return false;
    if (data.agents.length <= 1) throw new Error("ต้องเหลือ agent อย่างน้อย 1 ตัว");
    const index = data.agents.findIndex((agent) => agent.id === id);
    if (index < 0) return false;
    data.agents.splice(index, 1);
    await this.persist();
    return true;
  }
}
