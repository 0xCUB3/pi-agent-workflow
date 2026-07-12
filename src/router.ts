import type { RouteDecision, RouteInput, WorkerKind, WorkflowConfig } from "./types.js";

const word = (text: string, pattern: RegExp) => pattern.test(text);

/** Deterministic routing keeps model selection inspectable and testable. */
export function routeTask(input: RouteInput, config: WorkflowConfig): RouteDecision {
  const text = input.task.toLowerCase();
  let kind: WorkerKind;
  let reason: string;

  if (input.hasImages || (input.imageCount ?? 0) > 0 || word(text, /screenshot|image|diagram|photo|visual regression|pixel|layout from|look at this/)) {
    kind = "vision";
    reason = "visual input or visual inspection requested";
  } else if (word(text, /design|architect|architecture|trade-?off|api shape|schema design|ui|ux|component design|system design/)) {
    kind = "design";
    reason = "architecture, API, or UI design language detected";
  } else if (word(text, /paper|arxiv|literature|citation|prove|theorem|derive|mathematical|research|survey|compare sources|code archaeology/)) {
    kind = "research";
    reason = "research or mathematical reasoning language detected";
  } else if (word(text, /implement|build|add|update|change|modify|refactor|debug|fix|feature|migration|endpoint|hook|class|function|multi-file|write code/)) {
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
  return ({ fast: "FAST", implement: "IMPLEMENT", design: "DESIGN", vision: "VISION", research: "RESEARCH", trivial: "TRIVIAL" })[kind];
}