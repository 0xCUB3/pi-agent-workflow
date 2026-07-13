import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";

import { dirname, join } from "node:path";
import { homedir, tmpdir } from "node:os";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { cleanupIsolation, mergeIsolation, prepareIsolation, type IsolationContext } from "./isolation.js";
import { WorkerSession, workerSessionRegistry, type CoordinationRequest, type CoordinationResponse, type SessionProtocol } from "./worker-session.js";
import type { ChildResult, Job, RouteDecision, UsageTotals, WorkerControl, WorkflowConfig } from "./types.js";

export type ImageAttachment = { data: string; mimeType?: string };

export type RuntimeOptions = {
  pi: ExtensionAPI;
  cwd: string;
  config: WorkflowConfig;
  jobs: Map<string, Job>;
  onChange: (job: Job) => void;
  registerControl: (jobId: string, control: WorkerControl | undefined) => void;
  onWorkerMessage?: (job: Job, message: string, kind: "update" | "ask" | "peer") => void;
  onCoordination?: (job: Job, request: CoordinationRequest, signal: AbortSignal | undefined) => Promise<CoordinationResponse>;
};

const emptyUsage = (): UsageTotals => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 });

export const EVIDENCE_DISCIPLINE = `Evidence discipline:
- Treat tool output as authoritative and your memory or expectations as unverified.
- Before claiming that a symbol, property, file, behavior, or relationship exists, locate it in the inspected evidence and verify its exact spelling.
- If a file is large, search for relevant identifiers and read focused ranges; do not infer unseen code from names or conventions.
- Clearly distinguish direct observations from interpretations. State uncertainty instead of filling gaps.
- Before yielding, re-check each concrete claim against the collected evidence and remove unsupported claims.
- Treat requested output shape, item count, word limit, and exclusions as hard acceptance criteria. Before yielding, silently count the requested items and words; when a maximum is specified, target no more than about 60% of it so counting differences cannot cause an overrun.
- Put only the requested deliverable in workflow_yield.result: no preamble, process narration, duplicate summary, or unrequested sections.
- Prefer the shortest complete answer. Put supporting checks in validation rather than expanding result to demonstrate effort.
- In validation, name the files, commands, or source URLs actually inspected and summarize what they established.`;

type StructuredYield = { status?: string; result?: string; data?: unknown; changes?: string[]; validation?: string[]; risks?: string[]; nextStep?: string };

function formatStructuredYield(value: StructuredYield): string {
  if (value.data !== undefined) return JSON.stringify(value.data, null, 2);
  const list = (items: string[] | undefined) => items?.length ? items.map((item) => `- ${item}`).join("\n") : "- None";
  return `Result: ${value.status === "completed" ? "completed" : "blocked"}\n${value.result ?? "No result supplied."}\n\nChanges:\n${list(value.changes)}\n\nValidation:\n${list(value.validation)}\n\nRisks:\n${list(value.risks)}\n\nNext step: ${value.nextStep || "None"}`;
}

export function structuredYieldFromJsonOutput(stdout: string): { output: string; status: "completed" | "blocked" } | undefined {
  let found: StructuredYield | undefined;
  for (const line of stdout.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const event = JSON.parse(line) as { type?: string; toolName?: string; result?: { details?: StructuredYield }; message?: { role?: string; toolName?: string; details?: StructuredYield } };
      if (event.type === "tool_execution_end" && event.toolName === "workflow_yield" && event.result?.details) found = event.result.details;
      if (event.type === "message_end" && event.message?.role === "toolResult" && event.message.toolName === "workflow_yield" && event.message.details) found = event.message.details;
    } catch { /* diagnostic line */ }
  }
  if (!found) return undefined;
  const status = found.status?.toLowerCase() === "completed" ? "completed" : "blocked";
  return { output: formatStructuredYield({ ...found, status }), status };
}

export function textFromJsonOutput(stdout: string): string {
  const yielded = structuredYieldFromJsonOutput(stdout);
  if (yielded) return yielded.output;
  const messages: string[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const event = JSON.parse(line) as { type?: string; message?: { role?: string; content?: unknown } };
      if (event.type !== "message_end" || event.message?.role !== "assistant") continue;
      const content = event.message.content;
      if (typeof content === "string") messages.push(stripWorkflowSignals(content));
      else if (Array.isArray(content)) {
        const text = content.filter((part): part is { type: "text"; text: string } => Boolean(part && typeof part === "object" && (part as { type?: string }).type === "text" && typeof (part as { text?: unknown }).text === "string")).map((part) => part.text).join("\n");
        if (text) messages.push(stripWorkflowSignals(text));
      }
    } catch { /* diagnostic line */ }
  }
  return messages.at(-1)?.trim() ?? "";
}

