import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ThinkingLevel, WorkerKind, WorkerProfile, WorkflowConfig } from "./types.js";

export const CONFIG_NAME = "agent-workflow.json";
export const BUILT_IN_KINDS: WorkerKind[] = ["fast", "implement", "design", "vision", "research", "trivial"];

export const DEFAULT_CONFIG: WorkflowConfig = {
  enabled: true,
  maxConcurrent: 1,
  timeoutMs: 30 * 60_000,
  maxOutputChars: 8_000,
  maxRetries: 1,
  persistArtifacts: true,
  profiles: {
    fast: { kind: "fast", label: "Fast worker", model: "", thinking: "low", description: "Fast repository exploration, tests, simple edits, and log collection." },
    implement: { kind: "implement", label: "Implementation worker", model: "", thinking: "medium", description: "Multi-file implementation, debugging, and substantive code changes." },
    design: { kind: "design", label: "Design worker", model: "", thinking: "high", description: "Architecture, API, UI, and design trade-offs." },
    vision: { kind: "vision", label: "Vision worker", model: "", thinking: "medium", description: "Screenshots, diagrams, visual regressions, and image-grounded inspection." },
    research: { kind: "research", label: "Research worker", model: "", thinking: "medium", description: "Literature, code archaeology, mathematical reasoning, and evidence gathering." },
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
        ...(typeof item.fallback === "string" ? { fallback: item.fallback } : {}),
        ...(typeof item.thinking === "string" && ["off", "minimal", "low", "medium", "high", "xhigh"].includes(item.thinking) ? { thinking: item.thinking as ThinkingLevel } : {}),
        ...(typeof item.label === "string" && item.label ? { label: item.label } : {}),
        ...(typeof item.description === "string" && item.description ? { description: item.description } : {}),
        ...(typeof item.instructions === "string" && item.instructions ? { instructions: item.instructions } : {}),
        ...(Array.isArray(item.triggers) ? { triggers: item.triggers.filter((trigger): trigger is string => typeof trigger === "string" && trigger.trim().length > 0).slice(0, 32) } : {}),
        ...(typeof item.priority === "number" && Number.isFinite(item.priority) ? { priority: item.priority } : {}),
      };
    }
  }
  return {
    ...base,
    ...(typeof raw.enabled === "boolean" ? { enabled: raw.enabled } : {}),
    ...(Number.isInteger(raw.maxConcurrent) && Number(raw.maxConcurrent) >= 1 && Number(raw.maxConcurrent) <= 8 ? { maxConcurrent: Number(raw.maxConcurrent) } : {}),
    ...(Number.isInteger(raw.timeoutMs) && Number(raw.timeoutMs) >= 10_000 && Number(raw.timeoutMs) <= 12 * 60 * 60_000 ? { timeoutMs: Number(raw.timeoutMs) } : {}),
    ...(Number.isInteger(raw.maxOutputChars) && Number(raw.maxOutputChars) >= 1000 && Number(raw.maxOutputChars) <= 100_000 ? { maxOutputChars: Number(raw.maxOutputChars) } : {}),
    ...(Number.isInteger(raw.maxRetries) && Number(raw.maxRetries) >= 0 && Number(raw.maxRetries) <= 3 ? { maxRetries: Number(raw.maxRetries) } : {}),
    ...(typeof raw.persistArtifacts === "boolean" ? { persistArtifacts: raw.persistArtifacts } : {}),
    profiles,
  };
}

async function readJson(path: string): Promise<unknown | undefined> {
  try { return JSON.parse(await readFile(path, "utf8")); } catch { return undefined; }
}

export async function loadConfig(ctx: Pick<ExtensionContext, "cwd">): Promise<WorkflowConfig> {
  const globalPath = join(homedir(), ".pi", "agent", CONFIG_NAME);
  const localPath = join(ctx.cwd, ".pi", CONFIG_NAME);
  let config = DEFAULT_CONFIG;
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