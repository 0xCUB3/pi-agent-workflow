/** Git-backed isolation with a dirty-tree snapshot fallback. */
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { dirname, join, relative } from "node:path";
import { tmpdir } from "node:os";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export type IsolationContext = {
  mainCwd: string;
  worktreeDir: string;
  base: string;
  patchFile: string;
  dirty: boolean;
  baselinePatch?: string;
  baselineUntracked: Record<string, string>;
  nested: NestedRepository[];
};

type NestedRepository = {
  sourceDir: string;
  workerDir: string;
  base: string;
  patchFile: string;
  baselinePatch?: string;
  baselineUntracked: Record<string, string>;
};

type Exec = Pick<ExtensionAPI, "exec">;
const LOCK_KEY = Symbol.for("pi-agent-workflow.isolation-locks.v2");
type LockRoot = typeof globalThis & { [LOCK_KEY]?: Map<string, Promise<void>> };
async function withRepoLock<T>(repo: string, work: () => Promise<T>): Promise<T> {
  const root = globalThis as LockRoot;
  const locks = root[LOCK_KEY] ??= new Map<string, Promise<void>>();
  const prior = locks.get(repo) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const tail = prior.then(() => gate);
  locks.set(repo, tail);
  await prior;
  try { return await work(); }
  finally { release(); if (locks.get(repo) === tail) locks.delete(repo); }
}

async function git(pi: Exec, cwd: string, args: string[], timeout = 60_000): Promise<string> {
  const result = await pi.exec("git", args, { cwd, timeout });
  if (result.code !== 0) throw new Error(result.stderr.trim() || result.stdout.trim() || `git ${args.join(" ")} failed`);
  return result.stdout.trim();
}
async function gitRaw(pi: Exec, cwd: string, args: string[], timeout = 60_000) {
  return pi.exec("git", args, { cwd, timeout });
}
async function files(pi: Exec, cwd: string, args: string[]): Promise<string[]> {
  const result = await pi.exec("git", args, { cwd, timeout: 60_000 });
  if (result.code !== 0) return [];
  return result.stdout.split("\0").map((path) => path.trim()).filter(Boolean);
}
async function hash(path: string): Promise<string> {
  try { return createHash("sha256").update(await readFile(path)).digest("hex"); }
  catch { return "<missing>"; }
}
async function copyPath(sourceRoot: string, destinationRoot: string, path: string): Promise<void> {
  const source = join(sourceRoot, path), destination = join(destinationRoot, path);
  await mkdir(dirname(destination), { recursive: true });
  await cp(source, destination, { recursive: true, force: true });
}
async function removePath(root: string, path: string): Promise<void> { await rm(join(root, path), { recursive: true, force: true }); }

