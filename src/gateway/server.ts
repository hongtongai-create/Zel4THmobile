import { createHash, timingSafeEqual } from "node:crypto";
import { createReadStream, existsSync, statSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import path from "node:path";
import type { Duplex } from "node:stream";
import { WebSocket, WebSocketServer } from "ws";
import type { AgentHarness } from "../agent.js";
import { AgentRegistry, type AgentProfile } from "../agents.js";
import type { LineChannel } from "../channels/line.js";
import type { Config } from "../config.js";
import type { ApprovalQueue } from "../extensions/approvals.js";
import { ApprovalService } from "../extensions/approval-service.js";
import {
  listTargets,
  probeTarget,
  removeTarget,
  saveTarget,
  type RemoteTarget,
  type TargetInput,
} from "../extensions/targets.js";
import type { Logger } from "../log.js";
import { loadOfficeAssets, type OfficeAssets } from "../office.js";
import { loadOfficeUiSync, sanitizeOfficeUi, saveOfficeUi, type OfficeUi } from "../office-ui.js";
import type { AgentEvent, SessionChannel } from "../types.js";

/** Where two characters stand when work is handed over (percent of the scene frame). */
const MEET_GAP = 14;
const MEET_STAGGER = 3;

const clampPct = (value: number, min: number, max: number): number => Math.min(max, Math.max(min, value));

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".ico": "image/x-icon",
  ".glb": "model/gltf-binary",
  ".mp3": "audio/mpeg",
  ".ogg": "audio/ogg",
  ".zip": "application/zip",
  ".gz": "application/gzip",
};

// Served app shell files must stay fresh; the service worker handles offline caching.
const NO_STORE_FILES = new Set(["/sw.js", "/manifest.webmanifest"]);

function safeEqual(a: string, b: string): boolean {
  // Hash both sides so lengths always match, then compare in constant time.
  const left = createHash("sha256").update(a).digest();
  const right = createHash("sha256").update(b).digest();
  return timingSafeEqual(left, right);
}

function bearer(header: string | undefined): string {
  if (!header) return "";
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match ? match[1].trim() : "";
}

type GatewayOptions = {
  config: Config;
  harness: AgentHarness;
  log: Logger;
  agents?: AgentRegistry;
  approvals?: ApprovalQueue;
  /** Shared with the chat channels so every surface sees the same decisions. */
  approvalService?: ApprovalService;
  line?: LineChannel;
};

type ClientMessage = Record<string, unknown> & { type?: unknown };

const SESSION_ID_PATTERN = /^[A-Za-z0-9._:-]{1,120}$/;

const MAX_WEBHOOK_BYTES = 1_000_000;

