import test from "node:test";
import assert from "node:assert/strict";
import { WorkflowScheduler } from "../src/scheduler.js";
import type { Job } from "../src/types.js";

function job(id: string): Job {
  return {
    id,
    cwd: "/tmp",
    task: id,
    decision: { kind: "fast", reason: "test", profile: { kind: "fast", label: "Fast", model: "p/m", thinking: "off", description: "test" } },
    status: "queued",
    createdAt: new Date().toISOString(),
    attempts: 0,
  };
}

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

test("scheduler enforces global and per-provider concurrency", async () => {
  const scheduler = new WorkflowScheduler();
  scheduler.configure(3, 1);
  let active = 0;
  let maxActive = 0;
  const providers = new Map<string, number>();
  let sameProviderOverlap = false;
  const run = (provider: string) => async (item: Job) => {
    active++;
    maxActive = Math.max(maxActive, active);
    const providerActive = (providers.get(provider) ?? 0) + 1;
    providers.set(provider, providerActive);
    if (providerActive > 1) sameProviderOverlap = true;
    item.status = "running";
    await delay(15);
    providers.set(provider, providerActive - 1);
    active--;
    item.status = "succeeded";
    item.finishedAt = new Date().toISOString();
    return item;
  };
  await Promise.all([
    scheduler.enqueue(job("a1"), "a", run("a")),
    scheduler.enqueue(job("a2"), "a", run("a")),
    scheduler.enqueue(job("b1"), "b", run("b")),
    scheduler.enqueue(job("c1"), "c", run("c")),
  ]);
  assert.equal(sameProviderOverlap, false);
  assert.equal(maxActive, 3);
});

test("scheduler cancels queued work without running it", async () => {
  const scheduler = new WorkflowScheduler();
  scheduler.configure(1, 1);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const first = job("first");
  const second = job("second");
  let secondRan = false;
  const firstPromise = scheduler.enqueue(first, "p", async (item) => { item.status = "running"; await gate; item.status = "succeeded"; return item; });
  const secondPromise = scheduler.enqueue(second, "p", async (item) => { secondRan = true; item.status = "succeeded"; return item; });
  assert.equal(scheduler.cancel(second.id), true);
  release();
  await firstPromise;
  const cancelled = await secondPromise;
  assert.equal(secondRan, false);
  assert.equal(cancelled.status, "cancelled");
});

test("nested workers run without deadlocking a saturated parent slot", async () => {
  const scheduler = new WorkflowScheduler();
  scheduler.configure(1, 1);
  const parent = job("parent");
  const child = job("child");
  const result = await scheduler.enqueue(parent, "p", async (running) => {
    running.status = "running";
    const nested = await scheduler.enqueueNested(child, async (nestedJob) => { nestedJob.status = "succeeded"; return nestedJob; });
    assert.equal(nested.status, "succeeded");
    running.status = "succeeded";
    return running;
  });
  assert.equal(result.status, "succeeded");
});

test("cancelling a parent aborts active descendants", async () => {
  const scheduler = new WorkflowScheduler();
  scheduler.configure(1, 1, 4);
  const parent = job("parent-cancel");
  const child = job("child-cancel");
  let childAborted = false;
  void scheduler.enqueue(parent, "p", async (running, signal) => {
    running.status = "running";
    child.parentId = running.id;
    void scheduler.enqueueNested(child, async (nested, nestedSignal) => {
      nested.status = "running";
      await new Promise<void>((resolve) => nestedSignal.addEventListener("abort", () => { childAborted = true; resolve(); }, { once: true }));
      nested.status = "cancelled";
      return nested;
    }, signal);
    await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
    running.status = "cancelled";
    return running;
  });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(scheduler.cancel(parent.id), true);
  await scheduler.wait([parent.id, child.id]);
  assert.equal(childAborted, true);
});

test("scheduler wait resolves from completion events", async () => {
  const scheduler = new WorkflowScheduler();
  scheduler.configure(1, 1);
  const item = job("waited");
  void scheduler.enqueue(item, "p", async (running) => { running.status = "succeeded"; running.finishedAt = new Date().toISOString(); return running; });
  const [completed] = await scheduler.wait([item.id]);
  assert.equal(completed.id, item.id);
  assert.equal(completed.status, "succeeded");
});