import { BUILT_IN_KINDS } from "./config.js";
import type { RouteDecision, RouteInput, WorkerKind, WorkflowConfig } from "./types.js";

const word = (text: string, pattern: RegExp) => pattern.test(text);

/** Deterministic routing keeps model selection inspectable and testable. */
function triggerMatches(text: string, trigger: string): boolean {
  const normalized = trigger.trim().toLowerCase();
  if (!normalized) return false;
  return normalized.includes(" ") ? text.includes(normalized) : new RegExp(`\\b${normalized.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\\\$&")}\\b`, "i").test(text);
}

export function routeTask(input: RouteInput, config: WorkflowConfig): RouteDecision {
  const text = input.task.toLowerCase();
  const customMatches = Object.entries(config.profiles)
    .filter(([kind, profile]) => !BUILT_IN_KINDS.includes(kind) && (profile.triggers?.length ?? 0) > 0)
    .map(([kind, profile]) => ({ kind, profile, matches: (profile.triggers ?? []).filter((trigger) => triggerMatches(text, trigger)) }))
    .filter((candidate) => candidate.matches.length > 0)
    .sort((a, b) => (b.matches.length * 100 + (b.profile.priority ?? 0)) - (a.matches.length * 100 + (a.profile.priority ?? 0)));
  if (customMatches.length) {
    const selected = customMatches[0];
    return { kind: selected.kind, reason: `user profile matched: ${selected.matches.join(", ")}`, profile: selected.profile };
  }
  let kind: WorkerKind;
  let reason: string;
  const explicitlyReadOnly = word(text, /\bread[- ]only\b|\bdo not (?:modify|edit|change|write)\b|\bdon't (?:modify|edit|change|write)\b|\bno (?:file )?changes\b|\bwithout (?:modifying|editing|changing|writing)\b/);

  if (input.hasImages || (input.imageCount ?? 0) > 0 || word(text, /\b(?:screenshot|image|diagram|photo|visual regression|pixel|layout from|look at this)\b/)) {
    kind = "vision";
    reason = "visual input or visual inspection requested";
  } else if (word(text, /\b(?:design|architect|architecture|trade-?offs?|api shape|schema design|ui|ux|component design|system design)\b/)) {
    kind = "design";
    reason = "architecture, API, or UI design language detected";
  } else if (word(text, /\b(?:papers?|arxiv|literature|citations?|prove|theorem|derive|mathematical|research|survey|compare sources|code archaeology)\b/)) {
    kind = "research";
    reason = "research or mathematical reasoning language detected";
  } else if (explicitlyReadOnly || (word(text, /inspect|search|find|check|identify|determine|report|whether|only .*update|no .*change/) && !word(text, /\b(implement|build|add|edit|modify|refactor|debug|fix|feature|migration|endpoint|hook|class|function|write code)\b/))) {
    kind = "fast";
    reason = "read-only repository inspection or evidence gathering detected";
  } else if (word(text, /\b(?:implement|build|add|update|change|modify|refactor|debug|fix|feature|migration|endpoint|hook|class|function|multi-file|write code)\b/)) {
    kind = "implement";
    reason = "substantive implementation language detected";
  } else if (word(text, /grep|find|search|inspect|list files|summarize|explain this file|run tests|check status|format|rename|mechanical|read-only/)) {
    kind = "fast";
    reason = "exploration, validation, or bounded mechanical work detected";
  } else {
    kind = "trivial";
    reason = "small or ambiguous task defaults to the lowest-cost worker";
  }

  return { kind, reason, profile: config.profiles[kind] };
}

export function routeLabel(kind: WorkerKind): string {
  return ({ fast: "FAST", implement: "IMPLEMENT", design: "DESIGN", vision: "VISION", research: "RESEARCH", trivial: "TRIVIAL" } as Record<string, string>)[kind] ?? kind.replace(/[-_]+/g, " ").toUpperCase();
}