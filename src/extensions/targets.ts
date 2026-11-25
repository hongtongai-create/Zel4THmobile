import { execFile } from "node:child_process";
import { mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

/**
 * Remote machines an agent can reach over ssh: one plugin directory each.
 *
 * The board writes these instead of asking the operator to copy a folder by
 * hand. A target is just `extensions/plugins/<name>-shell/plugin.json` plus a
 * one-line entry module, and because an agent's allowlist is per plugin, the
 * plugin name is also the unit of permission.
 */

export type RemoteToolName = "run" | "read" | "write";

export const REMOTE_TOOLS: RemoteToolName[] = ["run", "read", "write"];

export type RemoteTarget = {
  /** Plugin directory name, e.g. "vivo-shell". */
  plugin: string;
  /** Tool prefix, e.g. "vivo" -> vivo_run / vivo_read / vivo_write. */
  prefix: string;
  label: string;
  host: string;
  port: number;
  user: string;
  tools: RemoteToolName[];
  notes: string;
  description: string;
};

export type TargetInput = {
  /** Plugin being edited; omitted when adding a machine by IP. */
  plugin?: string;
  /** Optional friendly name, which also becomes the tool prefix. */
  nickname?: string;
  host?: string;
  port?: number | string;
  user?: string;
  tools?: string[];
  notes?: string;
};

const ENTRY_MODULE = `import { readFileSync } from "node:fs";
import { createRemoteShellTools } from "../.shared/remote-shell.mjs";

const manifest = JSON.parse(readFileSync(new URL("./plugin.json", import.meta.url), "utf8"));

export const tools = createRemoteShellTools(manifest.config ?? {});
`;

const PREFIX_PATTERN = /^[a-z][a-z0-9_]{0,15}$/;
const PLUGIN_PATTERN = /^[a-z0-9][a-z0-9._-]{0,40}$/;
const HOST_PATTERN = /^[A-Za-z0-9._:-]{1,64}$/;
const USER_PATTERN = /^[A-Za-z0-9._@-]{1,64}$/;

type Manifest = {
  name?: string;
  description?: string;
  entry?: string;
  prompt?: string;
  config?: Record<string, unknown>;
};

async function readManifest(dir: string): Promise<Manifest | null> {
  try {
    return JSON.parse(await readFile(path.join(dir, "plugin.json"), "utf8")) as Manifest;
  } catch {
    return null;
  }
}

function toolList(value: unknown): RemoteToolName[] {
  if (!Array.isArray(value)) return [...REMOTE_TOOLS];
  const picked = value.filter((item): item is RemoteToolName =>
    REMOTE_TOOLS.includes(item as RemoteToolName),
  );
  return picked.length > 0 ? [...new Set(picked)] : [...REMOTE_TOOLS];
}

function targetFrom(plugin: string, manifest: Manifest): RemoteTarget | null {
  const config = manifest.config ?? {};
  const host = typeof config.host === "string" ? config.host.trim() : "";
  if (!host) return null;
  const port = Number(config.port);
  return {
    plugin,
    prefix: String(config.toolPrefix ?? plugin.replace(/-shell$/, "")).toLowerCase(),
    label: String(config.label ?? host),
    host,
    port: Number.isFinite(port) && port > 0 ? port : 22,
    user: String(config.user ?? ""),
    tools: toolList(config.tools),
    notes: String(config.notes ?? ""),
    description: String(manifest.description ?? ""),
  };
}

/** Every plugin directory that looks like a remote machine, sorted by name. */
export async function listTargets(pluginsDir: string): Promise<RemoteTarget[]> {
  let entries;
  try {
    entries = await readdir(pluginsDir, { withFileTypes: true });
  } catch {
    return [];
  }
  const targets: RemoteTarget[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
    const manifest = await readManifest(path.join(pluginsDir, entry.name));
    if (!manifest) continue;
    const target = targetFrom(entry.name, manifest);
    if (target) targets.push(target);
  }
  return targets.sort((a, b) => a.plugin.localeCompare(b.plugin));
}

/** An IP becomes a stable, unique tool prefix: 100.126.244.52 -> t100_126_244_52. */
export function prefixFor(host: string): string {
  const compact = host
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  const candidate = `t${compact}`.slice(0, 16).replace(/_+$/g, "");
  return PREFIX_PATTERN.test(candidate) ? candidate : "target";
}

function promptFor(target: Omit<RemoteTarget, "description">): string {
  const verbs: string[] = [];
  if (target.tools.includes("run")) verbs.push(`${target.prefix}_run for shell commands`);
  if (target.tools.includes("read")) verbs.push(`${target.prefix}_read to read a file`);
  if (target.tools.includes("write")) verbs.push(`${target.prefix}_write to create or replace one`);
  const available = verbs.length > 0 ? verbs.join(", ") : "no tools";
  return (
    `The ${target.prefix}_* tools run on ${target.label} (${target.host}) over ssh, not on this machine. ` +
    `Use ${available}. ` +
    (target.tools.includes("write") ? "" : "Writing files there is not allowed for this target. ") +
    (target.notes ? `${target.notes} ` : "") +
    "Check the exit code before assuming success."
  );
}

/**
 * Creates or updates one machine. With only an IP, everything else is derived;
 * re-saving the same IP updates that machine instead of adding a second one.
 */
export async function saveTarget(pluginsDir: string, input: TargetInput): Promise<RemoteTarget> {
  const host = String(input.host ?? "").trim();
  if (!host) throw new Error("ใส่ IP ของเครื่องก่อน");
  if (!HOST_PATTERN.test(host)) throw new Error("IP หรือชื่อเครื่องมีอักขระที่ใช้ไม่ได้");

  const existingTargets = await listTargets(pluginsDir);
  const known = input.plugin
    ? existingTargets.find((target) => target.plugin === input.plugin) ?? null
    : existingTargets.find((target) => target.host === host) ?? null;

  if (input.plugin && !known) {
    const manifest = await readManifest(path.join(pluginsDir, input.plugin));
    if (!manifest) throw new Error(`ไม่พบปลั๊กอิน ${input.plugin}`);
    throw new Error(`${input.plugin} ไม่ใช่ปลั๊กอินเครื่องปลายทาง`);
  }

  const portRaw = input.port === undefined || input.port === "" ? known?.port ?? 22 : Number(input.port);
  const port = Number.isFinite(portRaw) ? Math.trunc(portRaw) : 0;
  if (port < 1 || port > 65535) throw new Error("port ต้องอยู่ระหว่าง 1-65535");

  const user = String(input.user ?? known?.user ?? "").trim();
  if (user && !USER_PATTERN.test(user)) throw new Error("ชื่อผู้ใช้มีอักขระที่ใช้ไม่ได้");

  const tools = input.tools === undefined ? known?.tools ?? REMOTE_TOOLS : toolList(input.tools);
  const notes = String(input.notes ?? known?.notes ?? "").trim();

  const nickname = String(input.nickname ?? "").trim().toLowerCase();
  let prefix = known?.prefix ?? prefixFor(host);
  if (nickname) {
    if (!PREFIX_PATTERN.test(nickname)) {
      throw new Error("ชื่อเรียกใช้ได้เฉพาะ a-z, 0-9, _ และเริ่มด้วยตัวอักษร (เช่น vivo, work_pc)");
    }
    prefix = nickname;
  }

  const clash = existingTargets.find(
    (target) => target.prefix === prefix && target.plugin !== known?.plugin,
  );
  if (clash) throw new Error(`ชื่อเรียก "${prefix}" ถูกใช้กับ ${clash.label} แล้ว`);

  const plugin = known?.plugin ?? `${prefix}-shell`;
  if (!PLUGIN_PATTERN.test(plugin)) throw new Error("ชื่อปลั๊กอินไม่ถูกต้อง");

  const label = String(input.nickname ?? "").trim() || known?.label || host;
  const dir = path.join(pluginsDir, plugin);
  const existing = await readManifest(dir);
  const base = { plugin, prefix, label, host, port, user, tools, notes };
  const description =
    existing?.description?.trim() && known
      ? existing.description.trim()
      : `Shell and file access to ${label} (${user ? `${user}@` : ""}${host}) over ssh.`;
  const prompt = existing?.prompt?.trim() && known ? existing.prompt.trim() : promptFor(base);

  const manifest: Manifest = {
    name: existing?.name ?? plugin,
    description,
    entry: existing?.entry ?? "index.mjs",
    prompt,
    config: {
      toolPrefix: prefix,
      label,
      host,
      port,
      ...(user ? { user } : {}),
      tools,
      ...(notes ? { notes } : {}),
    },
  };

  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, "plugin.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  const entryFile = path.join(dir, manifest.entry ?? "index.mjs");
  try {
    await readFile(entryFile, "utf8");
  } catch {
    await writeFile(entryFile, ENTRY_MODULE, "utf8");
  }

  return { ...base, description };
}

/**
 * Moves the plugin directory aside instead of deleting it, so a mistaken
 * removal is one folder rename away from being restored.
 */
export async function removeTarget(pluginsDir: string, plugin: string): Promise<string> {
  if (!PLUGIN_PATTERN.test(plugin)) throw new Error("ชื่อปลั๊กอินไม่ถูกต้อง");
  const dir = path.join(pluginsDir, plugin);
  const manifest = await readManifest(dir);
  if (!manifest) throw new Error(`ไม่พบปลั๊กอิน ${plugin}`);
  if (!targetFrom(plugin, manifest)) throw new Error(`${plugin} ไม่ใช่ปลั๊กอินเครื่องปลายทาง`);

  const trash = path.join(pluginsDir, ".removed");
  await mkdir(trash, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const destination = path.join(trash, `${plugin}-${stamp}`);
  await rename(dir, destination);
  return destination;
}

export type ProbeResult = { ok: boolean; message: string };

/** One short ssh round trip: is the machine reachable with the current key? */
export function probeTarget(
  target: Pick<RemoteTarget, "host" | "port" | "user">,
  timeoutMs = 10_000,
): Promise<ProbeResult> {
  const destination = target.user ? `${target.user}@${target.host}` : target.host;
  const args = [
    "-p",
    String(target.port),
    "-o",
    "BatchMode=yes",
    "-o",
    "StrictHostKeyChecking=accept-new",
    "-o",
    "ConnectTimeout=6",
    destination,
    "uname -sr; hostname",
  ];
  return new Promise((resolve) => {
    execFile("ssh", args, { timeout: timeoutMs, maxBuffer: 64 * 1024 }, (error, stdout, stderr) => {
      if (!error) {
        const detail = String(stdout).trim().replace(/\s*\n\s*/g, " · ");
        resolve({ ok: true, message: detail || "เชื่อมต่อได้" });
        return;
      }
      const reason =
        String(stderr)
          .trim()
          .split("\n")
          .filter(Boolean)
          .pop() ?? error.message;
      const hint = /permission denied|no supported authentication|publickey/i.test(reason)
        ? " — ยังไม่ได้ใส่กุญแจ ssh ของ gateway ใน authorized_keys ของเครื่องนี้"
        : /timed out|timeout|connecttimeout|refused|unreachable/i.test(reason)
          ? " — เครื่องไม่ตอบ (ปิดอยู่ หรือ Tailscale ไม่ได้ต่อ)"
          : "";
      resolve({ ok: false, message: `${reason}${hint}` });
    });
  });
}