export function protocolErrorFromJsonOutput(stdout: string): string | undefined {
  for (const line of stdout.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const event = JSON.parse(line) as { message?: { stopReason?: string; errorMessage?: string }; messages?: Array<{ stopReason?: string; errorMessage?: string }> };
      for (const message of [event.message, ...(event.messages ?? [])].filter(Boolean) as Array<{ stopReason?: string; errorMessage?: string }>) {
        if (message.stopReason === "error" || message.errorMessage) return message.errorMessage || "child agent reported an error";
      }
    } catch { /* diagnostic line */ }
  }
  return undefined;
}

function stripWorkflowSignals(output: string): string {
  return output.replace(/^\s*WORKFLOW_(?:UPDATE|ASK|TO):[^\r\n]*\s*$/gim, "").replace(/\n{3,}/g, "\n\n").trim();
}

export function boundOutput(output: string, maxChars: number, maxBytes: number, maxLines: number): { text: string; truncated: boolean } {
  const lines = output.split(/\r?\n/);
  let text = lines.length > maxLines ? lines.slice(0, maxLines).join("\n") : output;
  let truncated = lines.length > maxLines;
  if (text.length > maxChars) { text = text.slice(0, maxChars); truncated = true; }
  const bytes = Buffer.byteLength(text);
  if (bytes > maxBytes) { text = Buffer.from(text).subarray(0, maxBytes).toString("utf8"); truncated = true; }
  return { text: `${text.trim()}${truncated ? "\n\n[output truncated; full result is in the worker artifacts]" : ""}`, truncated };
}

function reportIsUnsuccessful(output: string): boolean {
  return /(?:^|\n)\s*(?:#+\s*)?result\s*:\s*(?:blocked|failed|incomplete|aborted|not complete)\b/i.test(output);
}

export function parseWorkflowUpdate(text: string): string | undefined {
  return text.match(/(?:^|\n)\s*WORKFLOW_UPDATE:\s*([^\n\r]*)/i)?.[1]?.trim() || undefined;
}

function partialJsonString(value: string, key: string): string | undefined {
  const match = new RegExp(`"${key}"\\s*:\\s*"`).exec(value);
  if (!match) return undefined;
  const input = value.slice(match.index + match[0].length);
  let output = "";
  for (let index = 0; index < input.length; index++) {
    const char = input[index];
    if (char === '"') break;
    if (char !== "\\") { output += char; continue; }
    const escaped = input[++index];
    if (escaped === undefined) break;
    if (escaped === "u") {
      const hex = input.slice(index + 1, index + 5);
      if (!/^[0-9a-f]{4}$/i.test(hex)) break;
      output += String.fromCharCode(Number.parseInt(hex, 16)); index += 4;
    } else output += ({ n: "\n", r: "\r", t: "\t", b: "\b", f: "\f" } as Record<string, string>)[escaped] ?? escaped;
  }
  return output;
}

/** Extracts only visible assistant prose or the streamed workflow_yield result, never thinking content. */
export function livePreviewFromAssistantEvent(value: unknown): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  const event = value as { assistantMessageEvent?: { partial?: { content?: unknown } } };
  const content = event.assistantMessageEvent?.partial?.content;
  if (!Array.isArray(content)) return undefined;
  const text = content.filter((part) => part && typeof part === "object" && (part as { type?: string }).type === "text")
    .map((part) => String((part as { text?: string }).text ?? "")).join("\n");
  let preview = text;
  for (const part of content) {
    if (!part || typeof part !== "object") continue;
    const call = part as { type?: string; name?: string; arguments?: unknown; partialArgs?: string };
    if (call.type !== "toolCall" || call.name !== "workflow_yield") continue;
    const args = call.arguments;
    if (args && typeof args === "object" && typeof (args as { result?: unknown }).result === "string") preview = (args as { result: string }).result;
    else if (call.partialArgs) preview = partialJsonString(call.partialArgs, "result") ?? preview;
  }
  preview = preview.replace(/WORKFLOW_(?:UPDATE|ASK|TO):[^\r\n]*/gi, "").replace(/[\u0000-\u001f\u007f-\u009f]/g, " ").replace(/\s+/g, " ").trim();
  return preview ? preview.slice(-2_000) : undefined;
}

