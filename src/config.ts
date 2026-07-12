import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ThinkingLevel, WorkerKind, WorkerProfile, WorkflowConfig } from "./types.js";

export const CONFIG_NAME = "agent-workflow.json";
const kinds: WorkerKind[] = ["fast", "implement", "design", "vision", "research", "trivial"];

export const DEFAULT_CONFIG: WorkflowConfig = {
  enabled: true,
  maxConcurrent: 1,
  timeoutMs: 30 * 60_000,
  maxOutputChars: 8_000,
  maxRetries: 1,
  persistArtifacts: true,
  profiles: {
    fast: { kind: "fast", label: "Fast worker", model: "electronhub-devpass/gpt-oss-120b:dev", thinking: "low", fallback: "opencode-cli/opencode/deepseek-v4-flash-free", description: "Fast repository exploration, tests, simple edits, and log collection." },
    implement: { kind: "implement", label: "Implementation worker", model: "electronhub-devpass/glm-5.2:dev", thinking: "medium", fallback: "electronhub-devpass/gpt-oss-120b:dev", description: "Multi-file implementation, debugging, and substantive code changes." },
    design: { kind: "design", label: "Design worker", model: "electronhub-devpass/kimi-k2.6:dev", thinking: "high", fallback: "electronhub-devpass/glm-5.2:dev", description: "Architecture, API, UI, and design trade-offs." },
    vision: { kind: "vision", label: "Vision worker", model: "electronhub-devpass/gemma-4-31b-it:dev", thinking: "medium", fallback: "electronhub-devpass/qwen3.6-27b:dev", description: "Screenshots, diagrams, visual regressions, and image-grounded inspection." },
    research: { kind: "research", label: "Research worker", model: "electronhub-devpass/qwen3.6-27b:dev", thinking: "medium", fallback: "electronhub-devpass/gpt-oss-120b:dev", description: "Literature, code archaeology, mathematical reasoning, and evidence gathering." },
    trivial: { kind: "trivial", label: "Trivial worker", model: "opencode-cli/opencode/deepseek-v4-flash-free", thinking: "off", fallback: "electronhub-devpass/gpt-oss-120b:dev", description: "Small read-only questions, summaries, formatting, and mechanical work." },
  },
};

function mergeConfig(base: WorkflowConfig, value: unknown): WorkflowConfig {
  if (!value || typeof value !== "object") return base;
  const raw = value as Record<string, unknown>;
  const profiles = { ...base.profiles };
  if (raw.profiles && typeof raw.profiles === "object") {
    for (const kind of kinds) {
      const candidate = (raw.profiles as Record<string, unknown>)[kind];
      if (!candidate || typeof candidate !== "object") continue;
      const item = candidate as Record<string, unknown>;
      const current = profiles[kind];
      profiles[kind] = {
        ...current,
        ...(typeof item.model === "string" && item.model ? { model: item.model } : {}),
        ...(typeof item.fallback === "string" && item.fallback ? { fallback: item.fallback } : {}),
        ...(typeof item.thinking === "string" && ["off", "minimal", "low", "medium", "high", "xhigh"].includes(item.thinking) ? { thinking: item.thinking as ThinkingLevel } : {}),
        ...(typeof item.label === "string" && item.label ? { label: item.label } : {}),
        ...(typeof item.description === "string" && item.description ? { description: item.description } : {}),
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
  return kinds.map((kind) => {
    const p = config.profiles[kind];
    return `${kind.padEnd(9)} ${p.model} (${p.thinking}) — ${p.description}`;
  });
}