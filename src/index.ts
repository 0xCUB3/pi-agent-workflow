import { randomUUID } from "node:crypto";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { loadConfig, profileSummary } from "./config.js";
import { routeLabel, routeTask } from "./router.js";
import { createQueue, runJob, type ImageAttachment } from "./runtime.js";
import type { Job } from "./types.js";

const WORKFLOW_PROMPT = `
## pi-agent-workflow delegation
You are the orchestrator. You have one delegation tool, delegate_work, that launches a bounded worker using an automatically selected model.

Delegation is proactive by default. When a request involves repository exploration, implementation, testing, visual inspection, research, or repetitive work that can be done independently, call delegate_work without waiting for the user to say “delegate”. Keep each delegation narrow and verifiable. Do not delegate tiny questions, direct explanations, or conversation that you can answer directly. If the user explicitly says not to delegate, not to use a worker/subagent, or to do it yourself, do not call delegate_work for that turn.

Routing is automatic: visual input goes to the vision worker; architecture/UI goes to the design worker; substantive code goes to the implementation worker; research/math goes to the research worker; exploration/tests go to the fast worker; tiny mechanical work goes to the trivial worker. Do not ask the user to choose a model.

Treat worker output as evidence, never as authority. Inspect the actual diff and validation yourself before claiming success. If a worker fails, narrow the task or retry; never paper over an incomplete result. The worker must not recursively delegate.
`;

function formatJob(job: Job): string {
  const icon = job.status === "succeeded" ? "✓" : job.status === "failed" ? "✗" : job.status === "cancelled" ? "■" : job.status === "running" ? "●" : "○";
  const duration = job.startedAt && job.finishedAt ? ` ${Math.max(0, Date.parse(job.finishedAt) - Date.parse(job.startedAt)) / 1000}s` : "";
  const activity = job.currentTool ? ` · ${job.currentTool}` : job.lastEvent ? ` · ${job.lastEvent}` : "";
  const rawTask = job.task.replace(/\s+/g, " ").trim();
  const task = rawTask.slice(0, 52);
  const model = job.decision.profile.model.split("/").at(-1) || job.decision.profile.model;
  return `${icon} ${job.id} ${routeLabel(job.decision.kind).toLowerCase()} · ${task}${task.length < rawTask.length ? "…" : ""} · ${model}${activity}${duration}`;
}

function widgetLines(jobs: Map<string, Job>): string[] {
  const active = [...jobs.values()].filter((job) => job.status === "queued" || job.status === "running");
  const recent = [...jobs.values()].filter((job) => job.status === "succeeded" || job.status === "failed" || job.status === "cancelled").slice(-3).reverse();
  if (!active.length && !recent.length) return [];
  return [
    "╭─ workflow",
    ...active.map(formatJob),
    ...(recent.length ? ["┊ recent", ...recent.map(formatJob)] : []),
    "╰─ /workflow status · /workflow stop",
  ];
}

