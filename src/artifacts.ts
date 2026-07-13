import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Job } from "./types.js";

function textContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.filter((part) => part && typeof part === "object" && (part as { type?: string }).type === "text")
    .map((part) => String((part as { text?: string }).text ?? "")).join("\n");
}

function oneLine(value: string, max = 500): string {
  const text = value.replace(/[\u0000-\u001f\u007f-\u009f\s]+/g, " ").trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** Render a concise, reasoning-free transcript from a persisted Pi worker session. */
export async function workerHistory(job: Job, maxEntries = 80, maxChars = 20_000): Promise<string> {
  if (!job.sessionFile) return `Worker ${job.id} has no persisted session transcript.`;
  let source: string;
  try { source = await readFile(job.sessionFile, "utf8"); }
  catch (error) { return `Unable to read worker ${job.id} transcript: ${error instanceof Error ? error.message : String(error)}`; }
  const rows: string[] = [];
  for (const line of source.split("\n")) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line) as { type?: string; message?: { role?: string; content?: unknown; toolName?: string; isError?: boolean } };
      if (entry.type !== "message" || !entry.message) continue;
      const message = entry.message;
      if (message.role === "user") rows.push(`USER: ${oneLine(textContent(message.content))}`);
      else if (message.role === "assistant") {
        const text = oneLine(textContent(message.content));
        const tools = Array.isArray(message.content) ? message.content.filter((part) => part && typeof part === "object" && (part as { type?: string }).type === "toolCall").map((part) => String((part as { name?: string }).name ?? "tool")) : [];
        if (text) rows.push(`ASSISTANT: ${text}`);
        if (tools.length) rows.push(`TOOLS: ${tools.join(", ")}`);
      } else if (message.role === "toolResult") {
        const text = oneLine(textContent(message.content), 300);
        rows.push(`${message.isError ? "TOOL ERROR" : "TOOL"} ${message.toolName ?? "unknown"}: ${text}`);
      }
    } catch { /* skip malformed or non-message entries */ }
  }
  const selected = rows.slice(-Math.max(1, Math.min(maxEntries, 500)));
  const rendered = selected.join("\n");
  return rendered.length > maxChars ? `…${rendered.slice(-(maxChars - 1))}` : rendered || `Worker ${job.id} transcript contains no messages.`;
}

export async function workerFullOutput(job: Job): Promise<string> {
  if (job.artifactDir) {
    try { return await readFile(join(job.artifactDir, "result-full.md"), "utf8"); }
    catch { /* fall through to persisted bounded result */ }
  }
  return job.output ?? job.error ?? `Worker ${job.id} has no result.`;
}