async function readBody(req: import("node:http").IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
    size += buffer.length;
    if (size > MAX_WEBHOOK_BYTES) throw new Error("request body too large");
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

/** Raw-body upload reader with its own (larger) ceiling than the webhook reader. */
const MAX_UPLOAD_BYTES = 12 * 1024 * 1024;

async function readUpload(req: import("node:http").IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
    size += buffer.length;
    if (size > MAX_UPLOAD_BYTES) throw new Error("ไฟล์ใหญ่เกิน 12 MB");
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

const UPLOAD_IMAGE_EXT = new Set([".svg", ".png", ".webp", ".jpg", ".jpeg", ".gif", ".avif"]);
const UPLOAD_KINDS: Record<string, string> = { scenes: "scenes", characters: "characters", props: "props" };

export function createGateway(options: GatewayOptions) {
  const { config, harness, log, approvals, line } = options;
  const agents = options.agents ?? new AgentRegistry(config.dataDir);
  const approvalService =
    options.approvalService ??
    (approvals ? new ApprovalService(approvals, () => harness.extensions ?? null) : null);

  const clients = new Set<WebSocket>();
  const wss = new WebSocketServer({ noServer: true });

  let assetsPromise: Promise<OfficeAssets> | null = null;

  function officeAssets(): Promise<OfficeAssets> {
    if (!assetsPromise) {
      assetsPromise = loadOfficeAssets(config.boardDir).catch((error: Error) => {
        log.warn(`office assets unavailable: ${error.message}`);
        return { scenes: [], characters: [] };
      });
    }
    return assetsPromise;
  }

  function broadcast(payload: unknown): void {
    const data = JSON.stringify(payload);
    for (const client of clients) {
      if (client.readyState === WebSocket.OPEN) client.send(data);
    }
  }

  function send(socket: WebSocket, payload: unknown): void {
    if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(payload));
  }

  /** Full agent + office state, broadcast after any agent or scene change. */
  // Theme, sizes and stage props live outside agents.json: they are shared by
  // every profile and apply to the board, not to an agent.
  let officeUi: OfficeUi = loadOfficeUiSync(config.dataDir);

  async function agentsState() {
    const [profiles, assets] = await Promise.all([agents.list(), officeAssets()]);
    // Frame counts set in the studio win over the sheet's own defaults, so an
    // uploaded walk cycle animates without editing office.json.
    const office = {
      ...assets,
      characters: assets.characters.map((entry) => {
        const anim = officeUi.characters?.[entry.id];
        return anim ? { ...entry, frames: anim.frames, fps: anim.fps } : entry;
      }),
    };
    return {
      type: "agents.state",
      agents: profiles,
      scene: agents.scene,
      office,
      ui: officeUi,
      extensions: harness.extensions?.summary() ?? null,
    };
  }

  async function broadcastAgents(): Promise<void> {
    broadcast(await agentsState());
  }

  /**
   * Two characters walk to a shared spot when one hands work to the other, so the
   * board shows the handoff instead of only a tool chip.
   */
  async function meet(from: AgentProfile, to: AgentProfile, task: string): Promise<void> {
    const midX = (from.x + to.x) / 2;
    const midY = (from.y + to.y) / 2;
    // 28% of the frame apart with a slight stagger: far enough that two name
    // plates and speech bubbles sit side by side instead of stacking.
    const leftX = clampPct(midX - MEET_GAP, 2, 96);
    const rightX = clampPct(midX + MEET_GAP, 2, 96);
    // Sequential: both writes persist to the same agents.json.
    await agents.update(from.id, { x: leftX, y: clampPct(midY - MEET_STAGGER, 8, 94) });
    await agents.update(to.id, { x: rightX, y: clampPct(midY + MEET_STAGGER, 8, 94) });
    await broadcastAgents();
    broadcast({
      type: "office.talk",
      from: from.id,
      to: to.id,
      fromName: from.name,
      toName: to.name,
      text: task.replace(/\s+/g, " ").trim().slice(0, 80),
      at: Date.now(),
    });
  }

  // Delegated turns are broadcast like any other turn, under their own session,
  // so the receiving character's bubble and tool chips update live.
  harness.setDelegationHooks({
    onEvent: (event) => broadcast({ type: "event", event }),
    onMeet: (from, to, task) => {
      void meet(from, to, task).catch((error: Error) =>
        log.warn(`could not stage the handoff in the office: ${error.message}`),
      );
    },
  });

  function onAgentEvent(socket: WebSocket | null): (event: AgentEvent) => void {
    return (event) => {
      const payload = { type: "event", event };
      if (socket) send(socket, payload);
      else broadcast(payload);
    };
  }

  function channelFor(sessionId: string): SessionChannel {
    if (sessionId.startsWith("telegram:")) return "telegram";
    if (sessionId.startsWith("line:")) return "line";
    if (sessionId.startsWith("cli:")) return "cli";
    return "board";
  }

  const diagnostics = () => harness.extensions?.diagnostics() ?? [];

  /** Where remote-machine plugins live; null when extensions are turned off. */
  const pluginsDir = () => (harness.extensions ? path.join(harness.extensions.dir, "plugins") : null);

  /** Every machine the board may edit, plus whether editing is possible at all. */
  async function targetsState(): Promise<{
    type: "targets.state";
    ready: boolean;
    targets: RemoteTarget[];
  }> {
    const dir = pluginsDir();
    return { type: "targets.state", ready: Boolean(dir), targets: dir ? await listTargets(dir) : [] };
  }

  function requirePluginsDir(socket: WebSocket): string | null {
    const dir = pluginsDir();
    if (!dir) send(socket, { type: "error", message: "extension system ไม่พร้อมใช้งาน" });
    return dir;
  }

  function approvalsState() {
    return {
      type: "approvals.state",
      requests: approvals?.list() ?? [],
      writes: config.agentExtensionWrites,
      diagnostics: diagnostics(),
    };
  }

  // Every queued request, approval and rejection reaches all open boards.
  approvals?.onChange(() => broadcast(approvalsState()));

  function sessionIdOf(msg: ClientMessage): string | null {
    const sessionId = typeof msg.sessionId === "string" ? msg.sessionId : "";
    if (!SESSION_ID_PATTERN.test(sessionId)) {
      return null;
    }
    return sessionId;
  }

  async function handleMessage(socket: WebSocket, raw: string): Promise<void> {
    let msg: ClientMessage;
    try {
      msg = JSON.parse(raw) as ClientMessage;
    } catch {
      send(socket, { type: "error", message: "Malformed JSON frame." });
      return;
    }
    if (typeof msg.type !== "string") {
      send(socket, { type: "error", message: "Frame is missing a string `type`." });
      return;
    }

    try {
      switch (msg.type) {
        case "ping":
          send(socket, { type: "pong", at: Date.now() });
          return;

        case "models.list":
          send(socket, { type: "models.list", models: harness.catalog.list(), default: harness.catalog.defaultRef() });
          return;

        case "agents.list":
          send(socket, await agentsState());
          return;

        case "ui.get": {
          send(socket, { type: "ui.state", ui: officeUi, office: await officeAssets() });
          return;
        }

        case "ui.update": {
          officeUi = sanitizeOfficeUi(msg.ui, officeUi);
          saveOfficeUi(config.dataDir, officeUi);
          broadcast({ type: "ui.state", ui: officeUi });
          // Character frame counts change the sprite sheets every board renders.
          await broadcastAgents();
          return;
        }

        case "agent.create": {
          await agents.create(msg);
          await broadcastAgents();
          return;
        }

        case "agent.update": {
          const id = typeof msg.id === "string" ? msg.id : "";
          const updated = await agents.update(id, msg);
          if (!updated) {
            send(socket, { type: "error", message: "ไม่พบ agent นี้" });
            return;
          }
          await broadcastAgents();
          return;
        }

        case "agent.delete": {
          const id = typeof msg.id === "string" ? msg.id : "";
          const removed = await agents.remove(id);
          if (!removed) {
            send(socket, { type: "error", message: "ไม่พบ agent นี้" });
            return;
          }
          await broadcastAgents();
          return;
        }

        case "approvals.list":
          send(socket, approvalsState());
          return;

        case "approval.approve": {
          const id = typeof msg.id === "string" ? msg.id : "";
          if (!approvalService) {
            send(socket, { type: "approval.result", id, ok: false, message: "extension system ไม่พร้อมใช้งาน" });
            return;
          }
          const outcome = await approvalService.approve(id);
          if (outcome.ok) await broadcastAgents();
          send(socket, { type: "approval.result", id: outcome.id ?? id, ok: outcome.ok, message: outcome.message });
          return;
        }

        case "approval.reject": {
          const id = typeof msg.id === "string" ? msg.id : "";
          const outcome = approvalService?.reject(id) ?? {
            ok: false,
            id: null,
            message: "ระบบอนุมัติไม่พร้อมใช้งาน",
          };
          send(socket, { type: "approval.result", id: outcome.id ?? id, ok: outcome.ok, message: outcome.message });
          return;
        }

        case "office.scene": {
          const scene = typeof msg.scene === "string" ? msg.scene : null;
          await agents.setScene(scene);
          await broadcastAgents();
          return;
        }

        case "office.move": {
          const id = typeof msg.id === "string" ? msg.id : "";
          const patch: Record<string, number> = {};
          if (typeof msg.x === "number") patch.x = msg.x;
          if (typeof msg.y === "number") patch.y = msg.y;
          await agents.update(id, patch);
          await broadcastAgents();
          return;
        }

        case "targets.list":
          send(socket, await targetsState());
          return;

        case "target.save": {
          const dir = requirePluginsDir(socket);
          if (!dir) return;
          const target = await saveTarget(dir, msg as unknown as TargetInput);
          // New plugin, new tools: reload so the agent sees them this second.
          await harness.extensions?.reload();
          send(socket, { type: "target.saved", target });
          send(socket, await targetsState());
          await broadcastAgents();
          send(socket, approvalsState());
          return;
        }

        case "target.delete": {
          const dir = requirePluginsDir(socket);
          if (!dir) return;
          const plugin = typeof msg.plugin === "string" ? msg.plugin : "";
          const movedTo = await removeTarget(dir, plugin);
          await harness.extensions?.reload();
          send(socket, { type: "target.deleted", plugin, movedTo });
          send(socket, await targetsState());
          await broadcastAgents();
          send(socket, approvalsState());
          return;
        }

        case "target.probe": {
          const dir = requirePluginsDir(socket);
          if (!dir) return;
          const plugin = typeof msg.plugin === "string" ? msg.plugin : "";
          const target = (await listTargets(dir)).find((entry) => entry.plugin === plugin);
          if (!target) {
            send(socket, { type: "error", message: "ไม่พบเครื่องนี้" });
            return;
          }
          const result = await probeTarget(target);
          send(socket, { type: "target.probe", plugin, ok: result.ok, message: result.message });
          return;
        }

        case "sessions.list": {
          const sessions = await harness.store.list();
          send(socket, {
            type: "sessions.list",
            sessions: sessions.map((session) => ({
              id: session.id,
              channel: session.channel,
              title: session.title,
              model: session.model,
              messages: session.messages.length,
              updatedAt: session.updatedAt,
            })),
          });
          return;
        }

        case "session.history": {
          const sessionId = sessionIdOf(msg);
          if (!sessionId) {
            send(socket, { type: "error", message: "Invalid sessionId." });
            return;
          }
          const session = await harness.store.get(sessionId);
          send(socket, {
            type: "session.history",
            sessionId,
            model: session?.model ?? harness.catalog.defaultRef(),
            messages: (session?.messages ?? []).filter(
              (message) => message.role === "user" || message.role === "assistant",
            ),
          });
          return;
        }

        case "session.reset": {
          const sessionId = sessionIdOf(msg);
          if (!sessionId) {
            send(socket, { type: "error", message: "Invalid sessionId." });
            return;
          }
          await harness.reset(sessionId);
          send(socket, { type: "session.reset", sessionId });
          return;
        }

        case "model.set": {
          const sessionId = sessionIdOf(msg);
          const model = typeof msg.model === "string" ? msg.model : "";
          if (!sessionId) {
            send(socket, { type: "error", message: "Invalid sessionId." });
            return;
          }
          const session = await harness.setModel(sessionId, channelFor(sessionId), model);
          // A model picked for a character also becomes that agent's default.
          const agentId = typeof msg.agentId === "string" ? msg.agentId : "";
          if (agentId) await agents.update(agentId, { model: session.model });
          send(socket, { type: "model.set", sessionId, model: session.model });
          if (agentId) await broadcastAgents();
          return;
        }

        case "chat.send": {
          const sessionId = sessionIdOf(msg);
          const text = typeof msg.text === "string" ? msg.text.trim() : "";
          if (!sessionId) {
            send(socket, { type: "error", message: "Invalid sessionId." });
            return;
          }
          if (!text) {
            send(socket, { type: "error", message: "Message text is empty." });
            return;
          }
          const agentId = typeof msg.agentId === "string" ? msg.agentId : "";
          const profile = agentId ? await agents.get(agentId) : null;
          if (agentId && !profile) {
            send(socket, { type: "error", message: "ไม่พบ agent นี้" });
            return;
          }
          const emit = onAgentEvent(null);
          harness
            .run(sessionId, channelFor(sessionId), text, emit, profile)
            .catch(() => undefined);
          return;
        }

        default:
          send(socket, { type: "error", message: `Unknown frame type "${msg.type}".` });
      }
    } catch (error) {
      log.warn(`frame ${msg.type} failed: ${(error as Error).message}`);
      send(socket, { type: "error", message: (error as Error).message });
    }
  }

  wss.on("connection", (socket) => {
    clients.add(socket);
    log.info(`board client connected (${clients.size} online)`);

    void (async () => {
      try {
        const state = await agentsState();
        send(socket, {
          type: "ready",
          agent: "Zel4THmobile",
          tools: harness.tools.names(),
          defaultModel: harness.catalog.defaultRef(),
          models: harness.catalog.list(),
          extensions: harness.extensions?.summary() ?? null,
          diagnostics: diagnostics(),
          extensionWrites: config.agentExtensionWrites,
          approvals: approvals?.list() ?? [],
          line: line?.status() ?? null,
          agents: state.agents,
          scene: state.scene,
          office: state.office,
          ui: officeUi,
        });
      } catch (error) {
        log.warn(`could not greet board client: ${(error as Error).message}`);
      }
    })();

    socket.on("message", (data) => {
      void handleMessage(socket, data.toString());
    });
    socket.on("close", () => {
      clients.delete(socket);
      log.info(`board client disconnected (${clients.size} online)`);
    });
    socket.on("error", (error) => {
      log.warn(`client socket error: ${error.message}`);
    });
  });

  function serveStatic(reqPath: string, res: import("node:http").ServerResponse): boolean {
    if (!existsSync(config.boardDir)) return false;
    const relative = decodeURIComponent(reqPath === "/" ? "/index.html" : reqPath);
    const target = path.resolve(config.boardDir, `.${relative}`);
    if (!target.startsWith(config.boardDir + path.sep) && target !== config.boardDir) return false;
    if (!existsSync(target) || !statSync(target).isFile()) return false;

    const ext = path.extname(target);
    const headers: Record<string, string> = {
      "content-type": MIME[ext] ?? "application/octet-stream",
      "cache-control": NO_STORE_FILES.has(relative) ? "no-store" : "no-cache",
      "service-worker-allowed": "/",
    };
    // Archives are offered as downloads so tablets/phones save the file instead of rendering it.
    if (ext === ".zip" || ext === ".gz") {
      headers["content-disposition"] = `attachment; filename="${path.basename(target)}"`;
    }
    res.writeHead(200, headers);
    createReadStream(target).pipe(res);
    return true;
  }

  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);

    if (line && url.pathname === line.webhookPath && req.method === "POST") {
      void (async () => {
        try {
          const raw = await readBody(req);
          const result = await line.handleWebhook(raw, req.headers["x-line-signature"] as string | undefined);
          res.writeHead(result.status, { "content-type": "application/json", "cache-control": "no-store" });
          res.end(result.body);
        } catch (error) {
          log.warn(`line webhook failed: ${(error as Error).message}`);
          res.writeHead(400, { "content-type": "application/json", "cache-control": "no-store" });
          res.end(JSON.stringify({ ok: false, error: "bad request" }));
        }
      })();
      return;
    }

    if (url.pathname === "/api/health") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, agent: "Zel4THmobile", online: clients.size }));
      return;
    }

    if (url.pathname === "/api/status") {
      const token = bearer(req.headers.authorization) || (url.searchParams.get("token") ?? "");
      if (!safeEqual(token, config.gatewayToken)) {
        res.writeHead(401, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: "unauthorized" }));
        return;
      }
      res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
      res.end(
        JSON.stringify({
          ok: true,
          online: clients.size,
          tools: harness.tools.names(),
          models: harness.catalog.list(),
          defaultModel: harness.catalog.defaultRef(),
          telegram: config.telegram ? config.telegram.allowedChatIds.length : 0,
          line: line?.status() ?? null,
          extensionWrites: config.agentExtensionWrites,
          extensions: harness.extensions?.summary() ?? null,
          diagnostics: diagnostics(),
          approvals: approvals?.list().length ?? 0,
        }),
      );
      return;
    }

    // Art upload goes straight into board/assets/<kind>/, which the office asset
    // scan already reads, so a new scene or character needs no code change.
    if (url.pathname === "/api/assets" && req.method === "POST") {
      void (async () => {
        const token = bearer(req.headers.authorization) || (url.searchParams.get("token") ?? "");
        if (!safeEqual(token, config.gatewayToken)) {
          res.writeHead(401, { "content-type": "application/json" });
          res.end(JSON.stringify({ ok: false, error: "unauthorized" }));
          return;
        }
        const kind = (url.searchParams.get("kind") ?? "").toLowerCase();
        const folder = UPLOAD_KINDS[kind];
        if (!folder) {
          res.writeHead(400, { "content-type": "application/json" });
          res.end(JSON.stringify({ ok: false, error: "kind must be scenes, characters or props" }));
          return;
        }
        const original = url.searchParams.get("name") ?? "";
        const ext = path.extname(original).toLowerCase();
        const allowed = kind === "props" ? new Set([...UPLOAD_IMAGE_EXT, ".glb"]) : UPLOAD_IMAGE_EXT;
        if (!allowed.has(ext)) {
          res.writeHead(415, { "content-type": "application/json" });
          res.end(JSON.stringify({ ok: false, error: `นามสกุล ${ext || "(ไม่มี)"} ไม่รองรับ` }));
          return;
        }
        const base = path
          .basename(original, ext)
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, "-")
          .replace(/^-+|-+$/g, "")
          .slice(0, 48);
        const file = `${base || "upload"}-${Date.now().toString(36)}${ext}`;
        const bytes = await readUpload(req);
        if (bytes.length === 0) {
          res.writeHead(400, { "content-type": "application/json" });
          res.end(JSON.stringify({ ok: false, error: "ไฟล์ว่าง" }));
          return;
        }
        const target = path.join(config.boardDir, "assets", folder, file);
        await mkdir(path.dirname(target), { recursive: true });
        await writeFile(target, bytes);
        // New art has to reach open boards without a reload.
        await broadcastAgents();
        const image = `/assets/${folder}/${encodeURIComponent(file)}`;
        log.info(`uploaded ${kind}/${file} (${Math.round(bytes.length / 1024)} KB)`);
        res.writeHead(201, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true, image, kind, bytes: bytes.length }));
      })().catch((error: Error) => {
        log.warn(`upload failed: ${error.message}`);
        if (!res.headersSent) res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: error.message }));
      });
      return;
    }

    if (req.method === "GET" && serveStatic(url.pathname, res)) return;

    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    res.end("Not found");
  });

  server.on("upgrade", (req: import("node:http").IncomingMessage, socket: Duplex, head: Buffer) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    if (url.pathname !== "/ws") {
      socket.write("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }
    const token = url.searchParams.get("token") ?? bearer(req.headers.authorization);
    if (!token || !safeEqual(token, config.gatewayToken)) {
      log.warn("rejected board connection: invalid gateway token");
      socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
  });

  return {
    server,
    broadcast,
    agents,
    async start(port = config.port, host = config.host): Promise<number> {
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, host, () => {
          server.removeListener("error", reject);
          resolve();
        });
      });
      const address = server.address();
      return typeof address === "object" && address ? address.port : port;
    },
    async stop(): Promise<void> {
      for (const client of clients) client.terminate();
      await new Promise<void>((resolve) => wss.close(() => resolve()));
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

export type Gateway = ReturnType<typeof createGateway>;
