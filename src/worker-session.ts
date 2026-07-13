import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdir, readdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { RpcClient } from "@earendil-works/pi-coding-agent";
import type { ChildResult, UsageTotals, WorkerControl } from "./types.js";

export type SessionLifecycle = "starting" | "running" | "idle" | "parked" | "aborted";

export type CoordinationRequest = { id: string; workerId?: string; type: "list" | "send" | "inbox" | "wait" | "resource" | "spawn"; target?: string; uri?: string; message?: string; replyTo?: string; awaitReply?: boolean; timeoutMs?: number; from?: string; peek?: boolean; task?: string; agent?: string; name?: string; isolated?: boolean };
export type CoordinationResponse = { ok: boolean; result?: unknown; error?: string; jobId?: string };

export type SessionEventCallbacks = {
  onEvent: (event: string, details?: unknown) => void;
  onWorkerMessage?: (message: string, kind: "update" | "ask" | "peer") => void;
  onPreview?: (preview: string | undefined) => void;
  onCoordination?: (request: CoordinationRequest, signal: AbortSignal | undefined) => Promise<CoordinationResponse>;
};

export type SessionProtocol = {
  continuationPrompt: (stdout: string, task?: string) => string;
  structuredYield: (stdout: string) => { output: string; status: "completed" | "blocked" } | undefined;
  textOutput: (stdout: string) => string;
  protocolError: (stdout: string) => string | undefined;
  livePreview: (event: unknown) => string | undefined;
  workflowUpdate: (text: string) => string | undefined;
  workerMessage: (text: string) => { kind: "ask" | "peer"; message: string; target?: string } | undefined;
};

export type WorkerSessionOptions = {
  id: string;
  cwd: string;
  args: string[];
  env: Record<string, string>;
  sessionDir: string;
  sessionFile?: string;
  ipcDir?: string;
  protocol: SessionProtocol;
};

type ActiveTurn = {
  task: string;
  startedAt: number;
  stderrStart: number;
  events: unknown[];
  usage: UsageTotals;
  requests: number;
  yielded: boolean;
  continuationNudges: number;
  timedOut: boolean;
  externallyAborted: boolean;
  softRequestBudget: number;
  budgetNoticeSent: boolean;
  budgetStopRequested: boolean;
  forcedYieldSent: boolean;
  callbacks: SessionEventCallbacks;
  resolve: (result: ChildResult) => void;
  timer: ReturnType<typeof setTimeout>;
  killTimer?: ReturnType<typeof setTimeout>;
  signal?: AbortSignal;
  abortListener?: () => void;
  coordinationController: AbortController;
};

const emptyUsage = (): UsageTotals => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 });
const contentText = (content: unknown): string => typeof content === "string" ? content : Array.isArray(content)
  ? content.filter((part) => part && typeof part === "object" && (part as { type?: string }).type === "text")
      .map((part) => String((part as { text?: string }).text ?? "")).join("\n")
  : "";

function cliPath(): string {
  const entry = import.meta.resolve("@earendil-works/pi-coding-agent");
  return join(dirname(fileURLToPath(entry)), "cli.js");
}

/** A durable Pi RPC child that can execute multiple turns in the same model context. */
export class WorkerSession {
  readonly id: string;
  readonly cwd: string;
  readonly sessionDir: string;
  sessionFile?: string;
  lifecycle: SessionLifecycle = "starting";
  lastActiveAt = Date.now();
  private readonly args: string[];
  private readonly env: Record<string, string>;
  private readonly protocol: SessionProtocol;
  private client?: RpcClient;
  private unsubscribe?: () => void;
  private turn?: ActiveTurn;
  private startPromise?: Promise<void>;
  private readonly ipcDir?: string;
  private ipcTimer?: ReturnType<typeof setInterval>;
  private ipcBusy = false;

  constructor(options: WorkerSessionOptions) {
    this.id = options.id;
    this.cwd = options.cwd;
    this.args = options.args;
    this.env = options.env;
    this.sessionDir = options.sessionDir;
    this.sessionFile = options.sessionFile;
    this.ipcDir = options.ipcDir;
    this.protocol = options.protocol;
    this.lifecycle = options.sessionFile ? "parked" : "starting";
  }

  get control(): WorkerControl {
    return {
      steer: (message) => {
        if (!this.client || this.lifecycle !== "running") return false;
        void this.client.steer(message).catch(() => {});
        return true;
      },
      followUp: (message) => {
        if (!this.client || this.lifecycle !== "running") return false;
        void this.client.followUp(message).catch(() => {});
        return true;
      },
    };
  }

