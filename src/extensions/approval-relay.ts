import type { Logger } from "../log.js";
import type { ApprovalQueue } from "./approvals.js";
import type { ApprovalService } from "./approval-service.js";

export type ApprovalSender = (text: string) => Promise<void>;

/**
 * Pushes new approval requests into the chat channels, so an operator who is
 * not looking at the board still sees them. Each request is announced once;
 * approving or rejecting from any surface removes it from every surface.
 */
export class ApprovalRelay {
  private readonly senders = new Map<string, ApprovalSender>();
  private readonly announced = new Set<string>();
  private unsubscribe: (() => void) | null = null;
  private chain: Promise<void> = Promise.resolve();

  constructor(
    private readonly approvals: ApprovalQueue,
    private readonly service: ApprovalService,
    private readonly log: Logger,
  ) {}

  addSender(id: string, send: ApprovalSender): void {
    this.senders.set(id, send);
    this.announcePending();
  }

  start(): void {
    this.unsubscribe ??= this.approvals.onChange(() => this.announcePending());
    this.announcePending();
  }

  stop(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
  }

  private announcePending(): void {
    const fresh = this.service.list().filter((request) => !this.announced.has(request.id));
    if (fresh.length === 0) return;
    for (const request of fresh) this.announced.add(request.id);
    const text = fresh.map((request) => this.service.notification(request)).join("\n\n");
    this.chain = this.chain
      .then(async () => {
        for (const [id, send] of this.senders) {
          try {
            await send(text);
          } catch (error) {
            this.log.warn(`could not notify ${id} about an approval request: ${(error as Error).message}`);
          }
        }
      })
      .catch(() => undefined);
  }

  /** Waits for queued notifications; used by tests and shutdown. */
  async idle(): Promise<void> {
    await this.chain;
  }
}
