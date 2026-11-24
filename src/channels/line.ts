import { createHmac, timingSafeEqual } from "node:crypto";
import type { AgentHarness } from "../agent.js";
import type { AgentRegistry, AgentProfile } from "../agents.js";
import type { LineConfig } from "../config.js";
import { parseApprovalCommand, type ApprovalCommand, type ApprovalService } from "../extensions/approval-service.js";
import type { Logger } from "../log.js";

type LineEvent = {
  type?: string;
  webhookEventId?: string;
  replyToken?: string;
  timestamp?: number;
  source?: { type?: string; userId?: string; groupId?: string; roomId?: string };
  message?: { type?: string; id?: string; text?: string };
};

type LinePayload = {
  destination?: string;
  events?: LineEvent[];
};

type LineMessage = { type: "text"; text: string };

const MAX_MESSAGES = 5;
const MAX_TEXT = 4900;

export type LineChannelOptions = {
  /** When set, an allowed source can list, approve and reject extension requests. */
  approvals?: ApprovalService;
};
const SEEN_LIMIT = 500;

/** LINE signs the raw body with HMAC-SHA256 and base64-encodes the digest. */
export function verifyLineSignature(
  secret: string,
  raw: Buffer | string,
  signature: string | undefined,
): boolean {
  if (!signature) return false;
  const expected = createHmac("sha256", secret).update(raw).digest("base64");
  const left = Buffer.from(expected, "utf8");
  const right = Buffer.from(signature, "utf8");
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

function splitText(text: string): string[] {
  const parts: string[] = [];
  let rest = text.trim();
  while (rest.length > MAX_TEXT) {
    let cut = rest.lastIndexOf("\n", MAX_TEXT);
    if (cut < MAX_TEXT * 0.5) cut = MAX_TEXT;
    parts.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^\n+/, "");
  }
  if (rest) parts.push(rest);
  return parts.slice(0, MAX_MESSAGES);
}

/**
 * LINE Messaging API channel. Works exactly like Telegram: the same harness,
 * model, tools and office agents answer, only the transport differs.
 *
 * The webhook is signature-checked against the raw body, acknowledged at once,
 * and the model turn runs in the background, because LINE retries a webhook
 * that does not answer quickly.
 */
export class LineChannel {
  private readonly seen = new Set<string>();
  private readonly seenOrder: string[] = [];
  private webhookVerified = false;
  private events = 0;
  private replied = 0;
  private duplicates = 0;
  private rejected = 0;
  private failures = 0;
  private lastEventAt: string | null = null;

  private readonly approvals: ApprovalService | null;

  constructor(
    private readonly cfg: LineConfig,
    private readonly harness: AgentHarness,
    private readonly log: Logger,
    private readonly agents?: AgentRegistry,
    options: LineChannelOptions = {},
  ) {
    this.approvals = options.approvals ?? null;
  }

  get webhookPath(): string {
    return this.cfg.webhookPath;
  }

  status() {
    return {
      configured: true,
      webhookPath: this.cfg.webhookPath,
      webhookVerified: this.webhookVerified,
      agentId: this.cfg.agentId,
      allowedSources: this.cfg.allowedSourceIds.length,
      events: this.events,
      replied: this.replied,
      duplicates: this.duplicates,
      rejected: this.rejected,
      failures: this.failures,
      lastEventAt: this.lastEventAt,
    };
  }

  private remember(key: string): boolean {
    if (this.seen.has(key)) return false;
    this.seen.add(key);
    this.seenOrder.push(key);
    if (this.seenOrder.length > SEEN_LIMIT) {
      const oldest = this.seenOrder.shift();
      if (oldest) this.seen.delete(oldest);
    }
    return true;
  }

  private sourceOf(event: LineEvent): string | null {
    return event.source?.userId ?? event.source?.groupId ?? event.source?.roomId ?? null;
  }