  private async ensureStarted(): Promise<void> {
    if (this.client) return;
    if (this.startPromise) return this.startPromise;
    this.startPromise = (async () => {
      const persistenceArgs = this.sessionFile
        ? ["--session", this.sessionFile]
        : ["--session-dir", this.sessionDir];
      const client = new RpcClient({ cliPath: cliPath(), cwd: this.cwd, env: this.env, args: [...this.args, ...persistenceArgs] });
      this.client = client;
      this.unsubscribe = client.onEvent((event) => { void this.handleEvent(event); });
      try {
        await client.start();
        const state = await client.getState();
        this.sessionFile = state.sessionFile ?? this.sessionFile;
        this.lifecycle = "idle";
        this.startIpcMonitor();
      } catch (error) {
        this.unsubscribe?.();
        this.unsubscribe = undefined;
        this.client = undefined;
        this.lifecycle = "aborted";
        throw error;
      } finally {
        this.startPromise = undefined;
      }
    })();
    return this.startPromise;
  }

  async runTurn(prompt: string, task: string, timeoutMs: number, signal: AbortSignal | undefined, callbacks: SessionEventCallbacks, softRequestBudget = 0): Promise<ChildResult> {
    if (this.turn) throw new Error(`Worker ${this.id} already has an active turn`);
    const startedAt = Date.now();
    try {
      await this.ensureStarted();
    } catch (error) {
      return { ok: false, output: "", error: error instanceof Error ? error.message : String(error), exitCode: 1, timedOut: false, durationMs: Date.now() - startedAt, usage: emptyUsage(), requests: 0 };
    }
    if (!this.client) throw new Error(`Worker ${this.id} did not start`);
    this.lifecycle = "running";
    this.lastActiveAt = Date.now();
    callbacks.onPreview?.(undefined);
    return await new Promise<ChildResult>((resolve) => {
      const timer = setTimeout(() => this.abortActive(true), timeoutMs);
      const turn: ActiveTurn = {
        task, startedAt, stderrStart: this.client?.getStderr().length ?? 0, events: [], usage: emptyUsage(), requests: 0,
        yielded: false, continuationNudges: 0, timedOut: false, externallyAborted: false,
        softRequestBudget, budgetNoticeSent: false, budgetStopRequested: false, forcedYieldSent: false,
        callbacks, resolve, timer, signal, coordinationController: new AbortController(),
      };
      if (signal) {
        turn.abortListener = () => this.abortActive(false);
        signal.addEventListener("abort", turn.abortListener, { once: true });
      }
      this.turn = turn;
      if (signal?.aborted) {
        this.abortActive(false);
        return;
      }
      void this.client!.prompt(prompt).catch((error) => this.finishTurn(error instanceof Error ? error.message : String(error)));
    });
  }

  private startIpcMonitor(): void {
    if (!this.ipcDir || this.ipcTimer) return;
    this.ipcTimer = setInterval(() => { void this.scanIpc(); }, 75);
    this.ipcTimer.unref?.();
  }

  private async scanIpc(): Promise<void> {
    if (this.ipcBusy || !this.ipcDir) return;
    this.ipcBusy = true;
    const requestDir = join(this.ipcDir, "requests"), responseDir = join(this.ipcDir, "responses");
    try {
      await mkdir(responseDir, { recursive: true });
      const names = (await readdir(requestDir).catch(() => [])).filter((name) => name.endsWith(".json")).slice(0, 8);
      for (const name of names) {
        const path = join(requestDir, name);
        let request: CoordinationRequest;
        try { request = JSON.parse(await readFile(path, "utf8")) as CoordinationRequest; }
        catch { continue; }
        await unlink(path).catch(() => {});
        const handler = this.turn?.callbacks.onCoordination;
        let response: CoordinationResponse;
        try { response = handler ? await handler(request, this.turn?.coordinationController.signal) : { ok: false, error: "Parent coordination handler is unavailable." }; }
        catch (error) { response = { ok: false, error: error instanceof Error ? error.message : String(error) }; }
        const target = join(responseDir, `${request.id}.json`), temp = `${target}.${process.pid}.tmp`;
        await writeFile(temp, JSON.stringify(response), "utf8");
        await rename(temp, target);
      }
    } finally { this.ipcBusy = false; }
  }

  private abortActive(timedOut: boolean): void {
    const turn = this.turn;
    if (!turn) return;
    turn.timedOut ||= timedOut;
    turn.externallyAborted ||= !timedOut;
    turn.coordinationController.abort();
    this.lifecycle = "aborted";
    void this.client?.abort().catch(() => {});
    if (!turn.killTimer) turn.killTimer = setTimeout(() => {
      void this.stopClient();
      this.finishTurn(timedOut ? "worker timed out" : "worker cancelled");
    }, 2_000);
  }

