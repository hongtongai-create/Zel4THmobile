import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";

/** One decoration placed on the stage (furniture, a plant, a poster...). */
export type OfficeProp = {
  id: string;
  name: string;
  /** Board-relative path such as "/assets/props/desk.png". */
  image: string;
  /** Position in percent of the scene frame. */
  x: number;
  y: number;
  /** Multiplier of the stage's prop base size. */
  scale: number;
};

/** Frame count/fps for one character sheet, keyed by character id. */
export type CharacterAnim = { frames: number; fps: number };

export type OfficeUi = {
  theme: { accent: string };
  /** `character` is a multiplier, `text` is a font size in px. */
  sizes: { character: number; text: number };
  props: OfficeProp[];
  characters: Record<string, CharacterAnim>;
};

export const DEFAULT_OFFICE_UI: OfficeUi = {
  theme: { accent: "#6ee7b7" },
  sizes: { character: 1, text: 15 },
  props: [],
  characters: {},
};

const MAX_PROPS = 40;
const COLOUR = /^#[0-9a-fA-F]{6}$/;

function num(value: unknown, min: number, max: number, fallback: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

function str(value: unknown, max: number): string {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

/** Everything that reaches the screen goes through here: the board is not trusted. */
export function sanitizeOfficeUi(input: unknown, base: OfficeUi = DEFAULT_OFFICE_UI): OfficeUi {
  const raw = (input ?? {}) as Partial<OfficeUi>;
  const theme = (raw.theme ?? {}) as Partial<OfficeUi["theme"]>;
  const sizes = (raw.sizes ?? {}) as Partial<OfficeUi["sizes"]>;

  const props: OfficeProp[] = [];
  for (const entry of Array.isArray(raw.props) ? raw.props : []) {
    if (!entry || typeof entry.image !== "string") continue;
    const image = entry.image.trim();
    // Only same-origin board assets, so a profile cannot point the stage elsewhere.
    if (!image.startsWith("/assets/")) continue;
    const id = str(entry.id, 40) || `prop-${props.length + 1}`;
    props.push({
      id,
      name: str(entry.name, 60) || id,
      image,
      x: num(entry.x, 0, 100, 50),
      y: num(entry.y, 0, 100, 80),
      scale: num(entry.scale, 0.2, 3, 1),
    });
    if (props.length >= MAX_PROPS) break;
  }

  // A sheet uploaded through the studio has no frame count of its own, so the
  // board stores one per character here.
  const characters: Record<string, CharacterAnim> = {};
  const rawCharacters = (raw.characters ?? {}) as Record<string, Partial<CharacterAnim>>;
  for (const [id, entry] of Object.entries(rawCharacters)) {
    if (!/^[A-Za-z0-9_-]{1,40}$/.test(id) || !entry) continue;
    characters[id] = {
      frames: Math.round(num(entry.frames, 1, 16, 1)),
      fps: Math.round(num(entry.fps, 0, 24, 6)),
    };
    if (Object.keys(characters).length >= 40) break;
  }

  return {
    theme: { accent: COLOUR.test(str(theme.accent, 7)) ? str(theme.accent, 7) : base.theme.accent },
    sizes: {
      character: num(sizes.character, 0.5, 2, base.sizes.character),
      text: num(sizes.text, 11, 22, base.sizes.text),
    },
    props,
    characters,
  };
}

function file(dataDir: string): string {
  return path.join(dataDir, "office-ui.json");
}

/** Read once at boot; a broken or missing file falls back to the defaults. */
export function loadOfficeUiSync(dataDir: string): OfficeUi {
  try {
    return sanitizeOfficeUi(JSON.parse(readFileSync(file(dataDir), "utf8")), DEFAULT_OFFICE_UI);
  } catch {
    return { ...DEFAULT_OFFICE_UI, props: [], characters: {} };
  }
}

export function saveOfficeUi(dataDir: string, ui: OfficeUi): void {
  const target = file(dataDir);
  mkdirSync(path.dirname(target), { recursive: true });
  const temp = `${target}.tmp`;
  writeFileSync(temp, JSON.stringify(ui, null, 2), "utf8");
  renameSync(temp, target);
}
