import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { cleanupIsolation, mergeIsolation, prepareIsolation } from "../src/isolation.js";
import { loadWorkflowState, saveWorkflowState } from "../src/state.js";
import type { Job } from "../src/types.js";

const execFileAsync = promisify(execFile);
const executor = {
  async exec(command: string, args: string[], options: { cwd?: string; timeout?: number } = {}) {
    try {
      const result = await execFileAsync(command, args, { cwd: options.cwd, timeout: options.timeout, encoding: "utf8" });
      return { stdout: result.stdout, stderr: result.stderr, code: 0, killed: false };
    } catch (error) {
      const value = error as { stdout?: string; stderr?: string; code?: number; killed?: boolean };
      return { stdout: value.stdout ?? "", stderr: value.stderr ?? "", code: value.code ?? 1, killed: value.killed ?? false };
    }
  },
} as any;

function sampleJob(): Job {
  return {
    id: "wpersist",
    cwd: "/tmp/project",
    task: "inspect",
    decision: { kind: "fast", reason: "test", profile: { kind: "fast", label: "Fast", model: "p/m", thinking: "off", description: "test" } },
    status: "succeeded",
    createdAt: new Date().toISOString(),
    attempts: 1,
  };
}

test("workflow state round-trips atomically", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-state-test-"));
  try {
    await saveWorkflowState(cwd, [sampleJob()]);
    const loaded = await loadWorkflowState(cwd);
    assert.equal(loaded.length, 1);
    assert.equal(loaded[0].id, "wpersist");
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test("isolated worktree snapshots and merges a dirty tracked and untracked tree", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-dirty-isolation-test-"));
  let isolation: Awaited<ReturnType<typeof prepareIsolation>> | undefined;
  try {
    await executor.exec("git", ["init", "-q"], { cwd });
    await executor.exec("git", ["config", "user.email", "test@example.com"], { cwd });
    await executor.exec("git", ["config", "user.name", "Test"], { cwd });
    await writeFile(join(cwd, "value.txt"), "committed\n");
    await writeFile(join(cwd, "other.txt"), "other committed\n");
    await executor.exec("git", ["add", "value.txt", "other.txt"], { cwd });
    await executor.exec("git", ["commit", "-qm", "initial"], { cwd });
    await writeFile(join(cwd, "value.txt"), "dirty parent\n");
    await writeFile(join(cwd, "local.txt"), "local baseline\n");
    isolation = await prepareIsolation(executor, cwd, "dirty");
    assert.equal(isolation.dirty, true);
    assert.equal(await readFile(join(isolation.worktreeDir, "value.txt"), "utf8"), "dirty parent\n");
    assert.equal(await readFile(join(isolation.worktreeDir, "local.txt"), "utf8"), "local baseline\n");
    await writeFile(join(isolation.worktreeDir, "worker.txt"), "child\n");
    await writeFile(join(isolation.worktreeDir, "local.txt"), "local child\n");
    await writeFile(join(isolation.worktreeDir, "other.txt"), "worker tracked\n");
    const merged = await mergeIsolation(executor, isolation);
    assert.equal(merged.changed, true);
    assert.equal(await readFile(join(cwd, "value.txt"), "utf8"), "dirty parent\n");
    assert.equal(await readFile(join(cwd, "other.txt"), "utf8"), "worker tracked\n");
    assert.equal(await readFile(join(cwd, "local.txt"), "utf8"), "local child\n");
    assert.equal(await readFile(join(cwd, "worker.txt"), "utf8"), "child\n");
  } finally {
    if (isolation) await cleanupIsolation(executor, isolation);
    await rm(cwd, { recursive: true, force: true });
  }
});

test("isolated worktree preserves nested repositories and merges nested edits", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-nested-isolation-test-"));
  const nested = join(cwd, "nested");
  let isolation: Awaited<ReturnType<typeof prepareIsolation>> | undefined;
  try {
    await executor.exec("git", ["init", "-q"], { cwd });
    await executor.exec("git", ["config", "user.email", "test@example.com"], { cwd });
    await executor.exec("git", ["config", "user.name", "Test"], { cwd });
    await executor.exec("git", ["init", "-q", nested], { cwd });
    await executor.exec("git", ["config", "user.email", "test@example.com"], { cwd: nested });
    await executor.exec("git", ["config", "user.name", "Test"], { cwd: nested });
    await writeFile(join(nested, "nested.txt"), "before\n");
    await executor.exec("git", ["add", "nested.txt"], { cwd: nested });
    await executor.exec("git", ["commit", "-qm", "nested initial"], { cwd: nested });
    await executor.exec("git", ["add", "nested"], { cwd });
    await executor.exec("git", ["commit", "-qm", "parent initial"], { cwd });
    isolation = await prepareIsolation(executor, cwd, "nested");
    assert.equal(isolation.nested.length, 1);
    await writeFile(join(isolation.nested[0].workerDir, "nested.txt"), "after\n");
    const merged = await mergeIsolation(executor, isolation);
    assert.equal(merged.changed, true);
    assert.equal(await readFile(join(nested, "nested.txt"), "utf8"), "after\n");
  } finally {
    if (isolation) await cleanupIsolation(executor, isolation);
    await rm(cwd, { recursive: true, force: true });
  }
});

test("isolated worktree merges a checked patch without committing main", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-isolation-test-"));
  let isolation: Awaited<ReturnType<typeof prepareIsolation>> | undefined;
  let secondIsolation: Awaited<ReturnType<typeof prepareIsolation>> | undefined;
  try {
    await executor.exec("git", ["init", "-q"], { cwd });
    await executor.exec("git", ["config", "user.email", "test@example.com"], { cwd });
    await executor.exec("git", ["config", "user.name", "Test"], { cwd });
    await writeFile(join(cwd, "value.txt"), "before\n");
    await writeFile(join(cwd, "other.txt"), "old\n");
    await executor.exec("git", ["add", "value.txt", "other.txt"], { cwd });
    await executor.exec("git", ["commit", "-qm", "initial"], { cwd });
    const beforeHead = (await executor.exec("git", ["rev-parse", "HEAD"], { cwd })).stdout.trim();
    isolation = await prepareIsolation(executor, cwd, "test");
    secondIsolation = await prepareIsolation(executor, cwd, "test-two");
    await writeFile(join(isolation.worktreeDir, "value.txt"), "after\n");
    await writeFile(join(secondIsolation.worktreeDir, "other.txt"), "new\n");
    const merged = await Promise.all([mergeIsolation(executor, isolation), mergeIsolation(executor, secondIsolation)]);
    assert.equal(merged.every((result) => result.changed), true);
    assert.equal(await readFile(join(cwd, "value.txt"), "utf8"), "after\n");
    assert.equal(await readFile(join(cwd, "other.txt"), "utf8"), "new\n");
    const afterHead = (await executor.exec("git", ["rev-parse", "HEAD"], { cwd })).stdout.trim();
    assert.equal(afterHead, beforeHead);
  } finally {
    if (isolation) await cleanupIsolation(executor, isolation);
    if (secondIsolation) await cleanupIsolation(executor, secondIsolation);
    await rm(cwd, { recursive: true, force: true });
  }
});