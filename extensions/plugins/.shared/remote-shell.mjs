import { execFile, spawn } from "node:child_process";

/**
 * Builds shell tools that run on ONE remote machine over ssh.
 *
 * A plugin directory = one machine, because an agent's capability allowlist in
 * the board ("Plugins") is per plugin. Copy a plugin directory, change its
 * plugin.json config (host / port / user / toolPrefix), and that machine becomes
 * a separate thing an agent can be given or denied.
 */

const MAX_OUTPUT = 6000;
const MAX_WRITE_BYTES = 512 * 1024;
const DEFAULT_TIMEOUT_S = 60;

/** Cheap guardrails: bricking the machine the agent controls is not recoverable. */
const DENIED = [
  { pattern: /\brm\s+(-[a-z]*\s+)*-[a-z]*r[a-z]*f?\s+\/(\s|$)/i, reason: "rm -r บน /" },
  { pattern: /\bmkfs(\.[a-z0-9]+)?\b/i, reason: "mkfs" },
  { pattern: /\bdd\b[^\n]*\bof=\/dev\//i, reason: "เขียนทับ device" },
  { pattern: /\b(reboot|shutdown|halt)\b/i, reason: "ปิด/รีบูตเครื่อง" },
  { pattern: /\bpm\s+(uninstall|clear)\b/i, reason: "ถอน/ล้างข้อมูลแอป" },
  { pattern: /\bsu\b\s+-c/i, reason: "เรียก root shell" },
];

function deniedReason(command) {
  for (const rule of DENIED) if (rule.pattern.test(command)) return rule.reason;
  return null;
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function clip(text) {
  const value = String(text ?? "").trim();
  if (value.length <= MAX_OUTPUT) return value;
  return `${value.slice(0, MAX_OUTPUT)}\n… ตัดอีก ${value.length - MAX_OUTPUT} ตัวอักษร`;
}

function report(code, stdout, stderr) {
  const parts = [`exit: ${code}`];
  if (String(stdout).trim()) parts.push(`stdout:\n${clip(stdout)}`);
  if (String(stderr).trim()) parts.push(`stderr:\n${clip(stderr)}`);
  return parts.join("\n");
}

export function createRemoteShellTools(config) {
  const prefix = String(config.toolPrefix ?? "remote").toLowerCase();
  const envHost = process.env[`${prefix.toUpperCase()}_HOST`];
  const host = envHost || String(config.host ?? "").trim();
  const port = String(process.env[`${prefix.toUpperCase()}_PORT`] || config.port || 22);
  const user = String(process.env[`${prefix.toUpperCase()}_USER`] || config.user || "").trim();
  if (!host) throw new Error(`plugin "${prefix}": config.host ยังว่าง`);

  const target = user ? `${user}@${host}` : host;
  const label = String(config.label ?? host);
  const notes = String(config.notes ?? "").trim();

  function sshArgs(remoteCommand) {
    return [
      "-p",
      port,
      "-o",
      "BatchMode=yes",
      "-o",
      "StrictHostKeyChecking=accept-new",
      "-o",
      "ConnectTimeout=8",
      "-o",
      "ServerAliveInterval=15",
      target,
      remoteCommand,
    ];
  }

  function runRemote(remoteCommand, timeoutMs) {
    return new Promise((resolve) => {
      execFile(
        "ssh",
        sshArgs(remoteCommand),
        { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 },
        (error, stdout, stderr) => {
          const code = error ? (typeof error.code === "number" ? error.code : 255) : 0;
          const extra = error && error.killed ? "\n(timeout: คำสั่งใช้เวลานานเกินไป)" : "";
          resolve(report(code, stdout ?? "", stderr ?? "") + extra);
        },
      );
    });
  }

  const runTool = {
    name: `${prefix}_run`,
    description:
      `Run a shell command on ${label} (${target}:${port}) over ssh. Returns exit code, stdout and stderr. ` +
      (notes ? `${notes} ` : "") +
      "Nothing runs on the gateway host itself.",
    parameters: {
      type: "object",
      properties: {
        command: { type: "string", description: `Shell command to run on ${label}.` },
        timeout_seconds: {
          type: "number",
          description: `Give up after this many seconds (default ${DEFAULT_TIMEOUT_S}).`,
        },
      },
      required: ["command"],
    },
    async handler(args) {
      const command = String(args.command ?? "").trim();
      if (!command) return "ต้องระบุ command";
      const denied = deniedReason(command);
      if (denied) return `ปฏิเสธคำสั่งนี้ (${denied}) — ขอให้ผู้ใช้ทำเองถ้าจำเป็นจริง ๆ`;
      const seconds = Number(args.timeout_seconds);
      const timeoutMs = (Number.isFinite(seconds) && seconds > 0 ? seconds : DEFAULT_TIMEOUT_S) * 1000;
      return runRemote(command, timeoutMs);
    },
  };

  const readTool = {
    name: `${prefix}_read`,
    description: `Read a text file on ${label}. Large files are clipped.`,
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: `Absolute path on ${label}.` },
      },
      required: ["path"],
    },
    async handler(args) {
      const file = String(args.path ?? "").trim();
      if (!file) return "ต้องระบุ path";
      return runRemote(`cat -- ${shellQuote(file)}`, 30_000);
    },
  };

  const writeTool = {
    name: `${prefix}_write`,
    description: `Create or replace a file on ${label}, creating parent directories.`,
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: `Absolute path on ${label}.` },
        content: { type: "string", description: "Full new contents of the file." },
      },
      required: ["path", "content"],
    },
    async handler(args) {
      const file = String(args.path ?? "").trim();
      if (!file) return "ต้องระบุ path";
      const content = String(args.content ?? "");
      const bytes = Buffer.byteLength(content, "utf8");
      if (bytes > MAX_WRITE_BYTES) return `ไฟล์ใหญ่เกิน ${MAX_WRITE_BYTES} ไบต์ (${bytes})`;

      const parent = file.replace(/\/[^/]*$/, "");
      const remote = `mkdir -p -- ${shellQuote(parent)} && cat > ${shellQuote(file)}`;
      return new Promise((resolve) => {
        const child = spawn("ssh", sshArgs(remote), { stdio: ["pipe", "pipe", "pipe"] });
        let stdout = "";
        let stderr = "";
        const timer = setTimeout(() => {
          child.kill("SIGKILL");
          resolve("timeout: เขียนไฟล์ไม่สำเร็จใน 30 วินาที");
        }, 30_000);
        child.stdout.on("data", (chunk) => {
          stdout += chunk;
        });
        child.stderr.on("data", (chunk) => {
          stderr += chunk;
        });
        child.on("error", (error) => {
          clearTimeout(timer);
          resolve(`ssh ใช้ไม่ได้: ${error.message}`);
        });
        child.on("close", (code) => {
          clearTimeout(timer);
          if (code !== 0) resolve(report(code ?? 255, stdout, stderr));
          else resolve(`เขียนแล้ว ${bytes} ไบต์ → ${file}`);
        });
        child.stdin.end(content);
      });
    },
  };

  return [runTool, readTool, writeTool];
}
