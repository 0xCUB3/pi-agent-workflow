import { readdir, readFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { homedir } from "node:os";
import { parseDocument } from "yaml";
import type { ThinkingLevel, WorkerProfile } from "./types.js";

function frontmatter(source: string): { data: Record<string, unknown>; body: string } {
  if (!source.startsWith("---\n")) return { data: {}, body: source.trim() };
  const end = source.indexOf("\n---", 4);
  if (end < 0) return { data: {}, body: source.trim() };
  try {
    const value = parseDocument(source.slice(4, end)).toJS({ maxAliasCount: 20 }) as unknown;
    return { data: value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}, body: source.slice(end + 4).trim() };
  } catch {
    return { data: {}, body: source.slice(end + 4).trim() };
  }
}

function strings(value: unknown): string[] | undefined {
  if (Array.isArray(value)) return value.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
  if (typeof value === "string" && value.trim()) return value.split(",").map((item) => item.trim()).filter(Boolean);
  return undefined;
}

export function parseAgentProfile(path: string, source: string, level: "user" | "project"): WorkerProfile | undefined {
  const { data, body } = frontmatter(source);
  const kind = String(data.name ?? basename(path, ".md")).trim();
  if (!/^[a-z][a-z0-9_-]{0,31}$/i.test(kind)) return undefined;
  const models = strings(data.model) ?? (typeof data.model === "string" ? [data.model] : []);
  const thinking = typeof data.thinking === "string" && ["off", "minimal", "low", "medium", "high", "xhigh"].includes(data.thinking)
    ? data.thinking as ThinkingLevel : "medium";
  const spawns = data.spawns === "*" ? "*" : strings(data.spawns);
  return {
    kind,
    label: typeof data.label === "string" ? data.label : `${kind} worker`,
    model: models[0] ?? "",
    fallback: models.length > 1 ? models.slice(1, 4) : undefined,
    thinking,
    description: typeof data.description === "string" ? data.description : `Project-defined ${kind} worker.`,
    instructions: body || undefined,
    triggers: strings(data.triggers),
    priority: typeof data.priority === "number" ? data.priority : undefined,
    web: typeof data.web === "boolean" ? data.web : undefined,
    tools: strings(data.tools),
    spawns,
    blocking: typeof data.blocking === "boolean" ? data.blocking : undefined,
    autoloadSkills: strings(data.autoloadSkills ?? data.skills),
    extensions: strings(data.extensions)?.map((extension) => isAbsolute(extension) ? extension : resolve(dirname(path), extension)),
    output: data.output,
    source: level,
    filePath: path,
  };
}

async function loadDir(dir: string, level: "user" | "project"): Promise<WorkerProfile[]> {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  const profiles = await Promise.all(entries.filter((entry) => entry.isFile() && entry.name.endsWith(".md")).sort((a, b) => a.name.localeCompare(b.name)).map(async (entry) => {
    const path = join(dir, entry.name);
    try { return parseAgentProfile(path, await readFile(path, "utf8"), level); } catch { return undefined; }
  }));
  return profiles.filter((profile): profile is WorkerProfile => Boolean(profile));
}

/** Discover Pi- and OMP-style markdown agents. First definition wins. */
export async function discoverAgentProfiles(cwd: string, home = homedir()): Promise<WorkerProfile[]> {
  const roots: Array<[string, "user" | "project"]> = [
    [join(cwd, ".pi", "agents"), "project"],
    [join(cwd, ".omp", "agents"), "project"],
    [join(home, ".pi", "agent", "agents"), "user"],
    [join(home, ".omp", "agent", "agents"), "user"],
  ];
  const seen = new Set<string>();
  const result: WorkerProfile[] = [];
  for (const [dir, level] of roots) for (const profile of await loadDir(dir, level)) {
    if (seen.has(profile.kind)) continue;
    seen.add(profile.kind);
    result.push(profile);
  }
  return result;
}