  /** Returns the HTTP answer for the webhook; the agent turn is not awaited. */
  async handleWebhook(
    raw: Buffer,
    signature: string | undefined,
  ): Promise<{ status: number; body: string }> {
    if (!verifyLineSignature(this.cfg.channelSecret, raw, signature)) {
      this.log.warn("line webhook rejected: invalid x-line-signature");
      return { status: 403, body: JSON.stringify({ ok: false, error: "invalid signature" }) };
    }
    this.webhookVerified = true;

    let payload: LinePayload;
    try {
      payload = JSON.parse(raw.toString("utf8")) as LinePayload;
    } catch {
      return { status: 400, body: JSON.stringify({ ok: false, error: "invalid json" }) };
    }

    for (const event of payload.events ?? []) {
      if (event.type !== "message" || event.message?.type !== "text") continue;
      const text = event.message.text?.trim();
      if (!text) continue;

      const eventId = event.webhookEventId ?? event.message.id;
      if (eventId && !this.remember(eventId)) {
        this.duplicates += 1;
        this.log.info(`line webhook event ${eventId} already handled, ignored`);
        continue;
      }

      const sourceId = this.sourceOf(event);
      if (!sourceId) continue;

      if (!this.cfg.allowedSourceIds.includes(sourceId)) {
        this.rejected += 1;
        this.log.warn(`line message from ${sourceId} ignored (not in LINE_ALLOWED_SOURCE_IDS)`);
        continue;
      }

      this.events += 1;
      this.lastEventAt = new Date().toISOString();
      const approvalCommand = this.approvals ? parseApprovalCommand(text) : null;
      if (approvalCommand) {
        void this.respondApproval(sourceId, event.replyToken, approvalCommand).catch((error: Error) => {
          this.failures += 1;
          this.log.error(`line approval command failed for ${sourceId}: ${error.message}`);
        });
        continue;
      }
      void this.respond(sourceId, event.replyToken, text).catch((error: Error) => {
        this.failures += 1;
        this.log.error(`line turn failed for ${sourceId}: ${error.message}`);
      });
    }

    return { status: 200, body: JSON.stringify({ ok: true }) };
  }

  private async agentFor(): Promise<AgentProfile | null> {
    if (!this.agents) return null;
    if (this.cfg.agentId) {
      const agent = await this.agents.get(this.cfg.agentId);
      if (!agent) this.log.warn(`LINE_AGENT_ID "${this.cfg.agentId}" not found, using the default agent`);
      if (agent) return agent;
    }
    return (await this.agents.get("main")) ?? (await this.agents.list())[0] ?? null;
  }

  private async respondApproval(
    sourceId: string,
    replyToken: string | undefined,
    command: ApprovalCommand,
  ): Promise<void> {
    const approvals = this.approvals;
    if (!approvals) return;
    let reply: string;
    if (command.kind === "list") {
      reply = approvals.formatList();
    } else {
      const outcome = command.kind === "approve" ? await approvals.approve(command.id) : approvals.reject(command.id);
      reply = `${outcome.ok ? "✅" : "⚠️"} ${outcome.message}`;
    }
    await this.send(replyToken, sourceId, reply);
    this.replied += 1;
  }

  private async respond(sourceId: string, replyToken: string | undefined, text: string): Promise<void> {
    const agent = await this.agentFor();
    // A LINE chat id is never mixed with a Telegram or board conversation.
    const sessionId = `line:${sourceId}`;
    const result = await this.harness.run(sessionId, "line", text, () => {}, agent);
    const reply = result.text || "(the agent finished without a reply)";
    await this.send(replyToken, sourceId, reply);
    this.replied += 1;
  }

  /** Proactive push for approval notifications (no reply token involved). */
  async pushText(to: string, text: string): Promise<void> {
    await this.api("push", { to, messages: this.messages(text) });
  }

  private async send(replyToken: string | undefined, sourceId: string, reply: string): Promise<void> {
    if (replyToken) {
      try {
        await this.api("reply", { replyToken, messages: this.messages(reply) });
        return;
      } catch (error) {
        // Reply tokens expire; pushing is the documented fallback.
        this.log.warn(`line reply token unusable (${(error as Error).message}), falling back to push`);
      }
    }

    await this.api("push", { to: sourceId, messages: this.messages(reply) });
  }

  private messages(text: string): LineMessage[] {
    return splitText(text).map((part) => ({ type: "text", text: part }));
  }

  private async api(method: "reply" | "push", body: Record<string, unknown>): Promise<void> {
    const response = await fetch(`${this.cfg.apiBaseUrl}/v2/bot/message/${method}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.cfg.channelAccessToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) {
      const detail = (await response.text().catch(() => "")).slice(0, 200);
      throw new Error(`LINE ${method} HTTP ${response.status}${detail ? `: ${detail}` : ""}`);
    }
  }
}
