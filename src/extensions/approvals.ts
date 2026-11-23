import { randomUUID } from "node:crypto";

export type ApprovalAction = "install" | "remove" | "reload";
export type ApprovalStatus = "pending" | "approved" | "rejected" | "expired";

export type ApprovalRequest = {
  id: string;
  action: ApprovalAction;
  name: string;
  url?: string;
  sessionId: string;
  agentId: string | null;
  createdAt: string;
  expiresAt: string;
  status: ApprovalStatus;
};

export type ApprovalInput = {
  action: ApprovalAction;
  name?: string;
  url?: string;
  sessionId: string;
  agentId?: string | null;
};

const DEFAULT_TTL_MS = 10 * 60_000;
const MAX_RECORDS = 100;

/**
 * Extension changes proposed by an agent are queued here and never executed
 * until an operator approves them on the board. The queue is in memory on
 * purpose: a restart drops pending requests, which is the safe failure mode.
 */
export class ApprovalQueue {
  private readonly requests = new Map<string, ApprovalRequest>();
  private readonly listeners = new Set<(pending: ApprovalRequest[]) => void>();

  constructor(private readonly ttlMs = DEFAULT_TTL_MS) {}

  onChange(listener: (pending: ApprovalRequest[]) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  request(input: ApprovalInput): ApprovalRequest {
    const now = new Date();
    const request: ApprovalRequest = {
      id: randomUUID(),
      action: input.action,
      name: (input.name ?? "").trim(),
      url: input.url,
      sessionId: input.sessionId,
      agentId: input.agentId ?? null,
      createdAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + this.ttlMs).toISOString(),
      status: "pending",
    };
    this.requests.set(request.id, request);
    this.trim();
    this.emit();
    return request;
  }

  /** Pending requests, newest last. Expired ones are marked and left out. */
  list(includeResolved = false): ApprovalRequest[] {
    this.expire();
    return [...this.requests.values()]
      .filter((request) => includeResolved || request.status === "pending")
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  get(id: string): ApprovalRequest | null {
    this.expire();
    return this.requests.get(id) ?? null;
  }

  approve(id: string): ApprovalRequest | null {
    const request = this.get(id);
    if (!request || request.status !== "pending") return null;
    request.status = "approved";
    this.emit();
    return request;
  }

  reject(id: string): ApprovalRequest | null {
    const request = this.get(id);
    if (!request || request.status !== "pending") return null;
    request.status = "rejected";
    this.emit();
    return request;
  }

  private expire(): void {
    const now = Date.now();
    for (const request of this.requests.values()) {
      if (request.status === "pending" && Date.parse(request.expiresAt) <= now) {
        request.status = "expired";
      }
    }
  }

  private trim(): void {
    if (this.requests.size <= MAX_RECORDS) return;
    for (const [id, request] of this.requests) {
      if (request.status !== "pending") this.requests.delete(id);
      if (this.requests.size <= MAX_RECORDS) break;
    }
  }

  private emit(): void {
    const pending = this.list();
    for (const listener of this.listeners) listener(pending);
  }
}
