import { randomUUID } from "node:crypto";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { isKeyRelease, matchesKey, truncateToWidth } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { workerFullOutput, workerHistory } from "./artifacts.js";
import { loadConfig, profileSummary } from "./config.js";
import { routeLabel, routeTask } from "./router.js";
import { globalScheduler } from "./scheduler.js";
import { providerOf, protocolErrorFromJsonOutput, runFollowUpJob, runJob, textFromJsonOutput, type ImageAttachment } from "./runtime.js";
import { workerSessionRegistry, type CoordinationRequest, type CoordinationResponse } from "./worker-session.js";
import { coordinationBus, type IrcReceipt } from "./coordination-bus.js";
import { loadWorkflowState, saveWorkflowState } from "./state.js";

import type { Job, WorkflowConfig } from "./types.js";

const WORKFLOW_PROMPT = `
## Pi worker orchestration
You can delegate bounded work to automatically routed Pi workers.

- Use delegate_work for one task and delegate_tasks for independent parallel slices. Do not delegate tiny questions or conversation.
- Respect a user's request not to delegate. Workers may spawn nested children only through declared spawn policy and depth limits.
- Delegation blocks by default. Use async only when the user explicitly requests background execution.
- Use isolated workers for independent mutations; isolation selects a native copy-on-write/snapshot backend when available and falls back to a checked Git worktree with dirty-tree merging.
- Use wait_for_workers for background work, workflow_message to steer or continue a worker, worker_status for inspection, and cancel_workers for cancellation.
- Workers coordinate through workflow_send, workflow_inbox, workflow_wait, and workflow_spawn. A worker can await a reply from Main; use workflow_reply to answer it.
- workflow_resource reads agent://<job-id>/result, agent://<job-id>/history, and history://<job-id> resources.
- worker_history reads a worker's durable transcript; worker_result retrieves its untruncated report. Prefer continuing an existing worker when it already has the relevant context.
- Treat every worker report as evidence, not authority. Inspect diffs and validation before claiming success.
`;

const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const TOOL_ACTIVITY: Record<string, string> = { read: "reading files", bash: "running a command", edit: "editing files", write: "writing a file", web_search: "searching the web", fetch_content: "fetching a source", get_search_content: "reading search results", workflow_peers: "listing worker peers", workflow_send: "messaging a worker", workflow_inbox: "reading worker inbox", workflow_wait: "waiting for a worker message", workflow_resource: "reading worker history", workflow_spawn: "spawning a child worker" };
type WorkflowTheme = { fg(color: string, text: string): string; bold(text: string): string };

function jobTask(job: Job): string { const value = job.task.replace(/\s+/g, " ").trim(); return value.length > 64 ? `${value.slice(0, 64)}…` : value; }
function jobDuration(job: Job): string { const start = job.startedAt ? Date.parse(job.startedAt) : Date.parse(job.createdAt); const end = job.finishedAt ? Date.parse(job.finishedAt) : Date.now(); return `${Math.max(0, (end - start) / 1000).toFixed(1)}s`; }
function isRecent(job: Job): boolean { return !job.finishedAt || Date.now() - Date.parse(job.finishedAt) < 8_000; }
function formatJob(job: Job): string {
  const icon = job.status === "succeeded" ? "✓" : job.status === "failed" ? "✗" : job.status === "cancelled" ? "■" : job.status === "running" ? "●" : "○";
  const usage = job.usage?.totalTokens ? ` · ${job.usage.totalTokens.toLocaleString()} tok` : "";
  const context = job.contextTokens && job.contextWindow ? ` · ctx ${Math.round(job.contextTokens / job.contextWindow * 100)}%` : "";
  const cost = job.cost ? ` · $${job.cost.toFixed(4)}` : "";
  const lifecycle = job.lifecycle ? ` · ${job.lifecycle}` : "";
  const delivery = job.lastDelivery ? ` · delivery:${job.lastDelivery}` : "";
  const backend = job.isolationBackend ? ` · iso:${job.isolationBackend}` : "";
  const unread = job.ircUnread ? ` · ✉${job.ircUnread}` : "";
  return `${icon} ${job.id} ${routeLabel(job.decision.kind).toLowerCase()} · depth ${job.depth ?? 0} · ${jobTask(job)} · ${job.status}${lifecycle} · ${jobDuration(job)}${usage}${context}${cost}${backend}${delivery}${unread}`;
}
function renderWidget(tui: any, theme: WorkflowTheme, jobs: Job[], frame: number): string[] {
  const active = jobs.filter((job) => ["queued", "running"].includes(job.status));
  const finished = jobs.filter((job) => !["queued", "running"].includes(job.status) && isRecent(job)).slice(-4).reverse();
  const bus = coordinationBus();
  const pending = jobs.map((job) => ({ job, messages: bus.inbox(job.ircAddress ?? job.id, { peek: true, limit: 2 }) })).filter((item) => item.messages.length);
  const inboxJobs = pending.map((item) => item.job).filter((job) => !active.includes(job) && !finished.includes(job));
  if (!active.length && !finished.length && !inboxJobs.length) return [];
  const visible = [...active, ...finished, ...inboxJobs];
  const pendingCount = pending.reduce((count, item) => count + item.messages.length, 0);
  const width = tui?.terminal?.columns ?? 120;
  const line = (value: string) => truncateToWidth(value, width);
  const rows = [line(theme.fg(active.length ? "accent" : "dim", `${active.length ? "●" : "○"} Agents · ${active.length} active · ${pendingCount} pending`))];
  const byParent = new Map<string, Job[]>();
  for (const job of visible) { const children = byParent.get(job.parentId ?? "") ?? []; children.push(job); byParent.set(job.parentId ?? "", children); }
  const roots = visible.filter((job) => !job.parentId || !visible.some((candidate) => candidate.id === job.parentId));
  const ordered: Array<{ job: Job; depth: number }> = [];
  const visit = (job: Job, depth: number, seen = new Set<string>()) => {
    if (seen.has(job.id)) return;
    seen.add(job.id); ordered.push({ job, depth });
    for (const child of byParent.get(job.id) ?? []) visit(child, depth + 1, new Set(seen));
  };
  for (const root of roots) visit(root, 0);
  for (const item of visible) if (!ordered.some((entry) => entry.job.id === item.id)) visit(item, 0);
  for (const { job, depth } of ordered) {
    const tree = depth ? `${"│  ".repeat(Math.min(depth - 1, 3))}└─` : "├─";
    const icon = job.status === "running" ? theme.fg("accent", SPINNER[frame % SPINNER.length]) : job.status === "succeeded" ? theme.fg("success", "✓") : job.status === "failed" ? theme.fg("error", "✗") : theme.fg("muted", "◦");
    const model = job.decision.profile.model.split("/").at(-1) || "unconfigured";
    const unread = bus.inbox(job.ircAddress ?? job.id, { peek: true, limit: 1 });
    job.ircUnread = bus.unread(job.ircAddress ?? job.id);
    const delivery = job.lastDelivery ? ` · ${job.lastDelivery}` : "";
    const mailbox = unread.length ? ` · ${theme.fg("accent", `✉${job.ircUnread}`)}` : "";
    const telemetry = `${job.toolUses ?? 0} tools${job.usage?.totalTokens ? ` · ${job.usage.totalTokens.toLocaleString()} tok` : ""}${job.cost ? ` · $${job.cost.toFixed(4)}` : ""}${job.isolationBackend ? ` · ${job.isolationBackend}` : ""}`;
    rows.push(line(`${theme.fg("dim", tree)} ${icon} ${theme.bold(routeLabel(job.decision.kind))} ${theme.fg("muted", jobTask(job))} ${theme.fg("dim", `· d${job.depth ?? 0} · ${model} · ↻${job.attempts} · ${telemetry} · ${jobDuration(job)}${delivery}`)}${mailbox}`));
    const activity = job.currentTool ? TOOL_ACTIVITY[job.currentTool] ?? job.currentTool : job.lastMessage;
    if (activity) rows.push(line(`${theme.fg("dim", `${"│  ".repeat(Math.min(depth, 3))}│  ⎿`)} ${theme.fg("dim", activity)}`));
    if (unread[0]) rows.push(line(`${theme.fg("dim", `${"│  ".repeat(Math.min(depth, 3))}│  ✉`)} ${theme.fg("muted", `${unread[0].from}: ${unread[0].body.replace(/\s+/g, " ").slice(0, 150)}`)}`));
    if (job.livePreview) {
      const preview = job.livePreview.length > 240 ? `…${job.livePreview.slice(-239)}` : job.livePreview;
      rows.push(line(`${theme.fg("dim", `${"│  ".repeat(Math.min(depth, 3))}│  ≋`)} ${theme.fg("muted", preview)}`));
    }
  }
  return rows.slice(0, 16);
}