export default function piAgentWorkflow(pi: ExtensionAPI) {
  const jobs = new Map<string, Job>();
  const controllers = new Map<string, AbortController>();
  let config = undefined as Awaited<ReturnType<typeof loadConfig>> | undefined;
  let latestImages: ImageAttachment[] = [];
  let delegationOptOut = false;
  let queue: ReturnType<typeof createQueue> | undefined;

  const refresh = (ctx: ExtensionContext) => {
    const lines = widgetLines(jobs);
    ctx.ui.setWidget("pi-agent-workflow", lines.length ? lines : undefined, { placement: "aboveEditor" });
    const active = [...jobs.values()].filter((job) => job.status === "queued" || job.status === "running").length;
    ctx.ui.setStatus("pi-agent-workflow", active ? `workers ${active}` : undefined);
  };

  pi.on("session_start", async (_event, ctx) => {
    config = await loadConfig(ctx);
    queue = createQueue(config.maxConcurrent);
    latestImages = [];
    refresh(ctx);
  });

  pi.on("input", async (event) => {
    const text = typeof event.text === "string" ? event.text : "";
    delegationOptOut = /\b(?:don['’]t|do not|without|no)\b[\s\S]{0,40}\b(?:delegate|worker|subagent|agent)\b/i.test(text) || /\bdo it yourself\b/i.test(text);
    latestImages = Array.isArray(event.images) ? event.images.map((image: any) => ({ data: String(image.data ?? image.source?.data ?? ""), mimeType: image.mimeType ?? image.source?.mediaType })).filter((image) => image.data) : [];
    return undefined;
  });

  pi.on("before_agent_start", async (event, ctx) => {
    if (!config) config = await loadConfig(ctx);
    if (!config.enabled) return undefined;
    const imageNote = latestImages.length ? `\nThis turn has ${latestImages.length} image attachment(s). If work is needed, delegate visual perception before asking a non-vision worker to reason about the result.` : "";
    const optOutNote = delegationOptOut ? "\nIMPORTANT: The user opted out of delegation for this turn. Do the work in this parent session and do not call delegate_work." : "";
    return { systemPrompt: event.systemPrompt + WORKFLOW_PROMPT + imageNote + optOutNote };
  });

  pi.registerTool({
    name: "delegate_work",
    label: "Delegate work",
    description: "Delegate one bounded coding, research, testing, design, exploration, or visual-perception task. The extension automatically chooses the cheapest suitable worker model, retries with a fallback, tracks the run, and returns a concise evidence report. Use this proactively for substantial independent work; never specify a model.",
    parameters: Type.Object({
      task: Type.String({ description: "A bounded task with clear files/scope, validation expectations, and a concise desired report." }),
    }),
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      if (!config) config = await loadConfig(ctx);
      if (delegationOptOut) return { content: [{ type: "text", text: "Delegation skipped: the user opted out for this turn." }], details: { skipped: true, reason: "user_opt_out" } };
      if (!config.enabled) return { content: [{ type: "text", text: "Delegation is disabled in .pi/agent-workflow.json." }], details: { disabled: true } };
      const decision = routeTask({ task: params.task, hasImages: latestImages.length > 0, imageCount: latestImages.length }, config);
      const job: Job = { id: `w${randomUUID().slice(0, 8)}`, task: params.task, decision, status: "queued", attempts: 0 };
      jobs.set(job.id, job);
      const controller = new AbortController();
      const parentSignal = signal ?? new AbortController().signal;
      if (parentSignal.aborted) controller.abort();
      controllers.set(job.id, controller);
      const abortOnParent = () => controller.abort();
      parentSignal.addEventListener("abort", abortOnParent, { once: true });
      refresh(ctx);
      try {
        const run = queue ?? createQueue(config.maxConcurrent);
        const result = await run(() => runJob({ pi, ctx, config: config!, jobs, render: () => refresh(ctx) }, job, latestImages, controller.signal));
        const heading = `${result.status === "succeeded" ? "Worker complete" : "Worker did not complete"} · ${result.id} · ${routeLabel(result.decision.kind)} · ${result.decision.profile.model}`;
        const body = result.status === "succeeded" ? result.output ?? "Worker returned no report." : `Error: ${result.error ?? "unknown worker failure"}`;
        return { content: [{ type: "text", text: `${heading}\nRouting: ${result.decision.reason}\nAttempts: ${result.attempts}\n\n${body}` }], details: { job: result } };
      } finally {
        parentSignal.removeEventListener("abort", abortOnParent);
        controllers.delete(job.id);
        refresh(ctx);
      }
    },
  });

  pi.registerCommand("workflow", {
    description: "Show or configure pi-agent-workflow",
    handler: async (args, ctx) => {
      if (!config) config = await loadConfig(ctx);
      const command = args.trim().split(/\s+/, 1)[0] || "status";
      if (command === "stop") {
        for (const controller of controllers.values()) controller.abort();
        ctx.ui.notify("Stopping active workers…", "info");
        return;
      }
      if (command === "config") {
        ctx.ui.notify([`Concurrency: ${config.maxConcurrent}`, `Timeout: ${Math.round(config.timeoutMs / 60_000)}m`, `Retries: ${config.maxRetries}`, ...profileSummary(config)].join("\n"), "info");
        return;
      }
      if (command === "status") {
        const lines = [...jobs.values()].slice(-10).map(formatJob);
        ctx.ui.notify(lines.length ? lines.join("\n") : "No workflow runs yet.", "info");
        return;
      }
      ctx.ui.notify("Usage: /workflow status | /workflow config | /workflow stop", "info");
    },
  });
}