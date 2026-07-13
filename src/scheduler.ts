/**
 * Cancellable, provider-aware worker scheduler.
 *
 * The lifecycle shape is adapted from oh-my-pi's MIT-licensed task scheduler;
 * execution remains Pi-native and does not import OMP's runtime or prompts.
 */
import type { Job, WorkerControl } from "./types.js";

export type JobRunner = (job: Job, signal: AbortSignal) => Promise<Job>;
export type SchedulerEvent = { type: "changed" | "completed"; job: Job };

type QueueItem = {
  job: Job;
  provider: string;
  runner: JobRunner;
  controller: AbortController;
  resolve: (job: Job) => void;
  reject: (error: unknown) => void;
};

type Completion = { promise: Promise<Job>; resolve: (job: Job) => void };

export class WorkflowScheduler {
  readonly jobs = new Map<string, Job>();
  readonly controls = new Map<string, WorkerControl>();
  private queue: QueueItem[] = [];
  private active = 0;
  private activeProviders = new Map<string, number>();
  private controllers = new Map<string, AbortController>();
  private completions = new Map<string, Completion>();
  private listeners = new Set<(event: SchedulerEvent) => void>();
  private maxConcurrent = 1;
  private maxConcurrentPerProvider = 1;
  private maxNestedConcurrent = 8;
  private nestedActive = 0;
  private nestedProviders = new Map<string, number>();

  configure(maxConcurrent: number, maxConcurrentPerProvider: number, maxNestedConcurrent = Math.max(4, maxConcurrent * 4)): void {
    this.maxConcurrent = Math.max(1, maxConcurrent);
    this.maxConcurrentPerProvider = Math.max(1, maxConcurrentPerProvider);
    this.maxNestedConcurrent = Math.max(1, maxNestedConcurrent);
    this.drain();
  }

