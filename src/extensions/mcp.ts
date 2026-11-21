import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { readFile } from "node:fs/promises";
import { createInterface } from "node:readline";
import type { Logger } from "../log.js";
import type { Tool } from "../tools/index.js";
import type { McpServerConfig } from "./types.js";

const PROTOCOL_VERSION = "2024-11-05";
const REQUEST_TIMEOUT_MS = 30_000;
const TOOL_TIMEOUT_MS = 180_000;

type JsonRpcError = { code?: number; message?: string };
type JsonRpcFrame = {
  id?: number | string;
  method?: string;
  result?: unknown;
  error?: JsonRpcError;
};

type McpToolInfo = {
  name?: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
};

type McpCallResult = {
  content?: Array<{ type?: string; text?: string }>;
  isError?: boolean;
};

type Pending = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
};

/** One MCP server process, spoken to over newline-delimited JSON-RPC on stdio. */
export class McpClient {
  private child: ChildProcessWithoutNullStreams | null = null;
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private tools: McpToolInfo[] = [];
  private closing = false;

  constructor(
    readonly name: string,
    private readonly config: McpServerConfig,
    private readonly log: Logger,
  ) {}

  async start(): Promise<void> {
    const child = spawn(this.config.command, this.config.args ?? [], {
      cwd: this.config.cwd,
      env: { ...process.env, ...this.config.env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child = child;

    child.on("error", (error) => {
      this.failAll(new Error(`MCP server "${this.name}" could not start: ${error.message}`));
    });
    child.on("exit", (code, signal) => {
      if (!this.closing) {
        this.failAll(new Error(`MCP server "${this.name}" exited (code ${code ?? "null"}, signal ${signal ?? "none"})`));
      }
    });

    const stdout = createInterface({ input: child.stdout });
    stdout.on("line", (line) => this.onLine(line));

    const stderr = createInterface({ input: child.stderr });
    stderr.on("line", (line) => {
      if (line.trim()) this.log.debug(`mcp[${this.name}] ${line.slice(0, 300)}`);
    });

    await this.request("initialize", {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: "clawgate", version: "0.1.0" },
    });
    this.notify("notifications/initialized", {});

    const listed = (await this.request("tools/list", {})) as { tools?: McpToolInfo[] };
    this.tools = Array.isArray(listed.tools) ? listed.tools : [];
  }

  toolInfos(): McpToolInfo[] {
    return this.tools;
  }

  async callTool(tool: string, args: Record<string, unknown>): Promise<string> {
    const result = (await this.request("tools/call", { name: tool, arguments: args }, TOOL_TIMEOUT_MS)) as McpCallResult;
    const text = (result.content ?? [])
      .map((part) => (typeof part.text === "string" ? part.text : ""))
      .filter(Boolean)
      .join("\n");
    if (result.isError) {
      throw new Error(text || `MCP tool "${tool}" reported an error`);
    }
    return text || "(no content)";
  }

  async close(): Promise<void> {
    this.closing = true;
    this.failAll(new Error(`MCP server "${this.name}" closed`));
    const child = this.child;
    this.child = null;
    if (!child) return;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        resolve();
      }, 2000);
      child.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
      child.kill("SIGTERM");
    });
  }

  private notify(method: string, params: Record<string, unknown>): void {
    const child = this.child;
    if (!child) return;
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);
  }

  private request(method: string, params: Record<string, unknown>, timeoutMs = REQUEST_TIMEOUT_MS): Promise<unknown> {
    const child = this.child;
    if (!child) return Promise.reject(new Error(`MCP server "${this.name}" is not running`));

    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`MCP request "${method}" to "${this.name}" timed out`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
  }

  private onLine(line: string): void {
    const trimmed = line.trim();
    if (!trimmed) return;
    let frame: JsonRpcFrame;
    try {
      frame = JSON.parse(trimmed) as JsonRpcFrame;
    } catch {
      this.log.debug(`mcp[${this.name}] non-JSON output: ${trimmed.slice(0, 200)}`);
      return;
    }
    if (typeof frame.id !== "number") return;
    const pending = this.pending.get(frame.id);
    if (!pending) return;
    this.pending.delete(frame.id);
    clearTimeout(pending.timer);
    if (frame.error) {
      pending.reject(new Error(`MCP error ${frame.error.code ?? ""}: ${frame.error.message ?? "unknown"}`.trim()));
      return;
    }
    pending.resolve(frame.result);
  }

  private failAll(error: Error): void {
    for (const [id, pending] of this.pending) {
      this.pending.delete(id);
      clearTimeout(pending.timer);
      pending.reject(error);
    }
  }
}

function sanitizeToolName(value: string): string {
  return value.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 60);
}

export type McpRuntime = {
  name: string;
  client: McpClient;
  tools: Tool[];
};

function wrapTool(runtime: { name: string; client: McpClient }, info: McpToolInfo): Tool | null {
  const original = info.name;
  if (!original) return null;
  const name = sanitizeToolName(`${runtime.name}__${original}`);
  return {
    name,
    description: `${info.description ?? original} (MCP server: ${runtime.name}, tool: ${original})`,
    parameters: info.inputSchema ?? { type: "object", properties: {} },
    handler: (args) => runtime.client.callTool(original, args),
  };
}

export async function startMcpServers(
  servers: Record<string, McpServerConfig>,
  log: Logger,
): Promise<McpRuntime[]> {
  const runtimes: McpRuntime[] = [];
  for (const [name, config] of Object.entries(servers)) {
    if (!config || typeof config.command !== "string" || !config.command.trim()) {
      log.warn(`MCP server "${name}" has no command, skipped`);
      continue;
    }
    const client = new McpClient(name, config, log);
    try {
      await client.start();
    } catch (error) {
      log.warn(`MCP server "${name}" unavailable: ${(error as Error).message}`);
      await client.close().catch(() => undefined);
      continue;
    }
    const tools = client
      .toolInfos()
      .map((info) => wrapTool({ name, client }, info))
      .filter((tool): tool is Tool => tool !== null);
    log.info(`MCP server "${name}" ready with ${tools.length} tool(s)`);
    runtimes.push({ name, client, tools });
  }
  return runtimes;
}

/** Reads `extensions/mcp.json` (Claude-style `mcpServers` map); missing file means none. */
export async function loadMcpConfig(file: string): Promise<Record<string, McpServerConfig>> {
  let raw: string;
  try {
    raw = await readFile(file, "utf8");
  } catch {
    return {};
  }
  const parsed = JSON.parse(raw) as { mcpServers?: Record<string, McpServerConfig> };
  return parsed.mcpServers && typeof parsed.mcpServers === "object" ? parsed.mcpServers : {};
}