export async function prepareIsolation(pi: Exec, cwd: string, jobId: string): Promise<IsolationContext> {
  const top = await git(pi, cwd, ["rev-parse", "--show-toplevel"]);
  const status = await git(pi, top, ["status", "--porcelain=v1", "--untracked-files=all", "--", ".", ":(exclude).pi/agent-workflow-runs/**"]);
  const dirty = Boolean(status);
  const base = await git(pi, top, ["rev-parse", "HEAD"]);
  const root = await mkdtemp(join(tmpdir(), `pi-worker-${jobId}-`));
  const worktreeDir = join(root, "worktree");
  const baselinePatch = join(root, "dirty-baseline.patch");
  const baselineUntracked: Record<string, string> = {};
  const nested: NestedRepository[] = [];
  const nestedFind = await pi.exec("find", [top, "-mindepth", "2", "-type", "d", "-name", ".git", "-print"], { cwd: top, timeout: 60_000 });
  const nestedSources = nestedFind.code === 0 ? nestedFind.stdout.split("\n").map((path) => path.trim()).filter(Boolean).map((path) => dirname(path)).filter((path) => path !== join(top, ".git")) : [];
  try {
    await git(pi, top, ["worktree", "add", "--detach", "--no-checkout", worktreeDir, base], 120_000);
    await git(pi, worktreeDir, ["checkout", "--detach", base], 120_000);
    if (dirty) {
      const patch = await pi.exec("git", ["diff", "--binary", "--full-index", base, "--", ".", ":(exclude).pi/agent-workflow-runs/**"], { cwd: top, timeout: 120_000 });
      if (patch.code !== 0) throw new Error(patch.stderr.trim() || "failed to snapshot dirty tree");
      await writeFile(baselinePatch, patch.stdout, "utf8");
      const untracked = await files(pi, top, ["ls-files", "--others", "--exclude-standard", "-z"]);
      for (const path of untracked) {
        baselineUntracked[path] = await hash(join(top, path));
        await copyPath(top, worktreeDir, path);
      }
      if (patch.stdout.trim()) await git(pi, worktreeDir, ["apply", "--binary", baselinePatch], 120_000);
    }
    // Nested repositories are cloned into the worker worktree so their own
    // branches, tools, and dirty state remain real Git repositories instead
    // of becoming opaque parent gitlinks.
    for (let index = 0; index < nestedSources.length; index++) {
      const sourceDir = nestedSources[index];
      const nestedPath = relative(top, sourceDir);
      const workerDir = join(worktreeDir, nestedPath);
      await rm(workerDir, { recursive: true, force: true });
      await mkdir(dirname(workerDir), { recursive: true });
      const nestedBase = await git(pi, sourceDir, ["rev-parse", "HEAD"]);
      await git(pi, sourceDir, ["clone", "--local", "--no-hardlinks", sourceDir, workerDir], 120_000).catch(async () => {
        await git(pi, sourceDir, ["clone", "--no-hardlinks", sourceDir, workerDir], 120_000);
      });
      const nestedPatch = join(root, `nested-${index + 1}.patch`);
      const nestedBaselinePatch = join(root, `nested-${index + 1}-baseline.patch`);
      const nestedStatus = await git(pi, sourceDir, ["status", "--porcelain=v1", "--untracked-files=all"]);
      const nestedBaselineUntracked: Record<string, string> = {};
      if (nestedStatus) {
        const patch = await pi.exec("git", ["diff", "--binary", "--full-index", nestedBase, "--"], { cwd: sourceDir, timeout: 120_000 });
        if (patch.code !== 0) throw new Error(patch.stderr.trim() || `failed to snapshot nested repository ${nestedPath}`);
        await writeFile(nestedBaselinePatch, patch.stdout, "utf8");
        for (const path of await files(pi, sourceDir, ["ls-files", "--others", "--exclude-standard", "-z"])) {
          nestedBaselineUntracked[path] = await hash(join(sourceDir, path));
          await copyPath(sourceDir, workerDir, path);
        }
        if (patch.stdout.trim()) await git(pi, workerDir, ["apply", "--binary", nestedBaselinePatch], 120_000);
      }
      nested.push({ sourceDir, workerDir, base: nestedBase, patchFile: nestedPatch, baselinePatch: nestedStatus ? nestedBaselinePatch : undefined, baselineUntracked: nestedBaselineUntracked });
    }
  } catch (error) {
    await rm(root, { recursive: true, force: true });
    throw error;
  }
  return { mainCwd: top, worktreeDir, base, patchFile: join(root, "changes.patch"), dirty, baselinePatch: dirty ? baselinePatch : undefined, baselineUntracked, nested };
}

async function workerUntracked(pi: Exec, worktree: string): Promise<string[]> {
  return files(pi, worktree, ["ls-files", "--others", "--exclude-standard", "-z"]);
}

