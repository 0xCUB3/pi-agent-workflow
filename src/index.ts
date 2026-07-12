import { randomUUID } from "node:crypto";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { isKeyRelease, Key, matchesKey, truncateToWidth } from "@earendil-works/pi-tui";
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

const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const TOOL_ACTIVITY: Record<string, string> = { read: "reading", bash: "running command", edit: "editing", write: "writing" };

type WorkflowTheme = { fg(color: string, text: string): string; bold(text: string): string };

function jobTask(job: Job): string {
  const raw = job.task.replace(/\s+/g, " ").trim();
  return raw.length > 58 ? `${raw.slice(0, 58)}…` : raw;
}

function jobDuration(job: Job): string {
  const started = job.startedAt ? Date.parse(job.startedAt) : Date.now();
  const ended = job.finishedAt ? Date.parse(job.finishedAt) : Date.now();
  return `${((ended - started) / 1000).toFixed(1)}s${job.finishedAt ? "" : " (running)"}`;
}

function jobActivity(job: Job): string {
  if (job.currentTool) return `${TOOL_ACTIVITY[job.currentTool] ?? job.currentTool}…`;
  if (job.lastEvent === "reporting") return "reporting…";
  if (job.lastEvent?.startsWith("done:")) return "thinking…";
  return job.status === "queued" ? "queued" : "thinking…";
}

function isRecentJob(job: Job): boolean {
  return !job.finishedAt || Date.now() - Date.parse(job.finishedAt) < 8_000;
}

function formatJob(job: Job): string {
  const icon = job.status === "succeeded" ? "✓" : job.status === "failed" ? "✗" : job.status === "cancelled" ? "■" : job.status === "running" ? "●" : "○";
  return `${icon} ${job.id} ${routeLabel(job.decision.kind).toLowerCase()} · ${jobTask(job)} · ${jobDuration(job)}`;
}

function renderWorkflowWidget(tui: any, theme: WorkflowTheme, jobs: Map<string, Job>, frame: number): string[] {
  const all = [...jobs.values()];
  const running = all.filter((job) => job.status === "running");
  const queued = all.filter((job) => job.status === "queued");
  const finished = all.filter((job) => ["succeeded", "failed", "cancelled"].includes(job.status) && isRecentJob(job)).slice(-3).reverse();
  if (!running.length && !queued.length && !finished.length) return [];
  const width = tui?.terminal?.columns ?? 120;
  const truncate = (line: string) => truncateToWidth(line, width);
  const lines: string[] = [truncate(theme.fg(running.length || queued.length ? "accent" : "dim", `${running.length || queued.length ? "●" : "○"} Agents`))];
  const body: string[] = [];
  for (const job of running) {
    const model = job.decision.profile.model.split("/").at(-1) || job.decision.profile.model;
    const stats = [`↻${job.attempts}`, `${job.toolUses ?? 0} tool use${job.toolUses === 1 ? "" : "s"}`, jobDuration(job)].join(" · ");
    body.push(truncate(theme.fg("dim", "├─") + ` ${theme.fg("accent", SPINNER[frame % SPINNER.length])} ${theme.bold(routeLabel(job.decision.kind))}  ${theme.fg("muted", jobTask(job))} ${theme.fg("dim", "·")} ${theme.fg("dim", `${model} · ${stats}`)}`));
    body.push(truncate(theme.fg("dim", "│  ") + theme.fg("dim", `  ⎿  ${jobActivity(job)}`)));
  }
  if (queued.length) body.push(truncate(theme.fg("dim", "├─") + ` ${theme.fg("muted", "◦")} ${theme.fg("dim", `${queued.length} queued`)}`));
  for (const job of finished) {
    const icon = job.status === "succeeded" ? theme.fg("success", "✓") : job.status === "cancelled" ? theme.fg("dim", "■") : theme.fg("error", "✗");
    const status = job.status === "succeeded" ? "completed" : job.status;
    body.push(truncate(theme.fg("dim", "├─") + ` ${icon} ${theme.fg("dim", routeLabel(job.decision.kind))}  ${theme.fg("dim", jobTask(job))} ${theme.fg("dim", "·")} ${theme.fg("dim", `${status} · ${job.toolUses ?? 0} tool uses · ${jobDuration(job)}`)}`));
  }
  const max = 11;
  lines.push(...body.slice(0, max));
  if (body.length > max) lines.push(truncate(theme.fg("dim", `└─ +${body.length - max} more`)));
  return lines;
}

