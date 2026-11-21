import { createHash, timingSafeEqual } from "node:crypto";
import { createReadStream, existsSync, statSync } from "node:fs";
import { createServer, type Server } from "node:http";
import path from "node:path";
import type { Duplex } from "node:stream";
import { WebSocket, WebSocketServer } from "ws";
import type { AgentHarness } from "../agent.js";
import type { Config } from "../config.js";
import type { Logger } from "../log.js";
import type { AgentEvent, SessionChannel } from "../types.js";

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
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
};

type ClientMessage = Record<string, unknown> & { type?: unknown };

const SESSION_ID_PATTERN = /^[A-Za-z0-9._:-]{1,120}$/;

export function createGateway(options: GatewayOptions) {
  const { config, harness, log } = options;

  const clients = new Set<WebSocket>();
  const wss = new WebSocketServer({ noServer: true });

  function broadcast(payload: unknown): void {
    const data = JSON.stringify(payload);
    for (const client of clients) {
      if (client.readyState === WebSocket.OPEN) client.send(data);
    }
  }

  function send(socket: WebSocket, payload: unknown): void {
    if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(payload));
  }

  function onAgentEvent(socket: WebSocket | null): (event: AgentEvent) => void {
    return (event) => {
      const payload = { type: "event", event };
      if (socket) send(socket, payload);
      else broadcast(payload);
    };
  }

  function channelFor(sessionId: string): SessionChannel {
    if (sessionId.startsWith("telegram:")) return "telegram";
    if (sessionId.startsWith("cli:")) return "cli";
    return "board";
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
          const sessionId = typeof msg.sessionId === "string" ? msg.sessionId : "";
          if (!SESSION_ID_PATTERN.test(sessionId)) {
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
          const sessionId = typeof msg.sessionId === "string" ? msg.sessionId : "";
          if (!SESSION_ID_PATTERN.test(sessionId)) {
            send(socket, { type: "error", message: "Invalid sessionId." });
            return;
          }
          await harness.reset(sessionId);
          send(socket, { type: "session.reset", sessionId });
          return;
        }

        case "model.set": {
          const sessionId = typeof msg.sessionId === "string" ? msg.sessionId : "";
          const model = typeof msg.model === "string" ? msg.model : "";
          if (!SESSION_ID_PATTERN.test(sessionId)) {
            send(socket, { type: "error", message: "Invalid sessionId." });
            return;
          }
          const session = await harness.setModel(sessionId, channelFor(sessionId), model);
          send(socket, { type: "model.set", sessionId, model: session.model });
          return;
        }

        case "chat.send": {
          const sessionId = typeof msg.sessionId === "string" ? msg.sessionId : "";
          const text = typeof msg.text === "string" ? msg.text.trim() : "";
          if (!SESSION_ID_PATTERN.test(sessionId)) {
            send(socket, { type: "error", message: "Invalid sessionId." });
            return;
          }
          if (!text) {
            send(socket, { type: "error", message: "Message text is empty." });
            return;
          }
          const emit = onAgentEvent(null);
          harness
            .run(sessionId, channelFor(sessionId), text, emit)
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

    send(socket, {
      type: "ready",
      agent: "clawgate",
      tools: harness.tools.names(),
      defaultModel: harness.catalog.defaultRef(),
      models: harness.catalog.list(),
      extensions: harness.extensions?.summary() ?? null,
    });

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

    if (url.pathname === "/api/health") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, agent: "clawgate", online: clients.size }));
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
        }),
      );
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