async function mergeNestedRepository(pi: Exec, nested: NestedRepository): Promise<boolean> {
  if (nested.baselinePatch && (await readFile(nested.baselinePatch, "utf8")).trim()) {
    const reverse = await pi.exec("git", ["apply", "--reverse", "--binary", nested.baselinePatch], { cwd: nested.workerDir, timeout: 120_000 });
    if (reverse.code !== 0) throw new Error(`nested repository changed its dirty baseline; patch preserved at ${nested.baselinePatch}: ${reverse.stderr.trim()}`);
  }
  const workerFiles = await workerUntracked(pi, nested.workerDir);
  const baselinePaths = new Set(Object.keys(nested.baselineUntracked));
  const changedBaseline = workerFiles.filter((path) => baselinePaths.has(path));
  const newUntracked = workerFiles.filter((path) => !baselinePaths.has(path));
  const tracked = await pi.exec("git", ["diff", "--binary", "--full-index", nested.base, "--"], { cwd: nested.workerDir, timeout: 120_000 });
  if (tracked.code !== 0) throw new Error(tracked.stderr.trim() || `failed to create nested repository patch for ${nested.sourceDir}`);
  return withRepoLock(nested.sourceDir, async () => {
    if (tracked.stdout.trim()) {
      await writeFile(nested.patchFile, tracked.stdout, "utf8");
      const check = await pi.exec("git", ["apply", "--check", "--binary", nested.patchFile], { cwd: nested.sourceDir, timeout: 120_000 });
      if (check.code !== 0) throw new Error(`nested repository patch conflicts; patch preserved at ${nested.patchFile}: ${check.stderr.trim()}`);
      const apply = await pi.exec("git", ["apply", "--binary", nested.patchFile], { cwd: nested.sourceDir, timeout: 120_000 });
      if (apply.code !== 0) throw new Error(`failed to merge nested repository patch: ${apply.stderr.trim()}`);
    }
    for (const path of new Set([...baselinePaths, ...changedBaseline])) {
      const before = nested.baselineUntracked[path] ?? "<missing>";
      const mainHash = await hash(join(nested.sourceDir, path));
      const workerHash = workerFiles.includes(path) ? await hash(join(nested.workerDir, path)) : "<missing>";
      if (workerHash === before) continue;
      if (mainHash !== before && mainHash !== workerHash) throw new Error(`nested untracked file conflict: ${nested.sourceDir}/${path}`);
      if (workerHash === "<missing>") await removePath(nested.sourceDir, path);
      else await copyPath(nested.workerDir, nested.sourceDir, path);
    }
    for (const path of newUntracked) {
      const workerHash = await hash(join(nested.workerDir, path));
      const mainHash = await hash(join(nested.sourceDir, path));
      if (mainHash !== "<missing>" && mainHash !== workerHash) throw new Error(`nested new file conflict: ${nested.sourceDir}/${path}`);
      await copyPath(nested.workerDir, nested.sourceDir, path);
    }
    return Boolean(tracked.stdout.trim() || changedBaseline.length || newUntracked.length);
  });
}