function renderFleetWidget(width: number, theme: WorkflowTheme, jobs: Job[], selectedId?: string, active = false): string[] {
  const lines = [truncateToWidth(`  ${theme.fg("dim", active ? "↑↓ select · enter view · esc back" : "esc to interrupt · ↓ to manage")}`, width), "", `  ${theme.fg("accent", selectedId === "main" ? "⏺" : "◯")} main`];
  for (const job of jobs.slice(0, 5)) {
    const selected = selectedId === job.id;
    const icon = job.status === "running" ? "●" : job.status === "queued" ? "◌" : job.status === "succeeded" ? "✓" : "✗";
    const label = `${routeLabel(job.decision.kind).toLowerCase()}  ${jobTask(job)}`;
    const stats = `${jobDuration(job)} · ${job.toolUses ?? 0} tool uses`;
    lines.push(truncateToWidth(`  ${selected ? theme.fg("accent", "⏺") : theme.fg("dim", "◯")} ${theme.fg(selected ? "accent" : "muted", `${icon} ${label}`)}  ${theme.fg("dim", stats)}`, width));
  }
  if (jobs.length > 5) lines.push(truncateToWidth(`  ${theme.fg("dim", `↓ ${jobs.length - 5} more`)}`, width));
  return lines;
}

function renderJobViewer(width: number, theme: WorkflowTheme, job: Job): string[] {
  const lines = [
    theme.bold(`${routeLabel(job.decision.kind)} WORKER · ${job.id}`),
    theme.fg("dim", `${job.decision.profile.model} · ${job.status} · ${jobDuration(job)}`),
    "",
    theme.bold("Task"),
    job.task,
    "",
    theme.bold("Activity"),
    job.currentTool ? `⎿ ${TOOL_ACTIVITY[job.currentTool] ?? job.currentTool}…` : `⎿ ${jobActivity(job)}`,
    "",
    theme.bold(job.status === "failed" ? "Error" : "Result"),
    ...(job.status === "failed" ? [job.error ?? "Unknown worker error"] : [job.output ?? "Worker is still running…"]),
    ...(job.artifactDir ? ["", theme.fg("dim", `artifacts: ${job.artifactDir}`)] : []),
  ];
  return lines.flatMap((line) => line.split("\n").map((part) => truncateToWidth(part, width)));
}

