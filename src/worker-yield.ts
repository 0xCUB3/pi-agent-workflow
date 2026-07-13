import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const NUMBER_WORDS: Record<string, number> = {
  one: 1, two: 2, three: 3, four: 4, five: 5,
  six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
};

function countWords(text: string): number {
  const withoutBulletMarkers = text.replace(/^\s*[-*]\s+/gm, "").trim();
  return withoutBulletMarkers ? withoutBulletMarkers.split(/\s+/).length : 0;
}

/** Returns focused retry feedback for explicit, mechanically checkable output constraints. */
export function outputConstraintError(task: string, result: string): string | undefined {
  const bulletMatch = task.match(/\bexactly\s+(\d+|one|two|three|four|five|six|seven|eight|nine|ten)\s+(?:concise\s+)?bullets?\b/i);
  const expectedBullets = bulletMatch
    ? (/^\d+$/.test(bulletMatch[1]) ? Number(bulletMatch[1]) : NUMBER_WORDS[bulletMatch[1].toLowerCase()])
    : undefined;
  const bulletCount = result.split("\n").filter((line) => /^\s*[-*]\s+\S/.test(line)).length;
  if (expectedBullets !== undefined && bulletCount !== expectedBullets) {
    return `The assignment requires exactly ${expectedBullets} bullets, but result contains ${bulletCount}. Rewrite result only, with exactly ${expectedBullets} bullet lines.`;
  }

  const explicitWords = task.match(/\bat most\s+(\d+)\s+words?(?:\s+total)?\b/i);
  const maxWords = explicitWords
    ? Number(explicitWords[1])
    : (/\bconcise\b/i.test(task) && expectedBullets !== undefined ? expectedBullets * 35 : undefined);
  const words = countWords(result);
  if (maxWords !== undefined && words > maxWords) {
    return `The assignment permits at most ${maxWords} words in result, but result contains ${words}. Preserve the strongest verified facts and exact identifiers, remove secondary details, and retry workflow_yield with a shorter result.`;
  }
  return undefined;
}

/** Final structured handoff tool loaded only inside delegated workers. */
export default function workerYield(pi: ExtensionAPI) {
  let currentTask = process.env.PI_WORKFLOW_TASK ?? "";
  let outputSchema: Record<string, unknown> | undefined;
  try { const parsed = JSON.parse(process.env.PI_WORKFLOW_OUTPUT_SCHEMA ?? "null"); if (parsed && typeof parsed === "object") outputSchema = parsed; } catch { /* invalid schemas fall back to the standard handoff */ }
  pi.on("input", (event) => { if (event.source === "rpc" && event.text.trim()) currentTask = event.text; });
  pi.on("before_agent_start", (event) => { if (event.prompt.trim()) currentTask = event.prompt; });
  const parameters: any = outputSchema
    ? Type.Object({
        status: Type.String({ description: "completed or blocked" }),
        data: Type.Unsafe(outputSchema as any),
      })
    : Type.Object({
        status: Type.String({ description: "completed or blocked" }),
        result: Type.String({ description: "Only the requested deliverable, obeying exact format, item count, and length constraints. Silently count items and words first; target no more than about 60% of any stated maximum. No preamble, process narration, duplicate summary, or extra sections. When blocked, give the exact blocker." }),
        changes: Type.Array(Type.String(), { description: "Files or artifacts changed; empty for read-only work." }),
        validation: Type.Array(Type.String(), { description: "Commands/checks run and their observed outcomes." }),
        risks: Type.Array(Type.String(), { description: "Remaining uncertainty or risk; empty when none is known." }),
        nextStep: Type.String({ description: "Recommended next action, or none." }),
      });
  pi.registerTool({
    name: "workflow_yield",
    label: "Yield worker result",
    description: outputSchema ? "Finish by yielding data that exactly matches the configured output schema." : "Finish the delegated assignment with a structured, evidence-focused handoff to the parent. Call exactly once at the end.",
    parameters,
    async execute(_id, params: any) {
      const status = String(params.status).toLowerCase() === "completed" ? "completed" : "blocked";
      const constraintError = outputSchema ? undefined : outputConstraintError(currentTask, params.result);
      if (constraintError) {
        return {
          content: [{ type: "text", text: constraintError }],
          details: undefined,
          isError: true,
        };
      }
      return {
        content: [{ type: "text", text: `Structured worker handoff recorded (${status}).` }],
        details: { ...params, status },
        terminate: true,
      };
    },
  });
}