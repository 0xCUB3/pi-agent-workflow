import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ChildResult, Job, RouteDecision, WorkflowConfig } from "./types.js";

export type ImageAttachment = { data: string; mimeType?: string };

export type WorkerControl = {
  steer(message: string): boolean;
  followUp(message: string): boolean;
};

type RuntimeOptions = {
  pi: ExtensionAPI;
  ctx: ExtensionContext;
  config: WorkflowConfig;
  jobs: Map<string, Job>;
  controls: Map<string, WorkerControl>;
  render: () => void;
  onWorkerMessage?: (job: Job, message: string, kind: "update" | "ask" | "peer") => void;
};

export function textFromJsonOutput(stdout: string): string {
  const messages: string[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const event = JSON.parse(line) as { type?: string; message?: { role?: string; content?: unknown } };
      if (event.type !== "message_end" || event.message?.role !== "assistant") continue;
      const content = event.message.content;
      if (typeof content === "string") messages.push(content);
      else if (Array.isArray(content)) {
        const text = content.filter((part): part is { type: "text"; text: string } => Boolean(part && typeof part === "object" && (part as { type?: string }).type === "text" && typeof (part as { text?: unknown }).text === "string")).map((part) => part.text).join("\n");
        if (text) messages.push(text);
      }
    } catch { /* non-JSON diagnostic line */ }
  }
  return messages.at(-1)?.trim() ?? "";
}

export function protocolErrorFromJsonOutput(stdout: string): string | undefined {
  for (const line of stdout.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const event = JSON.parse(line) as {
        type?: string;
        message?: { stopReason?: string; errorMessage?: string };
        messages?: Array<{ stopReason?: string; errorMessage?: string }>;
      };
      const candidates = [event.message, ...(event.messages ?? [])].filter(Boolean) as Array<{ stopReason?: string; errorMessage?: string}>;
      for (const message of candidates) {
        if (message.stopReason === "error" || message.errorMessage) {
          return message.errorMessage || "child agent reported an error";
        }
      }
    } catch { /* non-JSON diagnostic line */ }
  }
  return undefined;
}

function trimOutput(output: string, maxChars: number): string {
  if (output.length <= maxChars) return output;
  return `${output.slice(0, maxChars)}\n\n[output truncated by pi-agent-workflow]`;
}

