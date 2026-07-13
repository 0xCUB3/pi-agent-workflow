import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { CONFIG_DIR_NAME, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { discoverAgentProfiles } from "./agents.js";
import type { ThinkingLevel, WorkerKind, WorkerProfile, WorkflowConfig } from "./types.js";

export const CONFIG_NAME = "agent-workflow.json";
export const BUILT_IN_KINDS: WorkerKind[] = ["fast", "implement", "design", "vision", "research", "trivial"];

export const DEFAULT_CONFIG: WorkflowConfig = {
  enabled: true,
  maxConcurrent: 1,
  maxConcurrentPerProvider: 1,
  timeoutMs: 30 * 60_000,
  maxOutputChars: 8_000,
  maxOutputBytes: 500_000,
  maxOutputLines: 5_000,
  maxRetries: 1,
  persistArtifacts: true,
  persistState: true,
  recoverInterrupted: true,
  isolation: true,
  isolationBackend: "auto",
  agentIdleTtlMs: 7 * 60_000,
  softRequestBudget: 200,
  maxDepth: 3,
  maxChildrenPerWorker: 4,
  maxTotalWorkers: 32,
  maxNestedConcurrent: 8,
  profiles: {
    fast: { kind: "fast", label: "Fast worker", model: "", thinking: "low", description: "Fast repository exploration, tests, simple edits, and log collection.", spawns: ["trivial"] },
    implement: { kind: "implement", label: "Implementation worker", model: "", thinking: "medium", description: "Multi-file implementation, debugging, and substantive code changes.", spawns: ["fast", "research", "trivial"] },
    design: { kind: "design", label: "Design worker", model: "", thinking: "high", description: "Architecture, API, UI, and design trade-offs.", spawns: ["fast", "research", "trivial"] },
    vision: { kind: "vision", label: "Vision worker", model: "", thinking: "medium", description: "Screenshots, diagrams, visual regressions, and image-grounded inspection.", spawns: ["fast", "trivial"] },
    research: { kind: "research", label: "Research worker", model: "", thinking: "medium", description: "Literature, code archaeology, mathematical reasoning, and evidence gathering.", web: true, spawns: ["research", "trivial"] },
    trivial: { kind: "trivial", label: "Trivial worker", model: "", thinking: "off", description: "Small read-only questions, summaries, formatting, and mechanical work." },
  },
};

function mergeConfig(base: WorkflowConfig, value: unknown): WorkflowConfig {
  if (!value || typeof value !== "object") return base;
  const raw = value as Record<string, unknown>;
  const profiles = { ...base.profiles };
  if (raw.profiles && typeof raw.profiles === "object") {
    for (const [kind, candidate] of Object.entries(raw.profiles as Record<string, unknown>)) {
      if (!candidate || typeof candidate !== "object" || !/^[a-z][a-z0-9_-]{0,31}$/i.test(kind)) continue;
      const item = candidate as Record<string, unknown>;
      const current = profiles[kind] ?? {
        kind,
        label: kind,
        model: "",
        thinking: "medium" as ThinkingLevel,
        description: `User-defined ${kind} worker.`,
      };
      profiles[kind] = {
        ...current,
        kind,
        ...(typeof item.model === "string" ? { model: item.model } : {}),
        ...(typeof item.fallback === "string"
          ? { fallback: item.fallback }
          : Array.isArray(item.fallback)
            ? { fallback: item.fallback.filter((model): model is string => typeof model === "string" && model.trim().length > 0).slice(0, 3) }
            : {}),
        ...(typeof item.thinking === "string" && ["off", "minimal", "low", "medium", "high", "xhigh"].includes(item.thinking) ? { thinking: item.thinking as ThinkingLevel } : {}),
        ...(typeof item.label === "string" && item.label ? { label: item.label } : {}),
        ...(typeof item.description === "string" && item.description ? { description: item.description } : {}),
        ...(typeof item.instructions === "string" && item.instructions ? { instructions: item.instructions } : {}),
        ...(Array.isArray(item.triggers) ? { triggers: item.triggers.filter((trigger): trigger is string => typeof trigger === "string" && trigger.trim().length > 0).slice(0, 32) } : {}),
        ...(typeof item.priority === "number" && Number.isFinite(item.priority) ? { priority: item.priority } : {}),
        ...(typeof item.web === "boolean" ? { web: item.web } : {}),
        ...(Array.isArray(item.tools) ? { tools: item.tools.filter((tool): tool is string => typeof tool === "string" && tool.trim().length > 0) } : {}),
        ...(item.spawns === "*" ? { spawns: "*" as const } : Array.isArray(item.spawns) ? { spawns: item.spawns.filter((agent): agent is string => typeof agent === "string" && agent.trim().length > 0) } : {}),
        ...(typeof item.blocking === "boolean" ? { blocking: item.blocking } : {}),
        ...(Array.isArray(item.autoloadSkills) ? { autoloadSkills: item.autoloadSkills.filter((skill): skill is string => typeof skill === "string" && skill.trim().length > 0) } : {}),
        ...(Array.isArray(item.extensions) ? { extensions: item.extensions.filter((extension): extension is string => typeof extension === "string" && extension.trim().length > 0) } : {}),
        ...(item.output !== undefined ? { output: item.output } : {}),
      };
    }
  }
  return {
    ...base,
    ...(typeof raw.enabled === "boolean" ? { enabled: raw.enabled } : {}),
    ...(Number.isInteger(raw.maxConcurrent) && Number(raw.maxConcurrent) >= 1 && Number(raw.maxConcurrent) <= 8 ? { maxConcurrent: Number(raw.maxConcurrent) } : {}),
    ...(Number.isInteger(raw.maxConcurrentPerProvider) && Number(raw.maxConcurrentPerProvider) >= 1 && Number(raw.maxConcurrentPerProvider) <= 8 ? { maxConcurrentPerProvider: Number(raw.maxConcurrentPerProvider) } : {}),
    ...(Number.isInteger(raw.timeoutMs) && Number(raw.timeoutMs) >= 10_000 && Number(raw.timeoutMs) <= 12 * 60 * 60_000 ? { timeoutMs: Number(raw.timeoutMs) } : {}),
    ...(Number.isInteger(raw.maxOutputChars) && Number(raw.maxOutputChars) >= 1000 && Number(raw.maxOutputChars) <= 100_000 ? { maxOutputChars: Number(raw.maxOutputChars) } : {}),
    ...(Number.isInteger(raw.maxOutputBytes) && Number(raw.maxOutputBytes) >= 10_000 && Number(raw.maxOutputBytes) <= 5_000_000 ? { maxOutputBytes: Number(raw.maxOutputBytes) } : {}),
    ...(Number.isInteger(raw.maxOutputLines) && Number(raw.maxOutputLines) >= 100 && Number(raw.maxOutputLines) <= 50_000 ? { maxOutputLines: Number(raw.maxOutputLines) } : {}),
    ...(Number.isInteger(raw.maxRetries) && Number(raw.maxRetries) >= 0 && Number(raw.maxRetries) <= 3 ? { maxRetries: Number(raw.maxRetries) } : {}),
    ...(typeof raw.persistArtifacts === "boolean" ? { persistArtifacts: raw.persistArtifacts } : {}),
    ...(typeof raw.persistState === "boolean" ? { persistState: raw.persistState } : {}),
    ...(typeof raw.recoverInterrupted === "boolean" ? { recoverInterrupted: raw.recoverInterrupted } : {}),
    ...(typeof raw.isolation === "boolean" ? { isolation: raw.isolation } : {}),
    ...(typeof raw.isolationBackend === "string" && ["auto", "git-worktree", "apfs-clone", "reflink", "btrfs", "zfs", "overlay"].includes(raw.isolationBackend) ? { isolationBackend: raw.isolationBackend as WorkflowConfig["isolationBackend"] } : {}),
    ...(Number.isInteger(raw.agentIdleTtlMs) && Number(raw.agentIdleTtlMs) >= 0 && Number(raw.agentIdleTtlMs) <= 24 * 60 * 60_000 ? { agentIdleTtlMs: Number(raw.agentIdleTtlMs) } : {}),
    ...(Number.isInteger(raw.softRequestBudget) && Number(raw.softRequestBudget) >= 0 && Number(raw.softRequestBudget) <= 1000 ? { softRequestBudget: Number(raw.softRequestBudget) } : {}),
    ...(Number.isInteger(raw.maxDepth) && Number(raw.maxDepth) >= 0 && Number(raw.maxDepth) <= 8 ? { maxDepth: Number(raw.maxDepth) } : {}),
    ...(Number.isInteger(raw.maxChildrenPerWorker) && Number(raw.maxChildrenPerWorker) >= 0 && Number(raw.maxChildrenPerWorker) <= 32 ? { maxChildrenPerWorker: Number(raw.maxChildrenPerWorker) } : {}),
    ...(Number.isInteger(raw.maxTotalWorkers) && Number(raw.maxTotalWorkers) >= 1 && Number(raw.maxTotalWorkers) <= 256 ? { maxTotalWorkers: Number(raw.maxTotalWorkers) } : {}),
    ...(Number.isInteger(raw.maxNestedConcurrent) && Number(raw.maxNestedConcurrent) >= 1 && Number(raw.maxNestedConcurrent) <= 64 ? { maxNestedConcurrent: Number(raw.maxNestedConcurrent) } : {}),
    profiles,
  };
}

async function readJson(path: string): Promise<unknown | undefined> {
  try { return JSON.parse(await readFile(path, "utf8")); } catch { return undefined; }
}

export async function loadConfig(ctx: Pick<ExtensionContext, "cwd">): Promise<WorkflowConfig> {
  const globalPath = join(homedir(), ".pi", "agent", CONFIG_NAME);
  const localPath = join(ctx.cwd, CONFIG_DIR_NAME, CONFIG_NAME);
  const discovered = await discoverAgentProfiles(ctx.cwd);
  let config: WorkflowConfig = { ...DEFAULT_CONFIG, profiles: { ...DEFAULT_CONFIG.profiles } };
  for (const profile of [...discovered].reverse()) config.profiles[profile.kind] = profile;
  if (existsSync(globalPath)) config = mergeConfig(config, await readJson(globalPath));
  if (existsSync(localPath)) config = mergeConfig(config, await readJson(localPath));
  return config;
}

export function profileSummary(config: WorkflowConfig): string[] {
  return Object.keys(config.profiles).map((kind) => {
    const p = config.profiles[kind];
    const model = p.model || "<not configured>";
    const triggers = p.triggers?.length ? ` [${p.triggers.join(", ")}]` : "";
    return `${kind.padEnd(12)} ${model} (${p.thinking}) — ${p.description}${triggers}`;
  });
}