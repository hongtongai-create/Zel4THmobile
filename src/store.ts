import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Session, SessionChannel } from "./types.js";

function fileNameFor(id: string): string {
  const safe = id.replace(/[^a-zA-Z0-9._-]/g, "_");
  return `${safe}.json`;
}

export class SessionStore {
  private readonly dir: string;

  constructor(dataDir: string) {
    this.dir = path.join(dataDir, "sessions");
  }

  async init(): Promise<void> {
    await mkdir(this.dir, { recursive: true });
  }

  async get(id: string): Promise<Session | null> {
    try {
      const raw = await readFile(path.join(this.dir, fileNameFor(id)), "utf8");
      return JSON.parse(raw) as Session;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }

  async save(session: Session): Promise<void> {
    await this.init();
    const target = path.join(this.dir, fileNameFor(session.id));
    const temp = `${target}.tmp`;
    await writeFile(temp, JSON.stringify(session, null, 2), "utf8");
    await rename(temp, target);
  }

  async getOrCreate(id: string, channel: SessionChannel, model: string): Promise<Session> {
    const existing = await this.get(id);
    if (existing) return existing;
    const now = new Date().toISOString();
    const session: Session = {
      id,
      channel,
      title: null,
      model,
      createdAt: now,
      updatedAt: now,
      messages: [],
    };
    await this.save(session);
    return session;
  }

  async list(): Promise<Session[]> {
    await this.init();
    const entries = await readdir(this.dir);
    const sessions: Session[] = [];
    for (const entry of entries) {
      if (!entry.endsWith(".json")) continue;
      try {
        const raw = await readFile(path.join(this.dir, entry), "utf8");
        sessions.push(JSON.parse(raw) as Session);
      } catch {
        // Skip unreadable or partially written files.
      }
    }
    return sessions.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  async reset(id: string): Promise<Session | null> {
    const session = await this.get(id);
    if (!session) return null;
    session.messages = [];
    session.title = null;
    session.updatedAt = new Date().toISOString();
    await this.save(session);
    return session;
  }
}
