import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { Job, PersistedWorkflowState } from "./types.js";

export function workflowStatePath(cwd: string): string {
  return join(cwd, ".pi", "agent-workflow-runs", "state.json");
}

export async function loadWorkflowState(cwd: string): Promise<Job[]> {
  try {
    const state = JSON.parse(await readFile(workflowStatePath(cwd), "utf8")) as PersistedWorkflowState;
    if (state.version !== 1 || !Array.isArray(state.jobs)) return [];
    return state.jobs.filter((job) => job && typeof job.id === "string" && typeof job.task === "string");
  } catch {
    return [];
  }
}

export async function saveWorkflowState(cwd: string, jobs: Iterable<Job>): Promise<void> {
  const path = workflowStatePath(cwd);
  await mkdir(dirname(path), { recursive: true });
  const state: PersistedWorkflowState = { version: 1, updatedAt: new Date().toISOString(), jobs: [...jobs].slice(-200) };
  const temp = `${path}.${process.pid}.tmp`;
  await writeFile(temp, JSON.stringify(state, null, 2), "utf8");
  await rename(temp, path);
}