  private async handleEvent(value: unknown): Promise<void> {
    const turn = this.turn;
    if (!turn || !value || typeof value !== "object") return;
    turn.events.push(value);
    const event = value as {
      type?: string; toolName?: string; args?: unknown;
      message?: { role?: string; content?: unknown; usage?: Partial<UsageTotals> & { cost?: { total?: number } }; stopReason?: string; errorMessage?: string };
      assistantMessageEvent?: { partial?: { content?: unknown } };
      attempt?: number; maxAttempts?: number; delayMs?: number; errorMessage?: string; success?: boolean; finalError?: string;
    };
    if (event.type === "tool_execution_start") {
      if (event.toolName === "workflow_yield") turn.yielded = true;
      turn.callbacks.onEvent(`tool:${event.toolName || "unknown"}`, event.args);
    } else if (event.type === "tool_execution_end") {
      turn.callbacks.onEvent(`done:${event.toolName || "unknown"}`);
    } else if (event.type === "turn_start") {
      turn.callbacks.onPreview?.(undefined);
      turn.callbacks.onEvent("thinking");
    } else if (event.type === "message_update" && event.assistantMessageEvent?.partial) {
      const update = this.protocol.workflowUpdate(contentText(event.assistantMessageEvent.partial.content));
      if (update) turn.callbacks.onWorkerMessage?.(update, "update");
      const preview = this.protocol.livePreview(event);
      if (preview) turn.callbacks.onPreview?.(preview);
    } else if (event.type === "message_end" && event.message?.role === "assistant") {
      turn.requests++;
      const usage = event.message.usage;
      if (usage) {
        for (const key of ["input", "output", "cacheRead", "cacheWrite"] as const) turn.usage[key] += Number(usage[key] ?? 0);
        turn.usage.totalTokens = turn.usage.input + turn.usage.output + turn.usage.cacheRead + turn.usage.cacheWrite;
      }
      turn.callbacks.onEvent("reporting");
      if (turn.softRequestBudget > 0 && !turn.yielded) {
        const stopAt = Math.ceil(turn.softRequestBudget * 1.5);
        if (!turn.budgetNoticeSent && turn.requests >= turn.softRequestBudget) {
          turn.budgetNoticeSent = true;
          turn.callbacks.onEvent("budget-notice", { requests: turn.requests, budget: turn.softRequestBudget });
          void this.client?.steer(`[budget notice] You have used ${turn.requests} requests (soft budget: ${turn.softRequestBudget}). Finish the current step and yield your final report now.`).catch(() => {});
        }
        if (!turn.budgetStopRequested && turn.requests >= stopAt) {
          turn.budgetStopRequested = true;
          turn.callbacks.onEvent("budget-stop", { requests: turn.requests, budget: turn.softRequestBudget });
          void this.client?.abort().catch(() => {});
        } else if (turn.budgetStopRequested && turn.requests >= stopAt + 5) {
          this.finishTurn(`Soft request budget exceeded (${turn.requests} requests; budget ${turn.softRequestBudget})`);
          return;
        }
      }
      const message = this.protocol.workerMessage(contentText(event.message.content));
      if (message?.kind === "ask") turn.callbacks.onWorkerMessage?.(message.message, "ask");
      if (message?.kind === "peer") turn.callbacks.onWorkerMessage?.(`${message.target}::${message.message}`, "peer");
    } else if (event.type === "auto_retry_start") {
      turn.callbacks.onEvent("retrying", { attempt: event.attempt, maxAttempts: event.maxAttempts, delayMs: event.delayMs, errorMessage: event.errorMessage });
    } else if (event.type === "auto_retry_end") {
      turn.callbacks.onEvent(event.success ? "retry-succeeded" : "retry-failed", { attempt: event.attempt, errorMessage: event.finalError });
    } else if (event.type === "compaction_start") {
      turn.callbacks.onEvent("compacting");
    } else if (event.type === "agent_settled") {
      turn.callbacks.onEvent("settled");
      if (turn.budgetStopRequested && !turn.yielded && !turn.forcedYieldSent && !turn.timedOut && !turn.externallyAborted) {
        turn.forcedYieldSent = true;
        try { await this.client?.prompt("The soft request budget was exceeded. Do not continue the work. Call workflow_yield now with the best verified partial result, exact validation performed, and remaining blocker or risk."); }
        catch (error) { this.finishTurn(error instanceof Error ? error.message : String(error)); }
      } else if (!turn.yielded && turn.continuationNudges < 2 && !turn.timedOut && !turn.externallyAborted) {
        turn.continuationNudges++;
        const raw = turn.events.map((item) => JSON.stringify(item)).join("\n");
        try { await this.client?.prompt(this.protocol.continuationPrompt(raw, turn.task)); }
        catch (error) { this.finishTurn(error instanceof Error ? error.message : String(error)); }
      } else {
        this.finishTurn(turn.budgetStopRequested && !turn.yielded ? `Soft request budget exceeded (${turn.requests} requests; budget ${turn.softRequestBudget})` : undefined);
      }
    }
  }