  subscribe(listener: (event: SchedulerEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  notify(job: Job, type: SchedulerEvent["type"] = "changed"): void {
    this.jobs.set(job.id, job);
    for (const listener of this.listeners) listener({ type, job });
  }

  enqueue(job: Job, provider: string, runner: JobRunner): Promise<Job> {
    const existing = this.completions.get(job.id);
    if (existing && (job.status === "queued" || job.status === "running")) return existing.promise;
    const controller = new AbortController();
    let resolveCompletion!: (job: Job) => void;
    const completionPromise = new Promise<Job>((resolve) => { resolveCompletion = resolve; });
    this.completions.set(job.id, { promise: completionPromise, resolve: resolveCompletion });
    this.controllers.set(job.id, controller);
    this.notify(job);
    const queued = new Promise<Job>((resolve, reject) => this.queue.push({ job, provider, runner, controller, resolve, reject }));
    void queued.then(resolveCompletion, (error) => {
      job.status = "failed";
      job.error = error instanceof Error ? error.message : String(error);
      job.finishedAt = new Date().toISOString();
      this.notify(job);
      resolveCompletion(job);
    });
    this.drain();
    return completionPromise;
  }

  /** Run a depth-bounded nested worker immediately so its waiting parent cannot deadlock the global queue. */
  enqueueNested(job: Job, runner: JobRunner, parentSignal?: AbortSignal, provider = "nested"): Promise<Job> {
    const controller = new AbortController();
    const providerActive = this.nestedProviders.get(provider) ?? 0;
    if (this.nestedActive >= this.maxNestedConcurrent || providerActive >= this.maxConcurrentPerProvider * 4) {
      job.status = "failed";
      job.error = `Nested worker capacity exhausted (active ${this.nestedActive}/${this.maxNestedConcurrent}, provider ${provider} ${providerActive}/${this.maxConcurrentPerProvider * 4}).`;
      job.finishedAt = new Date().toISOString();
      this.notify(job, "completed");
      return Promise.resolve(job);
    }
    this.nestedActive++;
    this.nestedProviders.set(provider, providerActive + 1);
    let resolveCompletion!: (job: Job) => void;
    const promise = new Promise<Job>((resolve) => { resolveCompletion = resolve; });
    this.completions.set(job.id, { promise, resolve: resolveCompletion });
    this.controllers.set(job.id, controller);
    this.notify(job);
    const abortFromParent = () => controller.abort();
    parentSignal?.addEventListener("abort", abortFromParent, { once: true });
    if (parentSignal?.aborted) controller.abort();
    void runner(job, controller.signal).then(resolveCompletion, (error) => {
      job.status = "failed";
      job.error = error instanceof Error ? error.message : String(error);
      job.finishedAt = new Date().toISOString();
      this.notify(job);
      resolveCompletion(job);
    }).finally(() => {
      parentSignal?.removeEventListener("abort", abortFromParent);
      this.controllers.delete(job.id);
      this.controls.delete(job.id);
      this.nestedActive = Math.max(0, this.nestedActive - 1);
      const active = (this.nestedProviders.get(provider) ?? 1) - 1;
      if (active > 0) this.nestedProviders.set(provider, active);
      else this.nestedProviders.delete(provider);
      this.finish(job);
    });
    return promise;
  }

  private drain(): void {
    while (this.active < this.maxConcurrent) {
      const index = this.queue.findIndex((item) => (this.activeProviders.get(item.provider) ?? 0) < this.maxConcurrentPerProvider);
      if (index < 0) return;
      const item = this.queue.splice(index, 1)[0];
      if (item.controller.signal.aborted || item.job.status === "cancelled") {
        item.job.status = "cancelled";
        item.job.finishedAt ??= new Date().toISOString();
        item.resolve(item.job);
        this.finish(item.job);
        continue;
      }
      this.active++;
      this.activeProviders.set(item.provider, (this.activeProviders.get(item.provider) ?? 0) + 1);
      void item.runner(item.job, item.controller.signal).then(item.resolve, item.reject).finally(() => {
        this.active--;
        const count = (this.activeProviders.get(item.provider) ?? 1) - 1;
        if (count > 0) this.activeProviders.set(item.provider, count);
        else this.activeProviders.delete(item.provider);
        this.controllers.delete(item.job.id);
        this.controls.delete(item.job.id);
        this.finish(item.job);
        this.drain();
      });
    }
  }

  private finish(job: Job): void {
    this.notify(job, "completed");
    this.completions.get(job.id)?.resolve(job);
  }

  setControl(jobId: string, control: WorkerControl | undefined): void {
    if (control) this.controls.set(jobId, control);
    else this.controls.delete(jobId);
  }

  cancel(jobId: string, reason = "Cancelled by user."): boolean {
    const job = this.jobs.get(jobId);
    if (!job || !["queued", "running"].includes(job.status)) return false;
    job.status = "cancelled";
    job.error = reason;
    job.finishedAt = new Date().toISOString();
    this.controllers.get(jobId)?.abort();
    const queuedIndex = this.queue.findIndex((item) => item.job.id === jobId);
    if (queuedIndex >= 0) {
      const [item] = this.queue.splice(queuedIndex, 1);
      this.controllers.delete(jobId);
      item.resolve(job);
      this.finish(job);
    } else {
      this.notify(job);
    }
    // Parent cancellation is hierarchical: abort all queued, running, or
    // nested descendants so no child survives a cancelled orchestration tree.
    const descendants = [...this.jobs.values()].filter((candidate) => candidate.id !== job.id && this.isDescendant(candidate, job.id));
    for (const descendant of descendants) this.cancel(descendant.id, `Parent ${job.id} cancelled.`);
    this.drain();
    return true;
  }

  private isDescendant(candidate: Job, ancestorId: string): boolean {
    let current = candidate.parentId;
    const seen = new Set<string>();
    while (current && !seen.has(current)) {
      if (current === ancestorId) return true;
      seen.add(current);
      current = this.jobs.get(current)?.parentId;
    }
    return false;
  }

  cancelAll(reason = "Cancelled by user."): number {
    let count = 0;
    for (const job of this.jobs.values()) if (this.cancel(job.id, reason)) count++;
    return count;
  }

  message(jobId: string, message: string, mode: "steer" | "follow_up"): boolean {
    const control = this.controls.get(jobId);
    if (!control) return false;
    return mode === "follow_up" ? control.followUp(message) : control.steer(message);
  }

  async wait(jobIds: string[] | undefined, signal?: AbortSignal): Promise<Job[]> {
    const selected = jobIds?.length ? [...new Set(jobIds)] : [...this.jobs.values()].filter((job) => job.status === "queued" || job.status === "running").map((job) => job.id);
    const waits = selected.map((id) => {
      const completion = this.completions.get(id);
      const job = this.jobs.get(id);
      if (completion && job && (job.status === "queued" || job.status === "running")) return completion.promise;
      return Promise.resolve(job).then((value) => value as Job | undefined);
    });
    const all = Promise.all(waits);
    if (!signal) return (await all).filter((job): job is Job => Boolean(job));
    if (signal.aborted) throw new DOMException("Waiting cancelled", "AbortError");
    return await Promise.race([
      all.then((items) => items.filter((job): job is Job => Boolean(job))),
      new Promise<Job[]>((_, reject) => signal.addEventListener("abort", () => reject(new DOMException("Waiting cancelled", "AbortError")), { once: true })),
    ]);
  }

  importJobs(jobs: Job[]): void {
    for (const job of jobs) if (!this.jobs.has(job.id)) this.jobs.set(job.id, job);
  }
}

const GLOBAL_KEY = Symbol.for("pi-agent-workflow.scheduler.v2");
type GlobalWithScheduler = typeof globalThis & { [GLOBAL_KEY]?: WorkflowScheduler };
export function globalScheduler(): WorkflowScheduler {
  const root = globalThis as GlobalWithScheduler;
  const existing = root[GLOBAL_KEY];
  // Pi /reload preserves process-global registries while re-evaluating modules.
  // Upgrade the retained instance to the current prototype so newly added
  // scheduler methods are immediately available without restarting Pi.
  if (existing) {
    if (Object.getPrototypeOf(existing) !== WorkflowScheduler.prototype) Object.setPrototypeOf(existing, WorkflowScheduler.prototype);
    return existing;
  }
  return root[GLOBAL_KEY] = new WorkflowScheduler();
}