function reportIsUnsuccessful(output: string): boolean {
  return /(?:^|\n)\s*(?:#+\s*)?result\s*:\s*(?:blocked|failed|incomplete|aborted|not complete)\b/i.test(output);
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
  const asksForRepositoryEvidence = /\b(?:inspect|audit|search|find|check|test|validate|run|repository|repo|file|source|code|exact lines?)\b/.test(text);
  if (asksForMutation && !["edit", "write"].some((tool) => tools.has(tool))) return "worker returned a mutation report without using an edit or write tool";
  if (/\b(?:cat|run|execute|command|tests?)\b/.test(text) && !tools.has("bash")) return "worker did not perform the requested command or test validation with bash";
  if (asksForRepositoryEvidence && tools.size === 0) return "worker returned a repository report without using any repository tool";
  return undefined;
}

async function runOnce(ctx: ExtensionContext, decision: RouteDecision, prompt: string, timeoutMs: number, signal: AbortSignal, onEvent: (event: string) => void, registerControl: (control: WorkerControl) => void, onWorkerMessage?: (message: string, kind: "update" | "ask" | "peer") => void): Promise<ChildResult> {
  const started = Date.now();
  const args = [
    "--mode", "rpc", "--no-session", "--no-extensions", "--no-skills",
    "--no-prompt-templates", "--no-context-files", "--model", decision.profile.model,
    "--thinking", decision.profile.thinking, "--tools", "read,bash,edit,write", "--name", `worker-${randomUUID().slice(0, 8)}`,
  ];
  return await new Promise((resolve) => {
    const child = spawn("pi", args, { cwd: ctx.cwd, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let buffer = "";
    const appendBounded = (current: string, value: string, max: number) => (current + value).slice(-max);
    let timedOut = false;
    let settled = false;
    const finish = (result: ChildResult) => { if (!settled) { settled = true; resolve(result); } };
    const send = (command: Record<string, unknown>): boolean => {
      if (child.stdin.destroyed || child.stdin.writableEnded) return false;
      child.stdin.write(`${JSON.stringify(command)}\n`);
      return true;
    };
    registerControl({
      steer: (message) => send({ type: "steer", message }),
      followUp: (message) => send({ type: "follow_up", message }),
    });
    const contentText = (content: unknown): string => {
      if (typeof content === "string") return content;
      if (!Array.isArray(content)) return "";
      return content.filter((part) => part && typeof part === "object" && (part as { type?: string }).type === "text" && typeof (part as { text?: unknown }).text === "string").map((part) => (part as { text: string }).text).join("\n");
    };
    const handleLine = (line: string) => {
      if (!line.trim()) return;
      stdout = appendBounded(stdout, `${line}\n`, 4_000_000);
      try {
        const event = JSON.parse(line) as { type?: string; toolName?: string; message?: { role?: string; content?: unknown }; assistantMessageEvent?: { type?: string; delta?: string; partial?: { content?: unknown } } };
        if (event.type === "tool_execution_start") onEvent(`tool:${event.toolName || "unknown"}`);
        else if (event.type === "tool_execution_end") onEvent(`done:${event.toolName || "unknown"}`);
        else if (event.type === "turn_start") onEvent("thinking");
        else if (event.type === "message_update" && event.assistantMessageEvent?.partial) {
          const text = contentText(event.assistantMessageEvent.partial.content);
          if (text) onWorkerMessage?.(text, "update");
        } else if (event.type === "message_end" && event.message?.role === "assistant") {
          onEvent("reporting");
          const text = contentText(event.message.content);
          const signal = parseWorkerMessage(text);
          if (signal?.kind === "ask") onWorkerMessage?.(signal.message, "ask");
          if (signal?.kind === "peer") onWorkerMessage?.(`${signal.target}::${signal.message}`, "peer");
        } else if (event.type === "agent_settled") {
          onEvent("settled");
          child.stdin.end();
        }
      } catch { /* diagnostics are retained in stdout */ }
    };
    child.stdout.on("data", (chunk: Buffer | string) => {
      buffer = appendBounded(buffer, chunk.toString(), 1_000_000);
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() || "";
      lines.forEach(handleLine);
    });
    child.stderr.on("data", (chunk: Buffer | string) => { stderr = appendBounded(stderr, chunk.toString(), 200_000); });
    send({ id: "initial", type: "prompt", message: prompt });
    const abort = () => {
      send({ type: "abort" });
      child.kill("SIGTERM");
    };
    signal.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(() => { timedOut = true; child.kill("SIGTERM"); }, timeoutMs);
    child.on("error", (error) => {
      clearTimeout(timer); signal.removeEventListener("abort", abort);
      finish({ ok: false, output: textFromJsonOutput(stdout), error: error.message, exitCode: 1, timedOut, durationMs: Date.now() - started, rawJsonl: stdout, stderr });
    });
    child.on("close", (code) => {
      clearTimeout(timer); signal.removeEventListener("abort", abort);
      if (buffer) handleLine(buffer);
      const output = textFromJsonOutput(stdout);
      const protocolError = protocolErrorFromJsonOutput(stdout);
      const error = protocolError ? `child model error: ${protocolError}` : trimOutput(stderr || output || `child exited with code ${code}`, 8_000);
      if (code !== 0 || timedOut || signal.aborted || protocolError) finish({ ok: false, output, error, exitCode: code ?? 1, timedOut, durationMs: Date.now() - started, rawJsonl: stdout, stderr });
      else if (!output) finish({ ok: false, output: "", error: "child produced no assistant result", exitCode: code ?? 0, timedOut: false, durationMs: Date.now() - started, rawJsonl: stdout, stderr });
      else finish({ ok: true, output, exitCode: code ?? 0, timedOut: false, durationMs: Date.now() - started, rawJsonl: stdout, stderr });
    });
  });
}

export async function runJob(options: RuntimeOptions, job: Job, images: ImageAttachment[], signal: AbortSignal): Promise<Job> {
  const { pi, ctx, config, jobs, controls, render, onWorkerMessage } = options;
  job.status = "running";
  job.startedAt = new Date().toISOString();
  jobs.set(job.id, job);
  render();

  const artifactDir = config.persistArtifacts
    ? join(ctx.cwd, ".pi", "agent-workflow-runs", job.id)
    : images.length > 0
      ? await mkdtemp(join(tmpdir(), "pi-agent-workflow-"))
      : undefined;
  if (artifactDir) {
    await mkdir(artifactDir, { recursive: true });
    if (config.persistArtifacts) job.artifactDir = artifactDir;
    await writeFile(join(artifactDir, "task.md"), job.task, "utf8");
    await writeFile(join(artifactDir, "route.json"), JSON.stringify(job.decision, null, 2), "utf8");
    for (let i = 0; i < images.length; i++) {
      const image = images[i];
      const ext = image.mimeType?.split("/")[1]?.replace(/[^a-z0-9]/gi, "") || "bin";
      await writeFile(join(artifactDir, `image-${i + 1}.${ext}`), Buffer.from(image.data, "base64"));
    }
  }

  const imageInstruction = images.length > 0
    ? `\n\nVisual attachments are available to you as files under ${artifactDir || ".pi/agent-workflow-runs/"}. Use the read tool on each image file before making visual claims. You are the visual-perception worker; return concrete observations and uncertainty.\n`
    : "";
  const peers = [...jobs.values()].filter((peer) => peer.id !== job.id && (peer.status === "running" || peer.status === "queued"));
  const peerInstruction = peers.length ? `\nPeer roster (message only these ids):\n${peers.map((peer) => `- ${peer.id}: ${peer.task.replace(/\s+/g, " ").slice(0, 100)}`).join("\n")}\n` : "\nPeer roster: none.\n";
  const prompt = `You are a delegated ${job.decision.profile.label}.\n\n${job.decision.profile.description}\n\nRules:\n- Work only on the bounded task below.\n- Treat repository state and command output as evidence; do not invent files, tests, or results.\n- Make edits only when the task asks for implementation.\n- Run focused validation when practical.\n- End with a concise report containing: Result, Changes, Validation, Risks, Next step.\n- If blocked, say exactly what blocked you instead of pretending success.\n- You may report concise live progress with a line beginning \`WORKFLOW_UPDATE:\`.\n- If you need a decision from the parent, emit \`WORKFLOW_ASK: <question>\` and continue only with safe, reversible work.\n- To send a concise message to another running worker, emit \`WORKFLOW_TO: <worker-id>: <message>\` after checking the peer roster below.\n${imageInstruction}${peerInstruction}\nBounded task:\n${job.task}`;

  let lastError = "";
  const attempts = Math.max(1, config.maxRetries + 1);
  for (let attempt = 1; attempt <= attempts; attempt++) {
    job.attempts = attempt;
    job.toolUses = 0;
    job.toolsUsed = [];
    const result = await runOnce(ctx, job.decision, prompt, config.timeoutMs, signal, (event) => {
      job.lastEvent = event;
      if (event.startsWith("tool:")) {
        job.toolUses = (job.toolUses ?? 0) + 1;
        const tool = event.slice(5);
        job.toolsUsed = [...new Set([...(job.toolsUsed ?? []), tool])];
      }
      job.currentTool = event.startsWith("tool:") ? event.slice(5) : undefined;
      jobs.set(job.id, job);
      render();
    }, (control) => controls.set(job.id, control), (message, kind) => onWorkerMessage?.(job, message, kind));
    controls.delete(job.id);
    if (artifactDir) {
      await writeFile(join(artifactDir, `child-${attempt}.jsonl`), result.rawJsonl ?? "", "utf8");
      await writeFile(join(artifactDir, `stderr-${attempt}.txt`), result.stderr ?? "", "utf8");
    }
    const evidenceError = result.ok ? workerEvidenceError(job.task, job.toolsUsed) : undefined;
    if (result.ok && !reportIsUnsuccessful(result.output) && !evidenceError) {
      job.status = "succeeded";
      job.output = trimOutput(result.output, config.maxOutputChars);
      job.finishedAt = new Date().toISOString();
      if (artifactDir) await writeFile(join(artifactDir, "result.md"), job.output, "utf8");
      jobs.set(job.id, job);
      render();
      return job;
    }
    lastError = result.ok ? (evidenceError || "worker reported an unsuccessful result") : (result.error || "worker failed");
    if (attempt < attempts && job.decision.profile.fallback) {
      job.decision = { ...job.decision, reason: `${job.decision.reason}; fallback after attempt ${attempt}`, profile: { ...job.decision.profile, model: job.decision.profile.fallback } };
      if (artifactDir) await writeFile(join(artifactDir, "route.json"), JSON.stringify(job.decision, null, 2), "utf8");
    }
  }
  job.status = signal.aborted ? "cancelled" : "failed";
  job.error = lastError;
  job.finishedAt = new Date().toISOString();
  if (artifactDir) await writeFile(join(artifactDir, "error.txt"), lastError, "utf8");
  jobs.set(job.id, job);
  render();
  return job;
}

export function createQueue(maxConcurrent: number) {
  let active = 0;
  const waiters: Array<() => void> = [];
  return async function withSlot<T>(fn: () => Promise<T>): Promise<T> {
    if (active >= maxConcurrent) await new Promise<void>((resolve) => waiters.push(resolve));
    active++;
    try { return await fn(); }
    finally {
      active--;
      waiters.shift()?.();
    }
  };
}