export function continuationPrompt(stdout: string, task = ""): string {
  const draft = textFromJsonOutput(stdout).trim();
  if (!draft) return "Continue the bounded assignment. Complete any remaining evidence steps, then call workflow_yield with the structured result. Do not stop with plain text.";
  return `You stopped after drafting a report instead of calling workflow_yield. Call workflow_yield now. The bounded assignment's requested format, item count, length limit, and exclusions are hard requirements. Revise the draft to satisfy them exactly: preserve verified facts that fit, remove preamble and unrequested detail, and do not replace precise evidence with a generic summary or introduce new claims. Put only the requested deliverable in result, and populate validation only with checks actually performed. Make no additional tool calls unless required to correct an identified uncertainty.\n\nBounded assignment:\n${task.slice(-2_000)}\n\nVerified draft to reshape and transfer:\n${draft.slice(-6_000)}`;
}

export function parseWorkerMessage(text: string): { kind: "ask" | "peer"; message: string; target?: string } | undefined {
  const ask = text.match(/(?:^|\n)\s*WORKFLOW_ASK:\s*(.+)/i)?.[1]?.trim();
  if (ask) return { kind: "ask", message: ask };
  const peer = text.match(/(?:^|\n)\s*WORKFLOW_TO:\s*([^:\s]+)\s*:\s*(.+)/i);
  return peer ? { kind: "peer", target: peer[1], message: peer[2].trim() } : undefined;
}

export function workerEvidenceError(task: string, toolsUsed: string[] | undefined): string | undefined {
  const text = task.toLowerCase();
  const tools = new Set(toolsUsed ?? []);
  const negativeMutation = /\bdo not (?:modify|edit|write) (?:(?:any\s+other)|any|the|this|other)?\s*(?:files?|anything|the repository)\b/g;
  const intentText = text.replace(negativeMutation, "");
  const explicitlyReadOnly = /\b(?:read[- ]only|without editing|no changes?)\b/.test(text) || intentText !== text && !/\b(?:implement|build|add|change|modify|edit|update|fix|refactor|write|create|remove|delete)\b/.test(intentText);
  const asksForMutation = !explicitlyReadOnly && /\b(?:implement|build|add|change|modify|edit|update|fix|refactor|write|create|remove|delete)\b/.test(intentText);
  const asksForEvidence = /\b(?:inspect|audit|search|find|check|test|validate|run|repository|repo|file|source|code|exact lines?)\b/.test(text);
  // A completed nested worker handoff is evidence: its own tool usage is
  // validated before workflow_spawn returns, so the parent need not duplicate
  // the child's edits or commands merely to pass the parent evidence gate.
  const hasNestedEvidence = tools.has("workflow_spawn");
  if (asksForMutation && !hasNestedEvidence && !["edit", "write"].some((tool) => tools.has(tool))) return "worker returned a mutation report without using an edit or write tool";
  if (/(?:\bcat\b|\bcommand\b|\b(?:run|execute)\b.{0,32}\b(?:tests?|checks?|commands?)\b)/.test(text) && !hasNestedEvidence && !tools.has("bash")) return "worker did not perform the requested command or test validation with bash";
  if (asksForEvidence && tools.size === 0) return "worker returned a repository report without using any repository tool";
  return undefined;
}

