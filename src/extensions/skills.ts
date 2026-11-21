import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import type { Skill } from "./types.js";

/** Guard rails so one oversized skill cannot eat the whole prompt. */
const MAX_SKILLS = 64;
const MAX_BODY_CHARS = 4000;

function splitFrontmatter(raw: string): { meta: Record<string, string>; body: string } {
  const text = raw.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n");
  if (!text.startsWith("---\n")) return { meta: {}, body: text };

  const end = text.indexOf("\n---", 4);
  if (end === -1) return { meta: {}, body: text };

  const meta: Record<string, string> = {};
  for (const line of text.slice(4, end).split("\n")) {
    const colon = line.indexOf(":");
    if (colon <= 0) continue;
    const key = line.slice(0, colon).trim().toLowerCase();
    const value = line
      .slice(colon + 1)
      .trim()
      .replace(/^["']|["']$/g, "");
    if (key && value) meta[key] = value;
  }

  const body = text.slice(end + 4).replace(/^\n+/, "");
  return { meta, body };
}

function firstMeaningfulLine(body: string): string {
  for (const line of body.split("\n")) {
    const trimmed = line.replace(/^#+\s*/, "").trim();
    if (trimmed) return trimmed.slice(0, 160);
  }
  return "";
}

/** Reads every `extensions/skills/<name>/SKILL.md`; a missing directory is not an error. */
export async function loadSkills(dir: string): Promise<Skill[]> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }

  const skills: Skill[] = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isDirectory()) continue;
    const skillDir = path.join(dir, entry.name);
    let raw: string;
    try {
      raw = await readFile(path.join(skillDir, "SKILL.md"), "utf8");
    } catch {
      continue;
    }
    const { meta, body } = splitFrontmatter(raw);
    const trimmed = body.trim();
    if (!trimmed) continue;
    skills.push({
      name: meta.name ?? entry.name,
      description: meta.description ?? firstMeaningfulLine(trimmed),
      body: trimmed.length > MAX_BODY_CHARS ? `${trimmed.slice(0, MAX_BODY_CHARS)}\n… (truncated)` : trimmed,
      dir: skillDir,
    });
    if (skills.length >= MAX_SKILLS) break;
  }

  return skills;
}
