import type { ApprovalQueue, ApprovalRequest } from "./approvals.js";
import type { ExtensionManager } from "./index.js";

const ID_PREFIX = 8;
/** Short ids are what a person types in a chat; full UUIDs are for the board. */
const ID_ARG = /^[0-9a-f][0-9a-f-]{3,35}$/i;

export type ApprovalOutcome = {
  ok: boolean;
  /** The request that was resolved, when one matched. */
  id: string | null;
  message: string;
};

export type ApprovalCommand =
  | { kind: "list" }
  | { kind: "approve"; id: string }
  | { kind: "reject"; id: string };

const LIST_WORDS = ["approvals", "approval", "pending", "รออนุมัติ", "คำขออนุมัติ"];
const APPROVE_WORDS = ["approve", "อนุมัติ"];
const REJECT_WORDS = ["reject", "ปฏิเสธ"];

export function shortApprovalId(id: string): string {
  return id.slice(0, ID_PREFIX);
}

export function describeApproval(request: ApprovalRequest): string {
  const label = request.name ? `${request.action} "${request.name}"` : request.action;
  return `${label} (${request.agentId ?? request.sessionId})`;
}

/**
 * Chat-safe command parser shared by Telegram and LINE. `/approvals`,
 * `approve 1a2b3c4d` and the Thai equivalents all work; a sentence like
 * "approve the plan" is not a command, because the argument must look like
 * a request id.
 */
export function parseApprovalCommand(text: string): ApprovalCommand | null {
  const trimmed = text.trim().replace(/^\/+/, "");
  if (!trimmed) return null;
  const [rawWord, ...rest] = trimmed.split(/\s+/);
  const word = (rawWord ?? "").toLowerCase();
  const argument = rest.join(" ").trim();
  if (LIST_WORDS.includes(word) && !argument) return { kind: "list" };
  if (!ID_ARG.test(argument)) return null;
  if (APPROVE_WORDS.includes(word)) return { kind: "approve", id: argument };
  if (REJECT_WORDS.includes(word)) return { kind: "reject", id: argument };
  return null;
}

/**
 * One place to list, approve and reject extension requests, so the board, the
 * Telegram bot and the LINE bot all resolve the same in-memory queue.
 */
export class ApprovalService {
  constructor(
    private readonly approvals: ApprovalQueue,
    private readonly manager: () => ExtensionManager | null,
  ) {}

  list(): ApprovalRequest[] {
    return this.approvals.list();
  }

  formatList(): string {
    const pending = this.list();
    if (pending.length === 0) return "ไม่มีคำขออนุมัติที่รออยู่";
    return [
      `คำขออนุมัติ ${pending.length} รายการที่รออยู่:`,
      ...pending.map((request, index) => `${index + 1}. ${describeApproval(request)} · id ${shortApprovalId(request.id)}`),
      "",
      "approve <id> เพื่ออนุมัติ · reject <id> เพื่อปฏิเสธ",
    ].join("\n");
  }

  notification(request: ApprovalRequest): string {
    const id = shortApprovalId(request.id);
    const minutes = Math.max(1, Math.round((Date.parse(request.expiresAt) - Date.now()) / 60_000));
    return [
      "🔔 ขออนุมัติจากเอเจนต์",
      describeApproval(request),
      `id: ${id} (หมดอายุใน ~${minutes} นาที)`,
      `อนุมัติ: approve ${id}`,
      `ปฏิเสธ: reject ${id}`,
    ].join("\n");
  }

  /** Exact UUID or a unique short prefix, so a chat user never types 36 characters. */
  resolve(raw: string): ApprovalRequest | null {
    const key = raw.trim().toLowerCase();
    if (!key) return null;
    const pending = this.list();
    const exact = pending.find((request) => request.id.toLowerCase() === key);
    if (exact) return exact;
    const matches = pending.filter((request) => request.id.toLowerCase().startsWith(key));
    return matches.length === 1 ? matches[0] : null;
  }

  async approve(raw: string): Promise<ApprovalOutcome> {
    const found = this.resolve(raw);
    if (!found) {
      return { ok: false, id: null, message: "ไม่พบคำขอที่รออนุมัติ (อาจหมดอายุหรือถูกตัดสินไปแล้ว)" };
    }
    const request = this.approvals.approve(found.id);
    if (!request) return { ok: false, id: found.id, message: "คำขอนี้ถูกตัดสินไปแล้ว" };
    const manager = this.manager();
    if (!manager) return { ok: false, id: request.id, message: "extension system ไม่พร้อมใช้งาน" };
    try {
      const message = await manager.applyApproved(request);
      return { ok: true, id: request.id, message };
    } catch (error) {
      return { ok: false, id: request.id, message: (error as Error).message };
    }
  }

  reject(raw: string): ApprovalOutcome {
    const found = this.resolve(raw);
    if (!found) {
      return { ok: false, id: null, message: "ไม่พบคำขอที่รออนุมัติ (อาจหมดอายุหรือถูกตัดสินไปแล้ว)" };
    }
    const request = this.approvals.reject(found.id);
    if (!request) return { ok: false, id: found.id, message: "คำขอนี้ถูกตัดสินไปแล้ว" };
    return { ok: true, id: request.id, message: `ปฏิเสธคำขอ ${describeApproval(request)} แล้ว` };
  }
}