function resultText(job: Job): string {
  const heading = `${job.status === "succeeded" ? "Worker complete" : "Worker did not complete"} · ${job.id} · ${routeLabel(job.decision.kind)} · ${job.decision.profile.model}`;
  const body = job.status === "succeeded" ? job.output ?? "Worker returned no report." : `Error: ${job.error ?? "unknown failure"}`;
  const usage = job.usage ? `\nUsage: ${job.usage.totalTokens.toLocaleString()} tokens across ${job.requests ?? 0} requests${job.cost ? ` · $${job.cost.toFixed(4)}` : ""}${job.contextTokens && job.contextWindow ? ` · context ${job.contextTokens.toLocaleString()}/${job.contextWindow.toLocaleString()}` : ""}` : "";
  const artifacts = job.artifactDir ? `\nArtifacts: ${job.artifactDir}` : "";
  return `${heading}\nRouting: ${job.decision.reason}\nAttempts: ${job.attempts}${usage}${artifacts}\n\n${body}`;
}

export default function piAgentWorkflow(pi: ExtensionAPI) {
  const scheduler = globalScheduler();
  const jobs = scheduler.jobs;
  let config: WorkflowConfig | undefined;
  let activeCtx: ExtensionContext | undefined;
  let latestImages: ImageAttachment[] = [];
  let delegationOptOut = false;
  let unsubscribe: (() => void) | undefined;
  let persistTimer: ReturnType<typeof setTimeout> | undefined;
  let widgetRegistered = false, widgetFrame = 0, widgetTui: any;
  let widgetTimer: ReturnType<typeof setInterval> | undefined;
  let terminalInputUnsub: (() => void) | undefined;
  let lastEscapeAt = 0;

  const inheritToolExtensions = (current: WorkflowConfig) => {
    const tools = pi.getAllTools();
    for (const profile of Object.values(current.profiles)) {
      if (!profile.tools?.length) continue;
      const paths = tools.filter((tool) => profile.tools!.includes(tool.name) && /^(?:mcp[_-]|lsp[_-]|lsp$)/i.test(tool.name))
        .map((tool) => tool.sourceInfo.path)
        .filter((path) => /\.(?:[cm]?[jt]s|tsx?)$/i.test(path) && !path.includes("pi-agent-workflow"));
      if (paths.length) profile.extensions = [...new Set([...(profile.extensions ?? []), ...paths])];
      if (profile.autoloadSkills?.length) {
        const skillPaths = pi.getCommands().filter((command) => command.source === "skill" && profile.autoloadSkills!.some((name) => command.name === `skill:${name}` || command.name === name)).map((command) => command.sourceInfo.path).filter((path): path is string => Boolean(path));
        if (skillPaths.length) profile.skillPaths = [...new Set([...(profile.skillPaths ?? []), ...skillPaths])];
      }
    }
  };
  const cwdJobs = (cwd = activeCtx?.cwd) => [...jobs.values()].filter((job) => !cwd || job.cwd === cwd);
  const refresh = () => {
    const ctx = activeCtx; if (!ctx) return;
    const bus = coordinationBus();
    const visible = cwdJobs().filter((job) => ["queued", "running"].includes(job.status) || isRecent(job) || bus.unread(job.ircAddress ?? job.id) > 0);
    if (!visible.length) {
      if (widgetRegistered) ctx.ui.setWidget("pi-agent-workflow", undefined);
      widgetRegistered = false; widgetTui = undefined;
      if (widgetTimer) clearInterval(widgetTimer); widgetTimer = undefined;
      return;
    }
    if (!widgetTimer) widgetTimer = setInterval(() => { widgetFrame++; widgetTui?.requestRender(); }, 100);
    if (!widgetRegistered) {
      ctx.ui.setWidget("pi-agent-workflow", ((tui: any, theme: WorkflowTheme) => {
        widgetTui = tui;
        return { render: () => renderWidget(tui, theme, cwdJobs(), widgetFrame), invalidate: () => { widgetRegistered = false; widgetTui = undefined; } };
      }) as any, { placement: "aboveEditor" });
      widgetRegistered = true;
    } else widgetTui?.requestRender();
  };
  const persistSoon = () => {
    if (!activeCtx || !config?.persistState) return;
    if (persistTimer) clearTimeout(persistTimer);
    const cwd = activeCtx.cwd;
    persistTimer = setTimeout(() => { persistTimer = undefined; void saveWorkflowState(cwd, cwdJobs(cwd)); }, 50);
    persistTimer.unref?.();
  };
  const sendAsyncResult = (job: Job) => {
    if (!activeCtx || !job.async || job.cwd !== activeCtx.cwd) return;
    try { pi.sendMessage({ customType: "pi-agent-workflow-result", content: resultText(job), display: true, details: { job } }, { deliverAs: "followUp", triggerTurn: false }); } catch { /* stale session */ }
  };
  const bind = () => {
    unsubscribe?.();
    unsubscribe = scheduler.subscribe((event) => {
      refresh(); persistSoon();
      if (event.type === "completed") sendAsyncResult(event.job);
    });
  };

  const onWorkerMessage = (worker: Job, message: string, kind: "update" | "ask" | "peer") => {
    const concise = message.replace(/\s+/g, " ").trim();
    worker.lastMessage = `${kind === "update" ? "↳" : kind === "ask" ? "⚑" : "↔"} ${concise.slice(0, 100)}${concise.length > 100 ? "…" : ""}`;
    worker.messageCount = (worker.messageCount ?? 0) + 1; scheduler.notify(worker);
    if (kind === "peer") {
      const separator = message.indexOf("::");
      if (separator > 0) scheduler.message(message.slice(0, separator), message.slice(separator + 2), "steer");
    }
    if (kind === "ask" && activeCtx) {
      try { pi.sendMessage({ customType: "pi-agent-workflow-worker", content: `⚑ ${worker.id}\n${message}`, display: true, details: { jobId: worker.id } }, { deliverAs: "steer", triggerTurn: false }); } catch { /* stale session */ }
    }
  };

  const createJob = (ctx: ExtensionContext, task: string, options: { name?: string; async?: boolean; isolated?: boolean; sharedContext?: string; parentId?: string; decision?: Job["decision"] } = {}): Job => {
    const decision = options.decision ?? routeTask({ task, hasImages: latestImages.length > 0, imageCount: latestImages.length }, config!);
    const id = `w${randomUUID().slice(0, 8)}`;
    return { id, name: options.name, cwd: ctx.cwd, task, sharedContext: options.sharedContext, decision, status: "queued", async: options.async, isolated: options.isolated, parentId: options.parentId, rootId: options.parentId ? jobs.get(options.parentId)?.rootId ?? options.parentId : id, depth: options.parentId ? (jobs.get(options.parentId)?.depth ?? 0) + 1 : 0, createdAt: new Date().toISOString(), attempts: 0 };
  };
  const irc = coordinationBus();
  const addressOf = (job: Job) => job.ircAddress ?? job.id;
  const noteDelivery = (job: Job | undefined, outcome: string) => {
    if (!job) return;
    job.lastDelivery = outcome; job.lastDeliveryAt = new Date().toISOString(); job.deliveryCount = (job.deliveryCount ?? 0) + 1;
    job.ircUnread = irc.unread(addressOf(job)); scheduler.notify(job);
  };
  let coordinate!: (worker: Job, request: CoordinationRequest, signal: AbortSignal | undefined) => Promise<CoordinationResponse>;
  const startJob = (ctx: ExtensionContext, job: Job, images: ImageAttachment[]) => {
    const currentConfig = config!;
    return scheduler.enqueue(job, providerOf(job.decision.profile.model), (queued, signal) => runJob({
      pi, cwd: queued.cwd, config: currentConfig, jobs,
      onChange: (changed) => scheduler.notify(changed),
      registerControl: (id, control) => scheduler.setControl(id, control),
      onWorkerMessage,
      onCoordination: coordinate,
    }, queued, images, signal));
  };

  coordinate = async (worker, request, signal) => {
    if (request.type === "list") {
      const peers = new Map<string, Record<string, unknown>>();
      for (const peer of cwdJobs(worker.cwd).filter((candidate) => addressOf(candidate) !== addressOf(worker))) {
        const id = addressOf(peer);
        if (!peers.has(id) || peer.status === "running") peers.set(id, {
          id, jobId: peer.id, name: peer.name, kind: peer.decision.kind, status: peer.status, lifecycle: peer.lifecycle,
          depth: peer.depth ?? 0, parentId: peer.parentId, unread: irc.unread(id), task: peer.task.replace(/\s+/g, " ").slice(0, 160),
        });
      }
      return { ok: true, result: [{ id: "Main", kind: "parent", status: activeCtx ? "running" : "unavailable", depth: -1, unread: irc.unread("Main"), task: "Parent orchestrator" }, ...peers.values()] };
    }
    const sender = addressOf(worker);
    if (request.type === "inbox") {
      const result = irc.inbox(sender, { from: request.from, peek: request.peek });
      worker.ircUnread = irc.unread(sender); scheduler.notify(worker);
      return { ok: true, result };
    }
    if (request.type === "wait") {
      const waited = await irc.wait(sender, { from: request.from, timeoutMs: request.timeoutMs ?? 120_000, signal });
      worker.ircUnread = irc.unread(sender); scheduler.notify(worker);
      return { ok: true, result: waited ?? null };
    }
    if (request.type === "resource") {
      const uri = request.uri?.trim() ?? "";
      const match = uri.match(/^(agent|history):\/\/([^/]+)(?:\/(.*))?$/);
      if (!match) return { ok: false, error: "Resource URI must be agent://<job-id>[/result|history] or history://<job-id>." };
      const target = jobs.get(decodeURIComponent(match[2]));
      if (!target || target.cwd !== worker.cwd) return { ok: false, error: `Unknown worker resource ${match[2]}.` };
      const suffix = match[3] ?? (match[1] === "history" ? "history" : "result");
      if (suffix === "history" || match[1] === "history") return { ok: true, result: await workerHistory(target, 200, 100_000) };
      if (suffix === "result" || suffix === "output") return { ok: true, result: await workerFullOutput(target) };
      if (suffix === "status") return { ok: true, result: formatJob(target) };
      return { ok: false, error: `Unsupported workflow resource suffix ${suffix}.` };
    }
    if (request.type === "send") {
      const message = request.message?.trim();
      if (!message) return { ok: false, error: "Message cannot be empty." };
      if (worker.ircFrom === request.target && !worker.ircReplyAllowed) return { ok: false, error: "This was a one-way IRC delivery; do not send an acknowledgement unless the sender explicitly requested a reply." };
      const requestedTarget = request.target ?? "";
      const target = ["main", "parent"].includes(requestedTarget.toLowerCase()) ? "Main" : requestedTarget;
      const broadcast = target === "*" || target === "all";
      if (broadcast && request.awaitReply) return { ok: false, error: "Cannot await one reply to a broadcast." };
      const candidates = cwdJobs(worker.cwd).filter((peer) => addressOf(peer) !== sender);
      const targetPeers = broadcast
        ? [...new Map(candidates.filter((peer) => peer.status === "running" || peer.lifecycle === "idle").map((peer) => [addressOf(peer), peer])).values()]
        : candidates.filter((peer) => addressOf(peer) === target).sort((a, b) => Number(b.status === "running") - Number(a.status === "running") || b.createdAt.localeCompare(a.createdAt)).slice(0, 1);
      if (target !== "Main" && !broadcast && !targetPeers.length) return { ok: false, error: `Unknown peer ${target}.` };
      const timeoutMs = Math.max(0, Math.min(request.timeoutMs ?? 120_000, 300_000));
      const replyPromise = request.awaitReply ? irc.wait(sender, { from: target, timeoutMs, signal, drainPending: false }) : undefined;
      const receipts: IrcReceipt[] = [];
      const deliveries = target === "Main" ? [{ id: "Main", peer: undefined as Job | undefined }] : targetPeers.map((peer) => ({ id: addressOf(peer), peer }));
      for (const delivery of deliveries) {
        const published = irc.publish({ from: sender, to: delivery.id, body: message, ...(request.replyTo ? { replyTo: request.replyTo } : {}) });
        if (published.consumed) {
          receipts.push({ messageId: published.message.id, to: delivery.id, outcome: "consumed" });
          noteDelivery(worker, "consumed"); noteDelivery(delivery.peer, "consumed");
          continue;
        }
        if (delivery.id === "Main") {
          try {
            pi.sendMessage({ customType: "pi-agent-workflow-worker", content: `IRC ${sender} → Main [${published.message.id}]\n${message}\n${request.awaitReply ? `Reply with workflow_reply(target=${sender}, replyTo=${published.message.id}, message=...) within ${timeoutMs}ms.` : "No reply requested."}`, display: true, details: { jobId: worker.id, messageId: published.message.id, from: sender } }, { deliverAs: request.awaitReply ? "followUp" : "steer", triggerTurn: request.awaitReply });
            irc.consume("Main", published.message.id);
            receipts.push({ messageId: published.message.id, to: "Main", outcome: "injected" });
            noteDelivery(worker, "injected");
          } catch { receipts.push({ messageId: published.message.id, to: "Main", outcome: "failed", error: "Parent session rejected the message." });
            noteDelivery(worker, "failed"); }
          continue;
        }
        const peer = delivery.peer!;
        if (peer.status === "running" && scheduler.message(peer.id, `[IRC ${published.message.id} from ${sender}] ${message}`, "steer")) {
          irc.consume(delivery.id, published.message.id);
          receipts.push({ messageId: published.message.id, to: delivery.id, outcome: "injected" });
          noteDelivery(worker, "injected"); noteDelivery(peer, "injected");
          continue;
        }
        if (!broadcast && peer.sessionFile && activeCtx) {
          const replyRequested = Boolean(request.awaitReply) || /\?|\b(?:please\s+)?(?:reply|respond|tell me|let me know|confirm)\b/i.test(message);
          const wake = createJob(activeCtx, `[IRC ${published.message.id} from ${sender}] ${message}\nThis delivery ${replyRequested ? `requests a substantive reply; use workflow_send once with target ${sender} and replyTo ${published.message.id}` : "is one-way; do NOT call workflow_send merely to acknowledge it"}. Process the message, then yield a concise note.`, { parentId: peer.id, decision: peer.decision });
          wake.depth = peer.depth;
          wake.rootId = peer.rootId;
          wake.ircAddress = delivery.id;
          wake.ircFrom = sender;
          wake.ircReplyAllowed = replyRequested;
          const currentConfig = config!;
          void scheduler.enqueueNested(wake, (queued, wakeSignal) => runFollowUpJob({
            pi, cwd: queued.cwd, config: currentConfig, jobs,
            onChange: (changed) => scheduler.notify(changed),
            registerControl: (id, control) => scheduler.setControl(id, control),
            onWorkerMessage,
            onCoordination: coordinate,
          }, queued, peer, wakeSignal), undefined, providerOf(peer.decision.profile.model));
          irc.consume(delivery.id, published.message.id);
          const outcome = peer.lifecycle === "parked" ? "revived" : "woken";
          receipts.push({ messageId: published.message.id, to: delivery.id, outcome });
          noteDelivery(worker, outcome); noteDelivery(peer, outcome);
        } else {
          receipts.push({ messageId: published.message.id, to: delivery.id, outcome: "queued" });
          noteDelivery(worker, "queued"); noteDelivery(peer, "queued");
        }
      }
      const delivered = receipts.filter((receipt) => receipt.outcome !== "failed");
      if (!delivered.length) return { ok: false, error: receipts.map((receipt) => receipt.error).filter(Boolean).join("; ") || "No selected peer accepted the message.", result: receipts };
      const reply = replyPromise ? await replyPromise : undefined;
      return { ok: true, result: { receipts, ...(replyPromise ? { reply: reply ?? null } : {}) } };
    }
    if (request.type === "spawn") {
      if (!activeCtx || !config) return { ok: false, error: "Parent workflow context is unavailable." };
      if (!request.task?.trim()) return { ok: false, error: "Nested task cannot be empty." };
      const depth = (worker.depth ?? 0) + 1;
      if (depth > config.maxDepth) return { ok: false, error: `Maximum worker depth ${config.maxDepth} reached.` };
      if ((worker.childCount ?? 0) >= config.maxChildrenPerWorker) return { ok: false, error: `Worker child budget exhausted (${config.maxChildrenPerWorker}).` };
      const rootId = worker.rootId ?? worker.id;
      const activeTree = cwdJobs(worker.cwd).filter((candidate) => (candidate.rootId ?? candidate.id) === rootId && ["queued", "running"].includes(candidate.status));
      if (activeTree.length >= config.maxTotalWorkers) return { ok: false, error: `Worker tree budget exhausted (${config.maxTotalWorkers} active workers).` };
      const allowed = worker.decision.profile.spawns;
      if (!allowed) return { ok: false, error: `Worker profile ${worker.decision.kind} may not spawn children.` };
      let decision: Job["decision"] | undefined;
      if (request.agent) {
        const profile = config.profiles[request.agent];
        if (!profile) return { ok: false, error: `Unknown requested child agent ${request.agent}.` };
        decision = { kind: profile.kind, profile, reason: `nested agent requested by ${worker.id}` };
      }
      decision ??= routeTask({ task: request.task }, config);
      if (allowed !== "*" && !allowed.includes(decision.kind)) return { ok: false, error: `Profile ${worker.decision.kind} may spawn only: ${allowed.join(", ")}. Routed child was ${decision.kind}.` };
      const nested = createJob(activeCtx, request.task, { name: request.name, parentId: worker.id, decision, isolated: request.isolated === true && config.isolation });
      worker.childCount = (worker.childCount ?? 0) + 1;
      scheduler.notify(worker);
      nested.depth = depth;
      const currentConfig = config;
      const result = await scheduler.enqueueNested(nested, (queued, nestedSignal) => runJob({
        pi, cwd: queued.cwd, config: currentConfig, jobs,
        onChange: (changed) => scheduler.notify(changed),
        registerControl: (id, control) => scheduler.setControl(id, control),
        onWorkerMessage,
        onCoordination: coordinate,
      }, queued, [], nestedSignal), signal, providerOf(decision.profile.model));
      return result.status === "succeeded"
        ? { ok: true, result: result.output ?? "Nested worker returned no report.", jobId: result.id }
        : { ok: false, error: result.error ?? `Nested worker ${result.id} failed.`, jobId: result.id };
    }
    return { ok: false, error: "Unknown coordination request." };
  };

  pi.on("session_start", async (_event, ctx) => {
    activeCtx = ctx; config = await loadConfig(ctx); inheritToolExtensions(config);
    scheduler.configure(config.maxConcurrent, config.maxConcurrentPerProvider, config.maxNestedConcurrent);
    bind();
    if (config.persistState) {
      const restored = await loadWorkflowState(ctx.cwd);
      const missing = restored.filter((job) => !jobs.has(job.id));
      scheduler.importJobs(missing.map((job) => ({ ...job, cwd: job.cwd || ctx.cwd })));
      if (config.recoverInterrupted) {
        for (const job of missing.filter((item) => ["queued", "running", "interrupted"].includes(item.status))) {
          job.status = "queued"; job.error = undefined; job.finishedAt = undefined; job.recoveryCount = (job.recoveryCount ?? 0) + 1;
          void startJob(ctx, job, []);
        }
      } else for (const job of missing.filter((item) => ["queued", "running"].includes(item.status))) { job.status = "interrupted"; job.error = "Parent process exited before completion."; job.finishedAt = new Date().toISOString(); scheduler.notify(job); }
    }
    if (ctx.mode === "tui") terminalInputUnsub = ctx.ui.onTerminalInput((data: string) => {
      if (isKeyRelease(data) || !matchesKey(data, "escape") || !cwdJobs().some((job) => ["queued", "running"].includes(job.status))) return undefined;
      const now = Date.now();
      if (now - lastEscapeAt > 650) { lastEscapeAt = now; ctx.ui.notify("Press Escape again to cancel all workers.", "info"); return { consume: true }; }
      lastEscapeAt = 0; const count = cwdJobs().filter((job) => scheduler.cancel(job.id)).length; ctx.ui.notify(`Cancelled ${count} worker${count === 1 ? "" : "s"}.`, "info"); return { consume: true };
    });
    refresh();
    persistSoon();
  });

  pi.on("session_shutdown", async (event, ctx) => {
    unsubscribe?.(); unsubscribe = undefined;
    terminalInputUnsub?.(); terminalInputUnsub = undefined;
    if (persistTimer) { clearTimeout(persistTimer); persistTimer = undefined; }
    if (config?.persistState) await saveWorkflowState(ctx.cwd, cwdJobs(ctx.cwd));
    // Reload/session replacement rebinds the global scheduler. A real process
    // quit terminates children so persisted jobs can be recovered next launch.
    if (event.reason === "quit") {
      for (const job of cwdJobs(ctx.cwd)) if (["queued", "running"].includes(job.status)) scheduler.cancel(job.id, "Parent process exited; eligible for persisted recovery.");
      await workerSessionRegistry().terminateAll();
    }
    ctx.ui.setWidget("pi-agent-workflow", undefined);
    if (widgetTimer) clearInterval(widgetTimer); widgetTimer = undefined; widgetRegistered = false; widgetTui = undefined; activeCtx = undefined;
  });

  pi.on("input", async (event) => {
    const text = typeof event.text === "string" ? event.text : "";
    delegationOptOut = /\b(?:don['’]t|do not|without|no)\b[\s\S]{0,40}\b(?:delegate|worker|subagent|agent)\b/i.test(text) || /\bdo it yourself\b/i.test(text);
    latestImages = Array.isArray(event.images) ? event.images.map((image: any) => ({ data: String(image.data ?? image.source?.data ?? ""), mimeType: image.mimeType ?? image.source?.mediaType })).filter((image) => image.data) : [];
  });

  pi.on("before_agent_start", async (event, ctx) => {
    if (!config) { config = await loadConfig(ctx); inheritToolExtensions(config); }
    if (!config.enabled) return;
    const note = delegationOptOut ? "\nThe user opted out of delegation this turn. Do not call worker tools." : latestImages.length ? `\nThis turn has ${latestImages.length} image attachment(s); delegate visual perception before making visual claims.` : "";
    return { systemPrompt: event.systemPrompt + WORKFLOW_PROMPT + note };
  });

  pi.registerTool({
    name: "delegate_work", label: "Delegate work", promptSnippet: "Launch one automatically routed bounded worker",
    description: "Run one bounded task in a tracked Pi worker. Waits by default. Supports explicit background execution and clean-git worktree isolation.",
    parameters: Type.Object({ task: Type.String(), name: Type.Optional(Type.String()), async: Type.Optional(Type.Boolean()), isolated: Type.Optional(Type.Boolean()) }),
    async execute(_id, params, signal, _update, ctx) {
      if (!config) config = await loadConfig(ctx);
      if (delegationOptOut) return { content: [{ type: "text", text: "Delegation skipped: user opted out this turn." }], details: { skipped: true } };
      if (!config.enabled) return { content: [{ type: "text", text: "Delegation is disabled." }], details: { disabled: true } };
      const job = createJob(ctx, params.task, { name: params.name, async: params.async === true, isolated: params.isolated === true && config.isolation });
      if (job.decision.profile.blocking) job.async = false;
      const images = [...latestImages];
      const promise = startJob(ctx, job, images);
      if (job.async === true) return { content: [{ type: "text", text: `Worker queued · ${job.id} · ${routeLabel(job.decision.kind)}.` }], details: { job, async: true } };
      const abort = () => scheduler.cancel(job.id, "Parent turn cancelled."); signal?.addEventListener("abort", abort, { once: true });
      try { const result = await promise; return { content: [{ type: "text", text: resultText(result) }], details: { job: result } }; }
      finally { signal?.removeEventListener("abort", abort); }
    },
  });

  pi.registerTool({
    name: "delegate_tasks", label: "Delegate tasks", promptSnippet: "Launch independent bounded workers as one batch",
    description: "Launch 1-8 independent tasks with shared context. Tasks obey global and per-provider concurrency limits. Waits for the full batch unless async is explicitly true.",
    parameters: Type.Object({ context: Type.String(), tasks: Type.Array(Type.Object({ task: Type.String(), name: Type.Optional(Type.String()), isolated: Type.Optional(Type.Boolean()) }), { minItems: 1, maxItems: 8 }), async: Type.Optional(Type.Boolean()) }),
    async execute(_id, params, signal, _update, ctx) {
      if (!config) config = await loadConfig(ctx);
      if (delegationOptOut || !config.enabled) return { content: [{ type: "text", text: delegationOptOut ? "Delegation skipped: user opted out this turn." : "Delegation is disabled." }], details: { skipped: true } };
      const asyncMode = params.async === true;
      const images = [...latestImages];
      const batch = params.tasks.map((item) => {
        const job = createJob(ctx, item.task, { name: item.name, async: asyncMode, isolated: item.isolated === true && config!.isolation, sharedContext: params.context });
        if (job.decision.profile.blocking) job.async = false;
        return job;
      });
      const promises = batch.map((job) => startJob(ctx, job, images));
      if (asyncMode) {
        const inline = await Promise.all(promises.filter((_, index) => !batch[index].async));
        const background = batch.filter((job) => job.async);
        const text = [inline.map(resultText).join("\n\n---\n\n"), background.length ? `Queued ${background.length} workers: ${background.map((job) => job.id).join(", ")}` : ""].filter(Boolean).join("\n\n");
        return { content: [{ type: "text", text }], details: { jobs: [...inline, ...background], async: background.length > 0 } };
      }
      const abort = () => batch.forEach((job) => scheduler.cancel(job.id, "Parent turn cancelled.")); signal?.addEventListener("abort", abort, { once: true });
      try { const results = await Promise.all(promises); return { content: [{ type: "text", text: results.map(resultText).join("\n\n---\n\n") }], details: { jobs: results } }; }
      finally { signal?.removeEventListener("abort", abort); }
    },
  });

  pi.registerTool({
    name: "wait_for_workers", label: "Wait for workers", description: "Wait event-driven for selected background workers, or all active workers when ids are omitted.",
    parameters: Type.Object({ jobIds: Type.Optional(Type.Array(Type.String())) }),
    async execute(_id, params, signal) {
      try { const completed = await scheduler.wait(params.jobIds, signal); return { content: [{ type: "text", text: completed.length ? completed.map(resultText).join("\n\n---\n\n") : "No selected workers found." }], details: { cancelled: false, jobs: completed } }; }
      catch { return { content: [{ type: "text", text: "Stopped waiting because the parent turn was cancelled." }], details: { cancelled: true, jobs: [] as Job[] } }; }
    },
  });

  pi.registerTool({
    name: "workflow_message", label: "Message or continue worker", description: "Steer a running worker, queue a running follow-up, or continue a completed worker as a new linked run.",
    parameters: Type.Object({ jobId: Type.String(), message: Type.String(), mode: Type.Optional(Type.String()) }),
    async execute(_id, params, signal, _update, ctx) {
      const mode = params.mode === "follow_up" ? "follow_up" : "steer";
      const source = jobs.get(params.jobId);
      if (!source) return { content: [{ type: "text", text: `Unknown worker ${params.jobId}.` }], details: { sent: false } };
      if (source.status === "running" && scheduler.message(source.id, params.message, mode)) return { content: [{ type: "text", text: `Message sent to ${source.id}.` }], details: { sent: true, jobId: source.id, mode } };
      if (mode !== "follow_up") return { content: [{ type: "text", text: `Worker ${source.id} is not running; use mode follow_up to continue it.` }], details: { sent: false } };
      if (!config) config = await loadConfig(ctx);
      const follow = createJob(ctx, params.message, { parentId: source.id, decision: source.decision });
      const currentConfig = config!;
      const promise = scheduler.enqueue(follow, providerOf(source.decision.profile.model), (queued, runSignal) => runFollowUpJob({
        pi, cwd: queued.cwd, config: currentConfig, jobs,
        onChange: (changed) => scheduler.notify(changed),
        registerControl: (id, control) => scheduler.setControl(id, control),
        onWorkerMessage,
        onCoordination: coordinate,
      }, queued, source, runSignal));
      const abort = () => scheduler.cancel(follow.id, "Parent turn cancelled."); signal?.addEventListener("abort", abort, { once: true });
      try { const result = await promise; return { content: [{ type: "text", text: resultText(result) }], details: { job: result, parentId: source.id, resumedSession: true } }; }
      finally { signal?.removeEventListener("abort", abort); }
    },
  });

  pi.registerTool({
    name: "worker_status", label: "Worker status", description: "Inspect tracked worker state without waiting.",
    parameters: Type.Object({ jobIds: Type.Optional(Type.Array(Type.String())) }),
    async execute(_id, params, _signal, _update, ctx) {
      const selected = params.jobIds?.length ? params.jobIds.map((id) => jobs.get(id)).filter((job): job is Job => Boolean(job)) : cwdJobs(ctx.cwd).slice(-20);
      return { content: [{ type: "text", text: selected.length ? selected.map(formatJob).join("\n") : "No workers found." }], details: { jobs: selected } };
    },
  });

  pi.registerTool({
    name: "worker_history", label: "Worker history", description: "Read concise durable transcripts for selected workers without exposing private reasoning.",
    parameters: Type.Object({ jobIds: Type.Array(Type.String(), { minItems: 1, maxItems: 8 }), maxEntries: Type.Optional(Type.Number()) }),
    async execute(_id, params) {
      const selected = params.jobIds.map((id) => jobs.get(id)).filter((job): job is Job => Boolean(job));
      const histories = await Promise.all(selected.map(async (job) => `## ${job.id}\n${await workerHistory(job, params.maxEntries ?? 80)}`));
      return { content: [{ type: "text", text: histories.join("\n\n") || "No selected workers found." }], details: { jobs: selected } };
    },
  });

  pi.registerTool({
    name: "workflow_resource", label: "Workflow resource", description: "Read an agent:// or history:// resource URI.",
    parameters: Type.Object({ uri: Type.String() }),
    async execute(_id, params) {
      const match = params.uri.match(/^(agent|history):\/\/([^/]+)(?:\/(.*))?$/);
      if (!match) return { content: [{ type: "text", text: "Invalid resource URI. Use agent://<job-id>/result or history://<job-id>." }], details: { uri: params.uri }, isError: true };
      const job = jobs.get(decodeURIComponent(match[2]));
      if (!job) return { content: [{ type: "text", text: `Unknown worker resource ${match[2]}.` }], details: { uri: params.uri }, isError: true };
      const suffix = match[3] ?? (match[1] === "history" ? "history" : "result");
      const text = suffix === "history" || match[1] === "history" ? await workerHistory(job, 200, 100_000) : suffix === "status" ? formatJob(job) : await workerFullOutput(job);
      const details: { uri: string; job?: Job } = { uri: params.uri, job };
      return { content: [{ type: "text", text }], details };
    },
  });

  pi.registerTool({
    name: "workflow_reply", label: "Reply to worker", description: "Deliver a reply from Main to a worker waiting on workflow_send awaitReply.",
    parameters: Type.Object({ target: Type.String(), message: Type.String(), replyTo: Type.Optional(Type.String()) }),
    async execute(_id, params) {
      const target = jobs.get(params.target);
      const address = target ? addressOf(target) : params.target;
      const published = irc.publish({ from: "Main", to: address, body: params.message, ...(params.replyTo ? { replyTo: params.replyTo } : {}) });
      return { content: [{ type: "text", text: `Reply delivered to ${address} [${published.message.id}].` }], details: { message: published.message, consumed: published.consumed } };
    },
  });

  pi.registerTool({
    name: "worker_result", label: "Worker result", description: "Retrieve a worker's complete persisted report rather than its bounded tool preview.",
    parameters: Type.Object({ jobId: Type.String() }),
    async execute(_id, params) {
      const job = jobs.get(params.jobId);
      return { content: [{ type: "text", text: job ? await workerFullOutput(job) : `Unknown worker ${params.jobId}.` }], details: { job } };
    },
  });

  pi.registerTool({
    name: "release_workers", label: "Release workers", description: "Terminate durable idle/parked worker sessions and release their live resources. Persisted transcripts remain readable.",
    parameters: Type.Object({ jobIds: Type.Array(Type.String(), { minItems: 1, maxItems: 32 }) }),
    async execute(_id, params) {
      const released: string[] = [];
      for (const id of [...new Set(params.jobIds)]) {
        if (await workerSessionRegistry().terminate(id)) {
          released.push(id);
          const job = jobs.get(id); if (job) { job.lifecycle = "aborted"; scheduler.notify(job); }
        }
      }
      return { content: [{ type: "text", text: released.length ? `Released: ${released.join(", ")}` : "No live selected worker sessions." }], details: { released } };
    },
  });

  pi.registerTool({
    name: "cancel_workers", label: "Cancel workers", description: "Cancel selected active workers, or every active worker when ids are omitted.",
    parameters: Type.Object({ jobIds: Type.Optional(Type.Array(Type.String())) }),
    async execute(_id, params, _signal, _update, ctx) {
      const ids = params.jobIds?.length ? params.jobIds : cwdJobs(ctx.cwd).filter((job) => ["queued", "running"].includes(job.status)).map((job) => job.id);
      const cancelled = ids.filter((id) => scheduler.cancel(id));
      return { content: [{ type: "text", text: cancelled.length ? `Cancelled: ${cancelled.join(", ")}` : "No active selected workers." }], details: { cancelled } };
    },
  });

  pi.registerCommand("workflow", {
    description: "Inspect and control Pi workers",
    handler: async (args, ctx) => {
      if (!config) config = await loadConfig(ctx);
      const [command = "status", ...rest] = args.trim().split(/\s+/).filter(Boolean);
      if (command === "stop") { const count = cwdJobs(ctx.cwd).filter((job) => scheduler.cancel(job.id)).length; ctx.ui.notify(`Cancelled ${count} worker${count === 1 ? "" : "s"}.`, "info"); return; }
      if (command === "steer" || command === "followup") { const [id, ...parts] = rest; const sent = Boolean(id && parts.length && scheduler.message(id, parts.join(" "), command === "followup" ? "follow_up" : "steer")); ctx.ui.notify(sent ? `Message sent to ${id}.` : `Usage: /workflow ${command} <job-id> <message>`, sent ? "info" : "warning"); return; }
      if (command === "config") { ctx.ui.notify([`Concurrency: ${config.maxConcurrent} global / ${config.maxConcurrentPerProvider} per provider`, `Timeout: ${Math.round(config.timeoutMs / 60_000)}m`, `Retries: ${config.maxRetries}`, `Persistence: ${config.persistState ? "on" : "off"}`, `Isolation: ${config.isolation ? "on" : "off"} (${config.isolationBackend})`, `Recursion: depth ${config.maxDepth}, ${config.maxChildrenPerWorker} children/worker, ${config.maxNestedConcurrent} nested slots`, ...profileSummary(config)].join("\n"), "info"); return; }
      if (command === "doctor") {
        const live = rest.includes("live");
        const models = [...new Set(Object.values(config.profiles).flatMap((profile) => [profile.model, ...(Array.isArray(profile.fallback) ? profile.fallback : profile.fallback ? [profile.fallback] : [])]).filter(Boolean))];
        if (!live) { const listed = await pi.exec("pi", ["--list-models"], { cwd: ctx.cwd, timeout: 20_000 }); const missing = models.filter((model) => !listed.stdout.includes(model.split("/").at(-1) ?? model)); ctx.ui.notify(missing.length ? `Missing model refs:\n${missing.join("\n")}` : `All ${models.length} model refs are present.`, missing.length ? "warning" : "info"); return; }
        const lines: string[] = [];
        for (const model of models) { const result = await pi.exec("pi", ["--mode", "json", "--no-session", "--no-extensions", "--no-skills", "--no-prompt-templates", "--no-context-files", "--model", model, "--thinking", "off", "--tools", "read", "-p", "Respond with exactly OK."], { cwd: ctx.cwd, timeout: 45_000 }); const error = protocolErrorFromJsonOutput(result.stdout); lines.push(error ? `✗ ${model} — ${error}` : textFromJsonOutput(result.stdout) ? `✓ ${model}` : `✗ ${model} — no response`); }
        ctx.ui.notify(lines.join("\n"), lines.some((line) => line.startsWith("✗")) ? "warning" : "info"); return;
      }
      ctx.ui.notify(cwdJobs(ctx.cwd).slice(-20).map(formatJob).join("\n") || "No workflow runs yet.", "info");
    },
  });
}