export async function mergeIsolation(pi: Exec, isolation: IsolationContext): Promise<{ changed: boolean; summary: string }> {
  const nestedChanged = (await Promise.all(isolation.nested.map((nested) => mergeNestedRepository(pi, nested)))).some(Boolean);
  const nestedExcludes = isolation.nested.flatMap((nested) => [":(exclude)" + relative(isolation.worktreeDir, nested.workerDir)]);
  if (!isolation.dirty) {
    await git(pi, isolation.worktreeDir, ["add", "-N", "."]);
    const diff = await pi.exec("git", ["diff", "--binary", "--full-index", isolation.base, "--", ".", ...nestedExcludes], { cwd: isolation.worktreeDir, timeout: 120_000 });
    if (diff.code !== 0) throw new Error(diff.stderr.trim() || "failed to create isolated patch");
    if (!diff.stdout.trim()) return { changed: nestedChanged, summary: nestedChanged ? "nested repository changes merged" : "isolated worker produced no file changes" };
    await writeFile(isolation.patchFile, diff.stdout, "utf8");
    return withRepoLock(isolation.mainCwd, async () => {
      const check = await pi.exec("git", ["apply", "--check", "--binary", isolation.patchFile], { cwd: isolation.mainCwd, timeout: 120_000 });
      if (check.code !== 0) throw new Error(`isolated patch no longer applies cleanly; patch preserved at ${isolation.patchFile}: ${check.stderr.trim()}`);
      const apply = await pi.exec("git", ["apply", "--binary", isolation.patchFile], { cwd: isolation.mainCwd, timeout: 120_000 });
      if (apply.code !== 0) throw new Error(`failed to merge isolated patch; patch preserved at ${isolation.patchFile}: ${apply.stderr.trim()}`);
      return { changed: true, summary: (await git(pi, isolation.mainCwd, ["diff", "--stat", "--", "."])) || "isolated changes merged" };
    });
  }

  // Remove the parent's tracked delta from the worker before producing the
  // child-only patch. This gives dirty-tree isolation a simple three-way merge:
  // parent baseline, worker result, and current parent tree.
  if (isolation.baselinePatch && (await readFile(isolation.baselinePatch, "utf8")).trim()) {
    const reverse = await pi.exec("git", ["apply", "--reverse", "--binary", isolation.baselinePatch], { cwd: isolation.worktreeDir, timeout: 120_000 });
    if (reverse.code !== 0) throw new Error(`worker changed a dirty baseline in an overlapping hunk; snapshot preserved at ${isolation.baselinePatch}: ${reverse.stderr.trim()}`);
  }
  const workerFiles = await workerUntracked(pi, isolation.worktreeDir);
  const baselinePaths = new Set(Object.keys(isolation.baselineUntracked));
  const newUntracked = workerFiles.filter((path) => !baselinePaths.has(path));
  const changedBaseline = workerFiles.filter((path) => baselinePaths.has(path));
  // Exclude all untracked content from the Git patch; it is merged with a
  // content-hash check below, which also handles binary files and deletions.
  const trackedPatch = await pi.exec("git", ["diff", "--binary", "--full-index", isolation.base, "--", ".", ...nestedExcludes], { cwd: isolation.worktreeDir, timeout: 120_000 });
  if (trackedPatch.code !== 0) throw new Error(trackedPatch.stderr.trim() || "failed to create isolated patch");
  if (trackedPatch.stdout.trim()) {
    await writeFile(isolation.patchFile, trackedPatch.stdout, "utf8");
    await withRepoLock(isolation.mainCwd, async () => {
      const check = await pi.exec("git", ["apply", "--check", "--binary", isolation.patchFile], { cwd: isolation.mainCwd, timeout: 120_000 });
      if (check.code !== 0) throw new Error(`dirty-tree worker patch conflicts with current parent; patch preserved at ${isolation.patchFile}: ${check.stderr.trim()}`);
      const apply = await pi.exec("git", ["apply", "--binary", isolation.patchFile], { cwd: isolation.mainCwd, timeout: 120_000 });
      if (apply.code !== 0) throw new Error(`failed to merge dirty-tree worker patch: ${apply.stderr.trim()}`);
    });
  }

  const allBaseline = new Set([...baselinePaths, ...changedBaseline]);
  for (const path of allBaseline) {
    const before = isolation.baselineUntracked[path] ?? "<missing>";
    const mainHash = await hash(join(isolation.mainCwd, path));
    const workerHash = workerFiles.includes(path) ? await hash(join(isolation.worktreeDir, path)) : "<missing>";
    if (workerHash === before) continue;
    if (mainHash !== before && mainHash !== workerHash) throw new Error(`dirty-tree untracked file conflict: ${path}`);
    if (workerHash === "<missing>") await removePath(isolation.mainCwd, path);
    else await copyPath(isolation.worktreeDir, isolation.mainCwd, path);
  }
  for (const path of newUntracked) {
    const workerHash = await hash(join(isolation.worktreeDir, path));
    const mainHash = await hash(join(isolation.mainCwd, path));
    if (mainHash !== "<missing>" && mainHash !== workerHash) throw new Error(`new untracked file conflict: ${path}`);
    await copyPath(isolation.worktreeDir, isolation.mainCwd, path);
  }
  const summary = (await git(pi, isolation.mainCwd, ["diff", "--stat", "--", "."])) || "isolated changes merged";
  return { changed: Boolean(nestedChanged || trackedPatch.stdout.trim() || changedBaseline.length || newUntracked.length), summary };
}

export async function cleanupIsolation(pi: Exec, isolation: IsolationContext, preservePatch = false): Promise<void> {
  await pi.exec("git", ["worktree", "remove", "--force", isolation.worktreeDir], { cwd: isolation.mainCwd, timeout: 120_000 }).catch(() => undefined);
  await pi.exec("git", ["worktree", "prune"], { cwd: isolation.mainCwd, timeout: 30_000 }).catch(() => undefined);
  if (!preservePatch) await rm(dirname(isolation.worktreeDir), { recursive: true, force: true });
}