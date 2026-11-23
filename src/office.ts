import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

export type SceneAsset = { id: string; name: string; image: string };

export type CharacterAsset = {
  id: string;
  name: string;
  image: string;
  /** Frames in one horizontal sprite sheet; 1 for a still image. */
  frames: number;
  fps: number;
};

export type OfficeAssets = { scenes: SceneAsset[]; characters: CharacterAsset[] };

const IMAGE_EXTENSIONS = new Set([".svg", ".png", ".webp", ".jpg", ".jpeg", ".gif", ".avif"]);

type Manifest = {
  scenes?: Array<Partial<SceneAsset>>;
  characters?: Array<Partial<CharacterAsset>>;
};

function prettyName(file: string): string {
  const base = file.replace(/\.[^.]+$/, "").replace(/[-_]+/g, " ");
  return base.charAt(0).toUpperCase() + base.slice(1);
}

function slug(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32);
}

/** Accepts "/assets/x.svg", "assets/x.svg" or "./assets/x.svg". */
function imagePath(value: string): string {
  const trimmed = value.trim();
  if (trimmed.startsWith("/")) return trimmed;
  return `/${trimmed.replace(/^\.?\//, "")}`;
}

async function listImages(dir: string): Promise<string[]> {
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isFile() && IMAGE_EXTENSIONS.has(path.extname(entry.name).toLowerCase()))
      .map((entry) => entry.name)
      .sort((a, b) => a.localeCompare(b));
  } catch {
    return [];
  }
}

/**
 * Reads `board/assets/office.json` (optional) and then any extra images dropped
 * into `assets/scenes` or `assets/characters`, so adding your own art needs no
 * code change. A sprite sheet is described with `frames` + `fps`.
 */
export async function loadOfficeAssets(boardDir: string): Promise<OfficeAssets> {
  const root = path.join(boardDir, "assets");

  let manifest: Manifest = {};
  try {
    manifest = JSON.parse(await readFile(path.join(root, "office.json"), "utf8")) as Manifest;
  } catch {
    manifest = {};
  }

  const scenes: SceneAsset[] = [];
  const characters: CharacterAsset[] = [];
  const seen = new Set<string>();

  for (const entry of manifest.scenes ?? []) {
    if (!entry || typeof entry.image !== "string") continue;
    const image = imagePath(entry.image);
    if (seen.has(image)) continue;
    seen.add(image);
    scenes.push({
      id: slug(typeof entry.id === "string" ? entry.id : path.basename(image, path.extname(image))) || `scene-${scenes.length + 1}`,
      name: typeof entry.name === "string" && entry.name.trim() ? entry.name.trim() : prettyName(image),
      image,
    });
  }

  for (const entry of manifest.characters ?? []) {
    if (!entry || typeof entry.image !== "string") continue;
    const image = imagePath(entry.image);
    if (seen.has(image)) continue;
    seen.add(image);
    characters.push({
      id: slug(typeof entry.id === "string" ? entry.id : path.basename(image, path.extname(image))) || `char-${characters.length + 1}`,
      name: typeof entry.name === "string" && entry.name.trim() ? entry.name.trim() : prettyName(image),
      image,
      frames: Math.max(1, Math.floor(Number(entry.frames) || 1)),
      fps: Math.max(0, Math.floor(Number(entry.fps) || 0)),
    });
  }

  for (const file of await listImages(path.join(root, "scenes"))) {
    const image = `/assets/scenes/${encodeURIComponent(file)}`;
    if (seen.has(image)) continue;
    seen.add(image);
    scenes.push({ id: slug(file) || `scene-${scenes.length + 1}`, name: prettyName(file), image });
  }

  for (const file of await listImages(path.join(root, "characters"))) {
    const image = `/assets/characters/${encodeURIComponent(file)}`;
    if (seen.has(image)) continue;
    seen.add(image);
    characters.push({
      id: slug(file) || `char-${characters.length + 1}`,
      name: prettyName(file),
      image,
      frames: 1,
      fps: 0,
    });
  }

  return { scenes, characters };
}
