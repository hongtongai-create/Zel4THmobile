import type { AgentHarness } from "../agent.js";
import type { TelegramConfig } from "../config.js";
import { parseApprovalCommand, type ApprovalCommand, type ApprovalService } from "../extensions/approval-service.js";
import type { Logger } from "../log.js";

type TelegramUpdate = {
  update_id: number;
  message?: {
    message_id: number;
    chat: { id: number; type: string; title?: string; username?: string };
    from?: { id: number; first_name?: string; username?: string };
    text?: string;
  };
};

const MAX_TELEGRAM_LENGTH = 4000;

function chunk(text: string, size = MAX_TELEGRAM_LENGTH): string[] {
  const parts: string[] = [];
  let rest = text;
  while (rest.length > size) {
    let cut = rest.lastIndexOf("\n", size);
    if (cut < size * 0.5) cut = size;
    parts.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^\n+/, "");
  }
  if (rest.trim()) parts.push(rest);
  return parts;
}

export type TelegramChannelOptions = {
  /** When set, an allowed chat can list, approve and reject extension requests. */
  approvals?: ApprovalService;
};

export class TelegramChannel {
  private readonly cfg: TelegramConfig;
  private readonly harness: AgentHarness;
  private readonly log: Logger;
  private readonly approvals: ApprovalService | null;
  private running = false;
  private offset = 0;
  private loop: Promise<void> | null = null;

  constructor(
    cfg: TelegramConfig,
    harness: AgentHarness,
    log: Logger,
    options: TelegramChannelOptions = {},
  ) {
    this.cfg = cfg;
    this.harness = harness;
    this.log = log;
    this.approvals = options.approvals ?? null;
  }

  private async api<T>(method: string, body: Record<string, unknown>): Promise<T> {
    const response = await fetch(`https://api.telegram.org/bot${this.cfg.botToken}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(60_000),
    });
    const text = await response.text();
    let parsed: { ok?: boolean; result?: T; description?: string };
    try {
      parsed = JSON.parse(text) as { ok?: boolean; result?: T; description?: string };
    } catch {
      throw new Error(`Telegram ${method} returned non-JSON: ${text.slice(0, 200)}`);
    }
    if (!response.ok || !parsed.ok) {
      throw new Error(`Telegram ${method} failed: ${parsed.description ?? text.slice(0, 200)}`);
    }
    return parsed.result as T;
  }

  private isAllowed(chatId: string): boolean {
    return this.cfg.allowedChatIds.includes(chatId);
  }

  async sendText(chatId: string, text: string): Promise<void> {
    for (const part of chunk(text)) {
      await this.api("sendMessage", { chat_id: chatId, text: part, disable_web_page_preview: true });
    }
  }

  private async runApproval(command: ApprovalCommand): Promise<string> {
    const approvals = this.approvals;
    if (!approvals) return "ระบบอนุมัติไม่พร้อมใช้งาน";
    if (command.kind === "list") return approvals.formatList();
    const outcome = command.kind === "approve" ? await approvals.approve(command.id) : approvals.reject(command.id);
    return `${outcome.ok ? "✅" : "⚠️"} ${outcome.message}`;
  }

  private async handleText(chatId: string, text: string): Promise<void> {
    const sessionId = `telegram:${chatId}`;

    // Approval commands belong to the operator, not the model.
    const approvalCommand = this.approvals ? parseApprovalCommand(text) : null;
    if (approvalCommand) {
      await this.sendText(chatId, await this.runApproval(approvalCommand));
      return;
    }

    if (!text.startsWith("/")) {
      const typing = setInterval(() => {
        void this.api("sendChatAction", { chat_id: chatId, action: "typing" }).catch(() => undefined);
      }, 4500);
      void this.api("sendChatAction", { chat_id: chatId, action: "typing" }).catch(() => undefined);
      try {
        const result = await this.harness.run(sessionId, "telegram", text);
        await this.sendText(chatId, result.text || "(the agent finished without a reply)");
      } catch (error) {
        await this.sendText(chatId, `Agent error: ${(error as Error).message}`);
      } finally {
        clearInterval(typing);
      }
      return;
    }

    const [rawCommand, ...rest] = text.split(/\s+/);
    const command = (rawCommand ?? "").split("@")[0].toLowerCase();
    const argument = rest.join(" ").trim();

    switch (command) {
      case "/start":
      case "/help":
        await this.sendText(
          chatId,
          [
            "Agent ready.",
            "",
            "/approvals - extension changes waiting for your approval",
            "/approve <id> - approve one, /reject <id> - reject one",
            "/model - show the current model",
            "/model <provider:model> - switch model",
            "/models - list available models",
            "/reset - clear this conversation",
            "/status - tools and session info",
            "",
            "Anything else is sent to the agent.",
          ].join("\n"),
        );
        return;

      case "/models": {
        const models = this.harness.catalog.list();
        if (models.length === 0) {
          await this.sendText(chatId, "No models configured. Set a provider key in .env");
          return;
        }
        await this.sendText(chatId, models.map((model) => `${model.default ? "* " : "  "}${model.ref}`).join("\n"));
        return;
      }

      case "/model": {
        if (!argument) {
          const session = await this.harness.store.get(sessionId);
          await this.sendText(
            chatId,
            `Current model: ${session?.model ?? this.harness.catalog.defaultRef() ?? "(none)"}`,
          );
          return;
        }
        const session = await this.harness.setModel(sessionId, "telegram", argument);
        await this.sendText(chatId, `Model set to ${session.model}`);
        return;
      }

      case "/reset":
        await this.harness.reset(sessionId);
        await this.sendText(chatId, "Conversation cleared.");
        return;

      case "/status": {
        const session = await this.harness.store.get(sessionId);
        const tools = this.harness.tools.names();
        await this.sendText(
          chatId,
          [
            `model: ${session?.model ?? this.harness.catalog.defaultRef() ?? "(none)"}`,
            `messages: ${session?.messages.length ?? 0}`,
            `tools: ${tools.length ? tools.join(", ") : "none"}`,
          ].join("\n"),
        );
        return;
      }

      default:
        await this.sendText(chatId, `Unknown command ${command}. Try /help`);
    }
  }

  private async poll(): Promise<void> {
    while (this.running) {
      try {
        const updates = await this.api<TelegramUpdate[]>("getUpdates", {
          offset: this.offset,
          timeout: 30,
          allowed_updates: ["message"],
        });
        for (const update of updates) {
          this.offset = Math.max(this.offset, update.update_id + 1);
          const message = update.message;
          if (!message?.text) continue;
          const chatId = String(message.chat.id);
          if (!this.isAllowed(chatId)) {
            this.log.warn(`ignoring telegram chat ${chatId} (not in TELEGRAM_ALLOWED_CHAT_IDS)`);
            continue;
          }
          this.log.info(`telegram message from ${chatId}`);
          await this.handleText(chatId, message.text);
        }
      } catch (error) {
        if (!this.running) return;
        this.log.error(`telegram poll error: ${(error as Error).message}`);
        await new Promise((resolve) => setTimeout(resolve, 3000));
      }
    }
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.log.info(
      `telegram channel started (allowed chats: ${this.cfg.allowedChatIds.join(", ") || "none - set TELEGRAM_ALLOWED_CHAT_IDS"})`,
    );
    this.loop = this.poll();
  }

  async stop(): Promise<void> {
    this.running = false;
    await this.loop?.catch(() => undefined);
  }
}