  private async finishTurn(forcedError?: string): Promise<void> {
    const turn = this.turn;
    if (!turn) return;
    this.turn = undefined;
    clearTimeout(turn.timer);
    if (turn.killTimer) clearTimeout(turn.killTimer);
    if (turn.signal && turn.abortListener) turn.signal.removeEventListener("abort", turn.abortListener);
    turn.coordinationController.abort();
    this.lastActiveAt = Date.now();
    if (!turn.timedOut && !turn.externallyAborted && this.client) this.lifecycle = "idle";
    const rawJsonl = turn.events.map((event) => JSON.stringify(event)).join("\n");
    const structured = this.protocol.structuredYield(rawJsonl);
    const output = structured?.output ?? this.protocol.textOutput(rawJsonl);
    const protocolError = this.protocol.protocolError(rawJsonl);
    const stderr = this.client?.getStderr().slice(turn.stderrStart) ?? "";
    const stats = await this.client?.getSessionStats().catch(() => undefined);
    const failed = Boolean(forcedError || protocolError || turn.timedOut || turn.externallyAborted || !output || structured?.status === "blocked");
    const error = forcedError
      ?? (protocolError ? `child model error: ${protocolError}` : undefined)
      ?? (structured?.status === "blocked" ? output : undefined)
      ?? (!output ? stderr || "child produced no assistant result" : undefined);
    turn.resolve({
      ok: !failed, output, error, exitCode: failed ? 1 : 0, timedOut: turn.timedOut,
      durationMs: Date.now() - turn.startedAt, usage: turn.usage, requests: turn.requests,
      yielded: Boolean(structured), yieldStatus: structured?.status, rawJsonl, stderr,
      sessionFile: this.sessionFile,
      cost: stats?.cost,
      contextTokens: stats?.contextUsage?.tokens ?? undefined,
      contextWindow: stats?.contextUsage?.contextWindow,
    });
  }

  async park(): Promise<void> {
    if (this.turn || this.lifecycle === "parked") return;
    await this.stopClient();
    if (this.lifecycle !== "aborted") this.lifecycle = "parked";
  }

  async terminate(): Promise<void> {
    this.lifecycle = "aborted";
    this.abortActive(false);
    await this.stopClient();
  }

  private async stopClient(): Promise<void> {
    if (this.ipcTimer) clearInterval(this.ipcTimer);
    this.ipcTimer = undefined;
    const client = this.client;
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    this.client = undefined;
    if (client) await client.stop().catch(() => {});
  }
}

type RegistryEntry = { session: WorkerSession; ids: Set<string>; timer?: ReturnType<typeof setTimeout> };

export class WorkerSessionRegistry {
  private readonly byId = new Map<string, RegistryEntry>();

  adopt(id: string, session: WorkerSession, idleTtlMs: number): void {
    const existing = this.byId.get(id);
    if (existing && existing.session !== session) void existing.session.terminate();
    let entry = [...this.byId.values()].find((item) => item.session === session);
    if (!entry) entry = { session, ids: new Set() };
    entry.ids.add(id);
    for (const alias of entry.ids) this.byId.set(alias, entry);
    this.arm(entry, idleTtlMs);
  }

  get(id: string): WorkerSession | undefined { return this.byId.get(id)?.session; }

  touch(id: string, idleTtlMs: number): void {
    const entry = this.byId.get(id);
    if (entry) this.arm(entry, idleTtlMs);
  }

  private arm(entry: RegistryEntry, idleTtlMs: number): void {
    if (entry.timer) clearTimeout(entry.timer);
    if (idleTtlMs <= 0) return;
    entry.timer = setTimeout(() => { void entry.session.park(); }, idleTtlMs);
    entry.timer.unref?.();
  }

  async terminate(id: string): Promise<boolean> {
    const entry = this.byId.get(id);
    if (!entry) return false;
    if (entry.timer) clearTimeout(entry.timer);
    for (const alias of entry.ids) this.byId.delete(alias);
    await entry.session.terminate();
    return true;
  }

  async terminateAll(): Promise<void> {
    const entries = [...new Set(this.byId.values())];
    this.byId.clear();
    await Promise.all(entries.map(async (entry) => { if (entry.timer) clearTimeout(entry.timer); await entry.session.terminate(); }));
  }
}

const REGISTRY_KEY = Symbol.for("pi-agent-workflow.worker-sessions.v1");
type GlobalWithRegistry = typeof globalThis & { [REGISTRY_KEY]?: WorkerSessionRegistry };
export function workerSessionRegistry(): WorkerSessionRegistry {
  const root = globalThis as GlobalWithRegistry;
  return root[REGISTRY_KEY] ??= new WorkerSessionRegistry();
}