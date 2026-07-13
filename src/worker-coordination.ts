import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

type IpcResponse = { ok: boolean; result?: unknown; error?: string; jobId?: string };
const ipcDir = process.env.PI_WORKFLOW_IPC_DIR;
const timeoutMs = Math.max(10_000, Number(process.env.PI_WORKFLOW_IPC_TIMEOUT_MS ?? 1_800_000));

async function request(payload: Record<string, unknown>, signal?: AbortSignal): Promise<IpcResponse> {
  if (!ipcDir) return { ok: false, error: "Worker coordination IPC is unavailable." };
  const id = randomUUID();
  const requests = join(ipcDir, "requests"), responses = join(ipcDir, "responses");
  await mkdir(requests, { recursive: true });
  await mkdir(responses, { recursive: true });
  const target = join(requests, `${id}.json`), temp = `${target}.${process.pid}.tmp`;
  await writeFile(temp, JSON.stringify({ id, workerId: process.env.PI_WORKFLOW_WORKER_ID, ...payload }), "utf8");
  await rename(temp, target);
  const responsePath = join(responses, `${id}.json`);
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (signal?.aborted) return { ok: false, error: "Coordination request cancelled." };
    try {
      const value = JSON.parse(await readFile(responsePath, "utf8")) as IpcResponse;
      await unlink(responsePath).catch(() => {});
      return value;
    } catch { await new Promise((resolve) => setTimeout(resolve, 75)); }
  }
  return { ok: false, error: `Coordination request timed out after ${timeoutMs}ms.` };
}

export default function workerCoordination(pi: ExtensionAPI) {
  pi.registerTool({
    name: "workflow_peers",
    label: "List peer workers",
    description: "List visible workers, their ids, status, role, and nesting depth.",
    parameters: Type.Object({}),
    async execute(_id, _params, signal) {
      const response = await request({ type: "list" }, signal);
      return { content: [{ type: "text", text: response.ok ? JSON.stringify(response.result, null, 2) : response.error ?? "Unable to list peers." }], details: response, isError: !response.ok };
    },
  });

  pi.registerTool({
    name: "workflow_send",
    label: "Message peer worker",
    description: "Send a direct message to a worker id, Main, or * to broadcast. Set awaitReply only when blocked on a substantive answer.",
    parameters: Type.Object({ target: Type.String(), message: Type.String(), replyTo: Type.Optional(Type.String()), awaitReply: Type.Optional(Type.Boolean()), timeoutMs: Type.Optional(Type.Number({ minimum: 0, maximum: 300000 })) }),
    async execute(_id, params, signal) {
      const response = await request({ type: "send", target: params.target, message: params.message, replyTo: params.replyTo, awaitReply: params.awaitReply, timeoutMs: params.timeoutMs }, signal);
      return { content: [{ type: "text", text: response.ok ? String(response.result ?? "Message delivered.") : response.error ?? "Message failed." }], details: response, isError: !response.ok };
    },
  });

  pi.registerTool({
    name: "workflow_inbox",
    label: "Worker inbox",
    description: "Read pending peer messages. By default messages are consumed; set peek to leave them unread.",
    parameters: Type.Object({ from: Type.Optional(Type.String()), peek: Type.Optional(Type.Boolean()) }),
    async execute(_id, params, signal) {
      const response = await request({ type: "inbox", from: params.from, peek: params.peek }, signal);
      return { content: [{ type: "text", text: response.ok ? JSON.stringify(response.result, null, 2) : response.error ?? "Unable to read inbox." }], details: response, isError: !response.ok };
    },
  });

  pi.registerTool({
    name: "workflow_wait",
    label: "Wait for worker message",
    description: "Wait for the next peer message, optionally filtering by sender. Prefer workflow_send awaitReply for a request/response exchange.",
    parameters: Type.Object({ from: Type.Optional(Type.String()), timeoutMs: Type.Optional(Type.Number({ minimum: 0, maximum: 300000 })) }),
    async execute(_id, params, signal) {
      const response = await request({ type: "wait", from: params.from, timeoutMs: params.timeoutMs }, signal);
      return { content: [{ type: "text", text: response.ok ? JSON.stringify(response.result, null, 2) : response.error ?? "Message wait failed." }], details: response, isError: !response.ok };
    },
  });

  pi.registerTool({
    name: "workflow_resource",
    label: "Read workflow resource",
    description: "Read an agent:// or history:// resource from the parent workflow registry.",
    parameters: Type.Object({ uri: Type.String() }),
    async execute(_id, params, signal) {
      const response = await request({ type: "resource", uri: params.uri }, signal);
      return { content: [{ type: "text", text: response.ok ? String(response.result ?? "") : response.error ?? "Unable to read workflow resource." }], details: response, isError: !response.ok };
    },
  });

  pi.registerTool({
    name: "workflow_spawn",
    label: "Spawn nested worker",
    description: "Spawn an allowed child worker and wait for its bounded result. Use only for an independent subproblem that materially helps your assignment.",
    parameters: Type.Object({ task: Type.String(), agent: Type.Optional(Type.String()), name: Type.Optional(Type.String()), isolated: Type.Optional(Type.Boolean()) }),
    async execute(_id, params, signal) {
      const response = await request({ type: "spawn", task: params.task, agent: params.agent, name: params.name, isolated: params.isolated }, signal);
      return { content: [{ type: "text", text: response.ok ? String(response.result ?? "Nested worker completed without output.") : response.error ?? "Nested worker failed." }], details: response, isError: !response.ok };
    },
  });
}