export function taskRequestsMutation(task: string): boolean {
  const text = task.toLowerCase();
  const forbidsMutation = /\b(?:do not|don't|without)\s+(?:modify(?:ing)?|edit(?:ing)?|writ(?:e|ing)|chang(?:e|ing)|creat(?:e|ing)|delet(?:e|ing))\b|\bread[- ]only\b|\bno (?:file |code )?changes?\b/.test(text);
  return !forbidsMutation && /\b(?:implement|build|add|change|modify|edit|update|fix|refactor|write|create|remove|delete)\b/.test(text);
}

export function workerToolNames(decision: RouteDecision, task = ""): string[] {
  const coordination = ["workflow_peers", "workflow_send", "workflow_inbox", "workflow_wait", "workflow_resource", ...(decision.profile.spawns ? ["workflow_spawn"] : [])];
  if (decision.profile.tools?.length) {
    const expanded = decision.profile.tools.flatMap((tool) => tool === "exec" ? ["bash"] : [tool]);
    return [...new Set([...expanded.filter((tool) => tool !== "delegate_work" && tool !== "delegate_tasks"), ...coordination, "workflow_yield"])];
  }
  const repositoryTools = taskRequestsMutation(task) ? ["read", "bash", "edit", "write", "workflow_yield"] : ["read", "bash", "workflow_yield"];
  const webTools = ["web_search", "fetch_content", "get_search_content", "workflow_yield"];
  if (!decision.profile.web) return [...new Set([...repositoryTools, ...coordination])];
  // Research workers need both source browsing and local repository evidence:
  // a manuscript/spec audit often spans checked-in artifacts and external
  // references. Web-enabled profiles add web tools; they do not lose read/bash.
  return [...new Set([...repositoryTools, ...webTools, ...coordination])];
}

async function loadedSkillPrompt(profile: RouteDecision["profile"], cwd: string): Promise<string> {
  if (!profile.autoloadSkills?.length) return "";
  const paths = [...(profile.skillPaths ?? []), ...profile.autoloadSkills.flatMap((name) => [
    join(cwd, ".pi", "skills", name, "SKILL.md"),
    join(homedir(), ".pi", "agent", "skills", name, "SKILL.md"),
  ])];
  const loaded: string[] = [];
  for (const path of [...new Set(paths)]) {
    try {
      const content = await readFile(path, "utf8");
      loaded.push(`### Skill: ${path}\n${content.slice(0, 50_000)}`);
    } catch { /* unavailable skill source */ }
  }
  return loaded.length ? `\nPreloaded skills (follow these instructions when relevant):\n${loaded.join("\n\n")}\n` : "";
}

export function workerRuntimeArgs(decision: RouteDecision, task = ""): string[] {
  const args = ["--no-extensions", "--no-prompt-templates", "--no-context-files"];
  if (!decision.profile.autoloadSkills?.length) args.push("--no-skills");
  const yieldExtension = join(import.meta.dirname, "worker-yield.ts");
  if (!existsSync(yieldExtension)) throw new Error(`Worker yield extension missing at ${yieldExtension}`);
  args.push("--extension", yieldExtension);
  const coordinationExtension = join(import.meta.dirname, "worker-coordination.ts");
  if (!existsSync(coordinationExtension)) throw new Error(`Worker coordination extension missing at ${coordinationExtension}`);
  args.push("--extension", coordinationExtension);
  for (const extension of decision.profile.extensions ?? []) if (existsSync(extension)) args.push("--extension", extension);
  if (decision.profile.web || workerToolNames(decision, task).some((tool) => ["web_search", "fetch_content", "get_search_content"].includes(tool))) {
    const webExtension = join(homedir(), ".pi", "agent", "npm", "node_modules", "pi-web-access", "index.ts");
    if (!existsSync(webExtension)) throw new Error(`Web-enabled worker requires pi-web-access at ${webExtension}`);
    args.push("--extension", webExtension);
  }
  if (decision.profile.model.toLowerCase().includes("electronhub-devpass/glm-5.2")) {
    const extension = join(homedir(), ".pi", "agent", "extensions", "electronhub-glm-compat.ts");
    if (existsSync(extension)) args.push("--extension", extension);
  }
  args.push("--model", decision.profile.model, "--thinking", decision.profile.thinking, "--tools", workerToolNames(decision, task).join(","), "--name", `worker-${randomUUID().slice(0, 8)}`);
  return args;
}

const SESSION_PROTOCOL: SessionProtocol = {
  continuationPrompt,
  structuredYield: structuredYieldFromJsonOutput,
  textOutput: textFromJsonOutput,
  protocolError: protocolErrorFromJsonOutput,
  livePreview: livePreviewFromAssistantEvent,
  workflowUpdate: parseWorkflowUpdate,
  workerMessage: parseWorkerMessage,
};

async function runDurableTurn(
  id: string,
  cwd: string,
  decision: RouteDecision,
  prompt: string,
  task: string,
  sessionDir: string,
  ipcDir: string,
  timeoutMs: number,
  signal: AbortSignal,
  onEvent: (event: string, details?: unknown) => void,
  registerControl: (control: WorkerControl) => void,
  onWorkerMessage?: (message: string, kind: "update" | "ask" | "peer") => void,
  onPreview?: (preview: string | undefined) => void,
  onCoordination?: (request: CoordinationRequest, signal: AbortSignal | undefined) => Promise<CoordinationResponse>,
  sessionFile?: string,
  softRequestBudget = 0,
): Promise<{ result: ChildResult; session: WorkerSession }> {
  await mkdir(sessionDir, { recursive: true });
  await mkdir(join(ipcDir, "requests"), { recursive: true });
  await mkdir(join(ipcDir, "responses"), { recursive: true });
  let args: string[];
  try { args = workerRuntimeArgs(decision, task); }
  catch (error) {
    const session = new WorkerSession({ id, cwd, args: [], env: {}, sessionDir, ipcDir, protocol: SESSION_PROTOCOL });
    return { session, result: { ok: false, output: "", error: error instanceof Error ? error.message : String(error), exitCode: 1, timedOut: false, durationMs: 0, usage: emptyUsage(), requests: 0 } };
  }
  const session = new WorkerSession({ id, cwd, args, env: { PI_WORKFLOW_TASK: task, PI_WORKFLOW_WORKER_ID: id, PI_WORKFLOW_IPC_DIR: ipcDir, PI_WORKFLOW_IPC_TIMEOUT_MS: String(timeoutMs), ...(decision.profile.output !== undefined ? { PI_WORKFLOW_OUTPUT_SCHEMA: JSON.stringify(decision.profile.output) } : {}) }, sessionDir, sessionFile, ipcDir, protocol: SESSION_PROTOCOL });
  registerControl(session.control);
  const result = await session.runTurn(prompt, task, timeoutMs, signal, { onEvent, onWorkerMessage, onPreview, onCoordination }, softRequestBudget);
  return { result, session };
}

function providerOf(model: string): string { return model.split("/", 1)[0] || "unknown"; }
export { providerOf };

/** Continue an existing worker in its original Pi session and model context. */
export async function runFollowUpJob(options: RuntimeOptions, job: Job, source: Job, signal: AbortSignal): Promise<Job> {
  const { config, onChange, registerControl, onWorkerMessage, onCoordination } = options;
  const registry = workerSessionRegistry();
  let session = registry.get(source.id);
  if (!session && source.sessionFile) {
    const args = workerRuntimeArgs(source.decision, source.task);
    session = new WorkerSession({
      id: source.rootId ?? source.id,
      cwd: source.cwd,
      args,
      env: { PI_WORKFLOW_TASK: job.task, PI_WORKFLOW_WORKER_ID: source.rootId ?? source.id, PI_WORKFLOW_IPC_DIR: source.ipcDir ?? join(dirname(source.sessionFile), "ipc"), PI_WORKFLOW_IPC_TIMEOUT_MS: String(config.timeoutMs), ...(source.decision.profile.output !== undefined ? { PI_WORKFLOW_OUTPUT_SCHEMA: JSON.stringify(source.decision.profile.output) } : {}) },
      sessionDir: dirname(source.sessionFile),
      sessionFile: source.sessionFile,
      ipcDir: source.ipcDir ?? join(dirname(source.sessionFile), "ipc"),
      protocol: SESSION_PROTOCOL,
    });
  }
  if (!session) {
    job.status = "failed";
    job.error = `Worker ${source.id} has no durable session to resume.`;
    job.finishedAt = new Date().toISOString();
    job.lifecycle = "aborted";
    onChange(job);
    return job;
  }

  job.status = "running";
  job.startedAt = new Date().toISOString();
  job.lifecycle = session.lifecycle === "parked" ? "starting" : "running";
  job.attempts = 1;
  job.toolUses = 0;
  job.toolsUsed = [];
  onChange(job);
  registerControl(job.id, session.control);
  const prompt = `Continue in the same worker session with all prior context.\n\nNew bounded follow-up:\n${job.task}\n\nUse repository evidence, perform requested validation, and finish by calling workflow_yield exactly once. Put only the requested deliverable in result.`;
  const result = await session.runTurn(prompt, job.task, config.timeoutMs, signal, {
    onEvent: (event, details) => {
      job.lastEvent = event;
      job.currentTool = event.startsWith("tool:") ? event.slice(5) : undefined;
      job.currentToolArgs = event.startsWith("tool:") && details !== undefined ? JSON.stringify(details).slice(0, 500) : undefined;
      if (event.startsWith("tool:")) {
        job.toolUses = (job.toolUses ?? 0) + 1;
        job.toolsUsed = [...new Set([...(job.toolsUsed ?? []), event.slice(5)])];
      }
      job.lifecycle = session!.lifecycle;
      onChange(job);
    },
    onWorkerMessage: (message, kind) => onWorkerMessage?.(job, message, kind),
    onPreview: (preview) => { job.livePreview = preview; onChange(job); },
    onCoordination: onCoordination ? (request, requestSignal) => onCoordination(job, request, requestSignal) : undefined,
  }, config.softRequestBudget);
  registerControl(job.id, undefined);
  job.durationMs = result.durationMs;
  job.usage = result.usage;
  job.requests = result.requests;
  job.sessionFile = result.sessionFile ?? session.sessionFile;
  job.ipcDir = source.ipcDir ?? join(dirname(job.sessionFile ?? source.sessionFile!), "ipc");
  job.lifecycle = session.lifecycle;
  job.cost = result.cost;
  job.contextTokens = result.contextTokens;
  job.contextWindow = result.contextWindow;
  const evidenceError = result.ok ? workerEvidenceError(job.task, job.toolsUsed) : undefined;
  const yieldError = result.ok && !result.yielded ? "worker did not submit the required structured workflow_yield handoff" : undefined;
  if (result.ok && !reportIsUnsuccessful(result.output) && !evidenceError && !yieldError) {
    const bounded = boundOutput(result.output, config.maxOutputChars, config.maxOutputBytes, config.maxOutputLines);
    job.status = "succeeded";
    job.output = bounded.text;
    job.outputTruncated = bounded.truncated;
    job.error = undefined;
  } else {
    job.status = signal.aborted ? "cancelled" : "failed";
    job.error = result.error || evidenceError || yieldError || "worker reported an unsuccessful result";
  }
  job.livePreview = undefined;
  job.finishedAt = new Date().toISOString();
  registry.adopt(source.id, session, config.agentIdleTtlMs);
  registry.adopt(job.id, session, config.agentIdleTtlMs);
  source.lifecycle = session.lifecycle;
  source.sessionFile = session.sessionFile;
  onChange(source);
  onChange(job);
  const artifactDir = source.artifactDir;
  if (artifactDir) {
    await writeFile(join(artifactDir, `followup-${job.id}.jsonl`), result.rawJsonl ?? "", "utf8");
    await writeFile(join(artifactDir, `followup-${job.id}.md`), result.output || job.error || "", "utf8");
  }
  return job;
}

export async function runJob(options: RuntimeOptions, job: Job, images: ImageAttachment[], signal: AbortSignal): Promise<Job> {
  const { pi, config, jobs, onChange, registerControl, onWorkerMessage, onCoordination } = options;
  if (signal.aborted || job.status === "cancelled") {
    job.status = "cancelled"; job.error ??= "Cancelled by user."; job.finishedAt ??= new Date().toISOString(); onChange(job); return job;
  }
  job.status = "running"; job.startedAt = new Date().toISOString(); job.finishedAt = undefined; onChange(job);
  if (!job.decision.profile.model.trim()) {
    job.status = "failed"; job.error = `No model configured for worker profile "${job.decision.kind}".`; job.finishedAt = new Date().toISOString(); onChange(job); return job;
  }

  const artifactDir = config.persistArtifacts ? join(options.cwd, ".pi", "agent-workflow-runs", job.id) : await mkdtemp(join(tmpdir(), "pi-agent-workflow-"));
  if (artifactDir) {
    await mkdir(artifactDir, { recursive: true }); job.artifactDir = config.persistArtifacts ? artifactDir : undefined;
    await writeFile(join(artifactDir, "task.md"), job.task, "utf8");
    await writeFile(join(artifactDir, "route.json"), JSON.stringify(job.decision, null, 2), "utf8");
    for (let i = 0; i < images.length; i++) await writeFile(join(artifactDir, `image-${i + 1}.${images[i].mimeType?.split("/")[1]?.replace(/[^a-z0-9]/gi, "") || "bin"}`), Buffer.from(images[i].data, "base64"));
  }

  let isolation: IsolationContext | undefined;
  let workerCwd = options.cwd;
  if (job.isolated) {
    try { isolation = await prepareIsolation(pi, options.cwd, job.id, config.isolationBackend); workerCwd = isolation.worktreeDir; job.worktreeDir = workerCwd; job.isolationBackend = isolation.backend; onChange(job); }
    catch (error) { job.status = "failed"; job.error = error instanceof Error ? error.message : String(error); job.finishedAt = new Date().toISOString(); onChange(job); return job; }
  }

  const imageInstruction = images.length ? `\nVisual attachments are files under ${artifactDir}. Read each image before making visual claims.\n` : "";
  const peers = [...jobs.values()].filter((peer) => peer.id !== job.id && ["running", "queued"].includes(peer.status));
  const peerInstruction = peers.length ? `\nPeer roster:\n${peers.map((peer) => `- ${peer.id}: ${peer.task.replace(/\s+/g, " ").slice(0, 100)}`).join("\n")}\n` : "\nPeer roster: none.\n";
  const skillInstruction = await loadedSkillPrompt(job.decision.profile, workerCwd);
  const spawnInstruction = job.decision.profile.spawns && (job.depth ?? 0) < config.maxDepth
    ? `You may use workflow_spawn for independent subproblems. Allowed child agents: ${job.decision.profile.spawns === "*" ? "any configured agent" : job.decision.profile.spawns.join(", ")}. Maximum remaining depth: ${config.maxDepth - (job.depth ?? 0)}. Do not spawn recursively unless it materially reduces work.`
    : "Do not recursively delegate; workflow_spawn is unavailable at this depth or for this profile.";
  const prompt = `You are a delegated ${job.decision.profile.label}.\n\n${job.decision.profile.description}${job.decision.profile.instructions ? `\n${job.decision.profile.instructions}` : ""}\nRules:\n- Work only on the bounded assignment. ${spawnInstruction}\n- Use workflow_peers and workflow_send for direct worker coordination when useful.\n- Use repository state and command output as evidence; never invent results.\n${EVIDENCE_DISCIPLINE}\n- Make edits only when requested and run focused validation.\n- Finish by calling workflow_yield exactly once. Do not merely print a final report.\n- If blocked, call workflow_yield with status blocked and the exact blocker.\n- Optional progress: WORKFLOW_UPDATE: <under 80 chars>.\n- Parent question: WORKFLOW_ASK: <question>. Peer message: WORKFLOW_TO: <id>: <message>.\n${skillInstruction}${job.sharedContext ? `\nShared context:\n${job.sharedContext}\n` : ""}${imageInstruction}${job.decision.profile.web ? "\nUse web tools directly and preserve source URLs.\n" : ""}${peerInstruction}\nBounded assignment:\n${job.task}`;

  const fallback = job.decision.profile.fallback;
  const fallbackModels = (Array.isArray(fallback) ? fallback : fallback ? [fallback] : []).filter((model, index, all) => model !== job.decision.profile.model && all.indexOf(model) === index);
  const attempts = Math.max(1, Math.min(config.maxRetries, fallbackModels.length) + 1);
  let lastError = "", totalDuration = 0, totalRequests = 0;
  let activeSession: WorkerSession | undefined;
  const totalUsage = emptyUsage();
  try {
    for (let attempt = 1; attempt <= attempts; attempt++) {
      job.attempts = attempt; job.toolUses = 0; job.toolsUsed = []; job.livePreview = undefined; onChange(job);
      const ipcDir = join(artifactDir, "ipc");
      job.ipcDir = ipcDir;
      const turn = await runDurableTurn(job.id, workerCwd, job.decision, prompt, job.task, join(artifactDir, "session"), ipcDir, config.timeoutMs, signal, (event, details) => {
        job.lastEvent = event; job.currentTool = event.startsWith("tool:") ? event.slice(5) : undefined;
        job.currentToolArgs = event.startsWith("tool:") && details !== undefined ? JSON.stringify(details).slice(0, 500) : undefined;
        job.lifecycle = event === "settled" ? "idle" : event === "retrying" ? "running" : job.lifecycle;
        if (event.startsWith("tool:")) { job.toolUses = (job.toolUses ?? 0) + 1; job.toolsUsed = [...new Set([...(job.toolsUsed ?? []), event.slice(5)])]; }
        onChange(job);
      }, (control) => registerControl(job.id, control), (message, kind) => onWorkerMessage?.(job, message, kind), (preview) => { job.livePreview = preview; }, onCoordination ? (request, requestSignal) => onCoordination(job, request, requestSignal) : undefined, undefined, config.softRequestBudget);
      const { result } = turn;
      activeSession = turn.session;
      job.sessionFile = result.sessionFile;
      job.lifecycle = activeSession.lifecycle;
      job.cost = result.cost;
      job.contextTokens = result.contextTokens;
      job.contextWindow = result.contextWindow;
      registerControl(job.id, undefined);
      totalDuration += result.durationMs; totalRequests += result.requests;
      for (const key of Object.keys(totalUsage) as Array<keyof UsageTotals>) totalUsage[key] += result.usage[key];
      if (artifactDir) { await writeFile(join(artifactDir, `child-${attempt}.jsonl`), result.rawJsonl ?? "", "utf8"); await writeFile(join(artifactDir, `stderr-${attempt}.txt`), result.stderr ?? "", "utf8"); }
      if (signal.aborted) { lastError = job.error || "Cancelled by user."; break; }
      const evidenceError = result.ok ? workerEvidenceError(job.task, job.toolsUsed) : undefined;
      const yieldError = result.ok && !result.yielded ? "worker did not submit the required structured workflow_yield handoff" : undefined;
      if (result.ok && !reportIsUnsuccessful(result.output) && !evidenceError && !yieldError) {
        if (isolation) {
          try { const merged = await mergeIsolation(pi, isolation); job.lastMessage = `↳ ${merged.summary.replace(/\s+/g, " ").slice(0, 100)}`; }
          catch (error) { lastError = error instanceof Error ? error.message : String(error); break; }
        }
        const bounded = boundOutput(result.output, config.maxOutputChars, config.maxOutputBytes, config.maxOutputLines);
        job.status = "succeeded"; job.output = bounded.text; job.outputTruncated = bounded.truncated; job.livePreview = undefined; job.error = undefined; job.finishedAt = new Date().toISOString(); job.durationMs = totalDuration; job.usage = totalUsage; job.requests = totalRequests;
        if (artifactDir) { await writeFile(join(artifactDir, "result-full.md"), result.output, "utf8"); await writeFile(join(artifactDir, "result.md"), job.output, "utf8"); }
        if (isolation) { await activeSession.terminate(); job.lifecycle = "aborted"; }
        else { workerSessionRegistry().adopt(job.id, activeSession, config.agentIdleTtlMs); job.lifecycle = activeSession.lifecycle; }
        onChange(job); return job;
      }
      lastError = result.ok ? (evidenceError || yieldError || "worker reported an unsuccessful result") : (result.error || "worker failed");
      if (attempt < attempts) {
        await activeSession.terminate();
        activeSession = undefined;
        job.decision = { ...job.decision, reason: `${job.decision.reason}; fallback after attempt ${attempt}`, profile: { ...job.decision.profile, model: fallbackModels[attempt - 1] } };
        if (artifactDir) await writeFile(join(artifactDir, "route.json"), JSON.stringify(job.decision, null, 2), "utf8");
      }
    }
    job.status = signal.aborted ? "cancelled" : "failed"; job.livePreview = undefined; job.error = lastError || job.error || "worker failed"; job.finishedAt = new Date().toISOString(); job.durationMs = totalDuration; job.usage = totalUsage; job.requests = totalRequests;
    if (activeSession && !isolation && activeSession.sessionFile && !signal.aborted) {
      workerSessionRegistry().adopt(job.id, activeSession, config.agentIdleTtlMs);
      job.lifecycle = activeSession.lifecycle;
    } else if (activeSession) {
      await activeSession.terminate();
      job.lifecycle = "aborted";
    }
    if (artifactDir) await writeFile(join(artifactDir, "error.txt"), job.error, "utf8"); onChange(job); return job;
  } finally {
    if (isolation) await cleanupIsolation(pi, isolation, job.status === "failed" && /patch preserved/.test(job.error ?? ""));
  }
}