export default function piAgentWorkflow(pi: ExtensionAPI) {
  const jobs = new Map<string, Job>();
  const controllers = new Map<string, AbortController>();
  let config = undefined as Awaited<ReturnType<typeof loadConfig>> | undefined;
  let latestImages: ImageAttachment[] = [];
  let delegationOptOut = false;
  let queue: ReturnType<typeof createQueue> | undefined;
  let widgetRegistered = false;
  let widgetTui: any;
  let widgetFrame = 0;
  let widgetTimer: ReturnType<typeof setInterval> | undefined;
  let fleetRegistered = false;
  let fleetTui: any;
  let fleetInputUnsub: (() => void) | undefined;
  let fleetActive = false;
  let fleetSelected = "main";
  let fleetViewerClose: (() => void) | undefined;
  let fleetViewerTui: any;

  const fleetJobs = () => [...jobs.values()].filter((job) => job.status === "running" || job.status === "queued" || (["succeeded", "failed", "cancelled"].includes(job.status) && isRecentJob(job))).sort((a, b) => (a.startedAt ?? "").localeCompare(b.startedAt ?? ""));

  const openFleetJob = async (ctx: ExtensionContext, job: Job) => {
    fleetViewerClose = undefined;
    await ctx.ui.custom((tui: any, theme: WorkflowTheme, _keys: any, done: (value: undefined) => void) => {
      fleetViewerTui = tui;
      fleetViewerClose = () => done(undefined);
      return {
        render: (width: number) => renderJobViewer(width, theme, job),
        invalidate: () => {},
        dispose: () => { fleetViewerClose = undefined; fleetViewerTui = undefined; },
      };
    }, { overlay: true, overlayOptions: { anchor: "center", width: "90%", maxHeight: "70%" } } as any).catch(() => {}).finally(() => { fleetViewerClose = undefined; fleetViewerTui = undefined; });
  };

  const refreshFleet = (ctx: ExtensionContext) => {
    const listed = fleetJobs();
    if (!listed.length) {
      if (fleetRegistered) ctx.ui.setWidget("pi-agent-workflow-fleet", undefined);
      fleetRegistered = false;
      fleetTui = undefined;
      fleetActive = false;
      fleetInputUnsub?.();
      fleetInputUnsub = undefined;
      return;
    }
    if (!fleetInputUnsub) {
      fleetInputUnsub = ctx.ui.onTerminalInput((data: string) => {
        const current = fleetJobs();
        if (isKeyRelease(data) || fleetViewerClose || !current.length) return undefined;
        if (!fleetActive) {
          if ((matchesKey(data, "down") || matchesKey(data, "left")) && ctx.ui.getEditorText() === "") {
            fleetActive = true;
            fleetSelected = current[0]?.id ?? "main";
            fleetTui?.requestRender();
            return { consume: true };
          }
          return undefined;
        }
        if (matchesKey(data, "escape")) { fleetActive = false; fleetSelected = "main"; fleetTui?.requestRender(); return { consume: true }; }
        if (matchesKey(data, "down")) { const i = current.findIndex((job) => job.id === fleetSelected); fleetSelected = current[Math.min(current.length - 1, i + 1)]?.id ?? fleetSelected; fleetTui?.requestRender(); return { consume: true }; }
        if (matchesKey(data, "up")) { const i = current.findIndex((job) => job.id === fleetSelected); if (i <= 0) { fleetActive = false; fleetSelected = "main"; } else fleetSelected = current[i - 1].id; fleetTui?.requestRender(); return { consume: true }; }
        if (matchesKey(data, Key.enter)) { const job = current.find((item) => item.id === fleetSelected); if (job) void openFleetJob(ctx, job); return { consume: true }; }
        fleetActive = false; fleetSelected = "main"; fleetTui?.requestRender();
        return undefined;
      });
    }
    if (!fleetRegistered) {
      ctx.ui.setWidget("pi-agent-workflow-fleet", ((tui: any, theme: WorkflowTheme) => {
        fleetTui = tui;
        return { render: (width: number) => renderFleetWidget(width, theme, fleetJobs(), fleetSelected, fleetActive), invalidate: () => { fleetRegistered = false; fleetTui = undefined; } };
      }) as any, { placement: "belowEditor" });
      fleetRegistered = true;
    } else fleetTui?.requestRender();
  };

  const refresh = (ctx: ExtensionContext) => {
    const active = [...jobs.values()].filter((job) => job.status === "queued" || job.status === "running");
    const recent = [...jobs.values()].filter((job) => ["succeeded", "failed", "cancelled"].includes(job.status) && isRecentJob(job)).slice(-3);
    if (!active.length && !recent.length) {
      if (widgetRegistered) ctx.ui.setWidget("pi-agent-workflow", undefined);
      widgetRegistered = false;
      widgetTui = undefined;
      if (widgetTimer) { clearInterval(widgetTimer); widgetTimer = undefined; }
      ctx.ui.setStatus("pi-agent-workflow", undefined);
      fleetViewerTui?.requestRender();
      refreshFleet(ctx);
      return;
    }
    ctx.ui.setStatus("pi-agent-workflow", active.length ? `${active.filter((job) => job.status === "running").length} running${active.some((job) => job.status === "queued") ? `, ${active.filter((job) => job.status === "queued").length} queued` : ""}` : undefined);
    if (!widgetTimer) widgetTimer = setInterval(() => { widgetFrame++; widgetTui?.requestRender(); }, 100);
    if (!widgetRegistered) {
      ctx.ui.setWidget("pi-agent-workflow", ((tui: any, theme: WorkflowTheme) => {
        widgetTui = tui;
        return {
          render: () => renderWorkflowWidget(tui, theme, jobs, widgetFrame),
          invalidate: () => { widgetRegistered = false; widgetTui = undefined; },
        };
      }) as any, { placement: "aboveEditor" });
      widgetRegistered = true;
    } else {
      widgetTui?.requestRender();
    }
    fleetViewerTui?.requestRender();
    refreshFleet(ctx);
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
        const cleanup = setTimeout(() => refresh(ctx), 8_100);
        cleanup.unref?.();
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