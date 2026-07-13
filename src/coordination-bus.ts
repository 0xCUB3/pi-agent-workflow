import { randomUUID } from "node:crypto";

export type IrcMessage = { id: string; from: string; to: string; body: string; replyTo?: string; ts: number };
export type IrcReceipt = { messageId: string; to: string; outcome: "queued" | "consumed" | "injected" | "woken" | "revived" | "failed"; error?: string };
type Waiter = { from?: string; resolve: (message: IrcMessage | undefined) => void; timer?: ReturnType<typeof setTimeout>; abort?: () => void; signal?: AbortSignal };

const BUS_KEY = Symbol.for("pi-agent-workflow.coordination-bus.v1");
type GlobalBus = typeof globalThis & { [BUS_KEY]?: CoordinationBus };

export class CoordinationBus {
  private readonly mailboxes = new Map<string, IrcMessage[]>();
  private readonly waiters = new Map<string, Waiter[]>();

  publish(input: Omit<IrcMessage, "id" | "ts">): { message: IrcMessage; consumed: boolean } {
    const message: IrcMessage = { ...input, id: `m${randomUUID().slice(0, 10)}`, ts: Date.now() };
    const waiters = this.waiters.get(message.to) ?? [];
    const index = waiters.findIndex((waiter) => !waiter.from || waiter.from === message.from);
    if (index >= 0) {
      const [waiter] = waiters.splice(index, 1);
      if (!waiters.length) this.waiters.delete(message.to);
      this.finishWaiter(waiter, message);
      return { message, consumed: true };
    }
    const mailbox = this.mailboxes.get(message.to) ?? [];
    mailbox.push(message);
    // Bound stale traffic while preserving enough history for real coordination.
    if (mailbox.length > 200) mailbox.splice(0, mailbox.length - 200);
    this.mailboxes.set(message.to, mailbox);
    return { message, consumed: false };
  }

  inbox(to: string, options: { from?: string; peek?: boolean; limit?: number } = {}): IrcMessage[] {
    const mailbox = this.mailboxes.get(to) ?? [];
    const selected: IrcMessage[] = [];
    const retained: IrcMessage[] = [];
    const limit = Math.max(1, options.limit ?? 200);
    for (const message of mailbox) {
      if (selected.length < limit && (!options.from || message.from === options.from)) selected.push(message);
      else retained.push(message);
    }
    if (!options.peek) {
      if (retained.length) this.mailboxes.set(to, retained);
      else this.mailboxes.delete(to);
    }
    return selected;
  }

  unread(to: string): number { return this.mailboxes.get(to)?.length ?? 0; }

  consume(to: string, messageId: string): void {
    const mailbox = this.mailboxes.get(to);
    if (!mailbox) return;
    const retained = mailbox.filter((message) => message.id !== messageId);
    if (retained.length) this.mailboxes.set(to, retained);
    else this.mailboxes.delete(to);
  }

  wait(to: string, options: { from?: string; timeoutMs?: number; signal?: AbortSignal; drainPending?: boolean } = {}): Promise<IrcMessage | undefined> {
    if (options.drainPending !== false) {
      const pending = this.inbox(to, { from: options.from, limit: 1 });
      if (pending[0]) return Promise.resolve(pending[0]);
    }
    if (options.signal?.aborted) return Promise.resolve(undefined);
    return new Promise((resolve) => {
      const waiter: Waiter = { from: options.from, resolve, signal: options.signal };
      const timeoutMs = options.timeoutMs ?? 120_000;
      if (timeoutMs > 0) { waiter.timer = setTimeout(() => this.removeWaiter(to, waiter), timeoutMs); waiter.timer.unref?.(); }
      waiter.abort = () => this.removeWaiter(to, waiter);
      options.signal?.addEventListener("abort", waiter.abort, { once: true });
      const waiters = this.waiters.get(to) ?? [];
      waiters.push(waiter);
      this.waiters.set(to, waiters);
    });
  }

  private removeWaiter(to: string, waiter: Waiter): void {
    const waiters = this.waiters.get(to);
    if (!waiters) return;
    const index = waiters.indexOf(waiter);
    if (index < 0) return;
    waiters.splice(index, 1);
    if (!waiters.length) this.waiters.delete(to);
    this.finishWaiter(waiter, undefined);
  }

  private finishWaiter(waiter: Waiter, message: IrcMessage | undefined): void {
    if (waiter.timer) clearTimeout(waiter.timer);
    if (waiter.abort) waiter.signal?.removeEventListener("abort", waiter.abort);
    waiter.resolve(message);
  }
}

export function coordinationBus(): CoordinationBus {
  const root = globalThis as GlobalBus;
  const existing = root[BUS_KEY];
  if (existing) {
    if (Object.getPrototypeOf(existing) !== CoordinationBus.prototype) Object.setPrototypeOf(existing, CoordinationBus.prototype);
    return existing;
  }
  return root[BUS_KEY] = new CoordinationBus();
}