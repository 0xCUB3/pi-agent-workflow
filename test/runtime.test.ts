import test from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_CONFIG } from "../src/config.js";
import { boundOutput, continuationPrompt, EVIDENCE_DISCIPLINE, livePreviewFromAssistantEvent, parseWorkerMessage, parseWorkflowUpdate, protocolErrorFromJsonOutput, runJob, structuredYieldFromJsonOutput, taskRequestsMutation, textFromJsonOutput, workerEvidenceError, workerToolNames } from "../src/runtime.js";

test("worker evidence discipline rejects unsupported source claims", () => {
  assert.match(EVIDENCE_DISCIPLINE, /verify its exact spelling/);
  assert.match(EVIDENCE_DISCIPLINE, /remove unsupported claims/);
  assert.match(EVIDENCE_DISCIPLINE, /direct observations from interpretations/);
});

test("streams visible assistant text without thinking or workflow markers", () => {
  const preview = livePreviewFromAssistantEvent({ assistantMessageEvent: { partial: { content: [
    { type: "thinking", thinking: "private chain" },
    { type: "text", text: "Drafting result\nWORKFLOW_UPDATE: halfway\nwith evidence" },
  ] } } });
  assert.equal(preview, "Drafting result with evidence");
});

test("streams a partial workflow_yield result from tool arguments", () => {
  const preview = livePreviewFromAssistantEvent({ assistantMessageEvent: { partial: { content: [
    { type: "toolCall", name: "workflow_yield", partialArgs: "{\"status\":\"completed\",\"result\":\"First line\\npartial" },
  ] } } });
  assert.equal(preview, "First line partial");
});

test("continuation preserves a verified plain-text draft", () => {
  const draft = "- `runOnce` owns one child process.\n- `runJob` owns retries.";
  const jsonl = JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: draft }] } });
  const prompt = continuationPrompt(jsonl, "Return exactly two bullets under 120 words.");
  assert.match(prompt, /preserve verified facts/);
  assert.match(prompt, /`runOnce` owns one child process/);
  assert.match(prompt, /do not replace precise evidence with a generic summary/);
  assert.match(prompt, /Return exactly two bullets under 120 words/);
});

test("extracts assistant reports from Pi JSON mode", () => {
  const jsonl = [
    JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "Report: clean" }] } }),
  ].join("\n");
  assert.equal(textFromJsonOutput(jsonl), "Report: clean");
  assert.equal(protocolErrorFromJsonOutput(jsonl), undefined);
});

test("extracts protocol errors even when Pi exits zero", () => {
  const jsonl = JSON.stringify({
    type: "message_end",
    message: {
      role: "assistant",
      content: [{ type: "text", text: "" }],
      stopReason: "error",
      errorMessage: "Failed to resolve API key for provider electronhub-devpass",
    },
  });
  assert.equal(textFromJsonOutput(jsonl), "");
  assert.match(protocolErrorFromJsonOutput(jsonl) ?? "", /Failed to resolve API key/);
});

test("parses bounded worker message signals", () => {
  assert.equal(parseWorkflowUpdate("WORKFLOW_UPDATE: reading src/runtime.ts"), "reading src/runtime.ts");
  assert.equal(parseWorkflowUpdate("ordinary progress"), undefined);
  assert.deepEqual(parseWorkerMessage("progress\nWORKFLOW_ASK: Need the target branch"), { kind: "ask", message: "Need the target branch" });
  assert.deepEqual(parseWorkerMessage("WORKFLOW_TO: w1234abcd: Please inspect the failing test"), { kind: "peer", target: "w1234abcd", message: "Please inspect the failing test" });
  assert.equal(parseWorkerMessage("ordinary progress"), undefined);
});

test("gives workers least-privilege toolsets", () => {
  const decision = (kind: string, web: boolean) => ({ kind, reason: "test", profile: { kind, label: "Worker", model: "provider/model", thinking: "medium" as const, description: "test", web, spawns: undefined as string[] | undefined } });
  assert.equal(taskRequestsMutation("Design the API; do not modify files"), false);
  assert.equal(taskRequestsMutation("Inspect and implement the fix"), true);
  assert.deepEqual(workerToolNames(decision("design", false), "Design the API; do not modify files"), ["read", "bash", "workflow_yield", "workflow_peers", "workflow_send", "workflow_inbox", "workflow_wait", "workflow_resource"]);
  assert.deepEqual(workerToolNames(decision("implement", false), "Implement the fix"), ["read", "bash", "edit", "write", "workflow_yield", "workflow_peers", "workflow_send", "workflow_inbox", "workflow_wait", "workflow_resource"]);
  assert.deepEqual(workerToolNames(decision("research", true), "Research the library"), ["read", "bash", "workflow_yield", "web_search", "fetch_content", "get_search_content", "workflow_peers", "workflow_send", "workflow_inbox", "workflow_wait", "workflow_resource"]);
  assert.deepEqual(workerToolNames(decision("research", true), "Research and implement the local fix"), ["read", "bash", "edit", "write", "workflow_yield", "web_search", "fetch_content", "get_search_content", "workflow_peers", "workflow_send", "workflow_inbox", "workflow_wait", "workflow_resource"]);
  assert.deepEqual(workerToolNames(decision("deep_research", true), "Audit local and external evidence"), ["read", "bash", "workflow_yield", "web_search", "fetch_content", "get_search_content", "workflow_peers", "workflow_send", "workflow_inbox", "workflow_wait", "workflow_resource"]);
  assert.deepEqual(workerToolNames(decision("implement", true), "Implement the fix"), ["read", "bash", "edit", "write", "workflow_yield", "web_search", "fetch_content", "get_search_content", "workflow_peers", "workflow_send", "workflow_inbox", "workflow_wait", "workflow_resource"]);
  const spawning = decision("design", false); spawning.profile.spawns = ["fast"];
  assert.ok(workerToolNames(spawning, "Inspect design").includes("workflow_spawn"));
});

test("extracts and formats structured worker yields", () => {
  const details = { status: "completed", result: "Fixed it.", changes: ["src/a.ts"], validation: ["npm test: passed"], risks: [], nextStep: "Review diff." };
  const jsonl = JSON.stringify({ type: "tool_execution_end", toolName: "workflow_yield", result: { details } });
  assert.deepEqual(structuredYieldFromJsonOutput(jsonl), {
    status: "completed",
    output: "Result: completed\nFixed it.\n\nChanges:\n- src/a.ts\n\nValidation:\n- npm test: passed\n\nRisks:\n- None\n\nNext step: Review diff.",
  });
  assert.equal(textFromJsonOutput(jsonl), structuredYieldFromJsonOutput(jsonl)?.output);
});

test("bounds worker output by lines and characters", () => {
  const result = boundOutput("one\ntwo\nthree", 100, 100, 2);
  assert.equal(result.truncated, true);
  assert.match(result.text, /^one\ntwo/);
});

test("keeps protocol markers out of the final worker report", () => {
  const jsonl = [
    JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "WORKFLOW_UPDATE: reading files\n\nResult: clean\nWORKFLOW_ASK: none" }] } }),
  ].join("\n");
  assert.equal(textFromJsonOutput(jsonl), "Result: clean");
});

test("does not spawn a queued worker after cancellation", async () => {
  const jobs = new Map<string, any>();
  const job = {
    id: "w-cancelled",
    cwd: "/tmp",
    createdAt: new Date().toISOString(),
    task: "inspect the repository",
    status: "queued" as const,
    attempts: 0,
    decision: {
      kind: "fast",
      reason: "test",
      profile: { kind: "fast", label: "Fast", model: "provider/model", thinking: "off" as const, description: "test" },
    },
  };
  jobs.set(job.id, job);
  const controller = new AbortController();
  controller.abort();
  const result = await runJob({
    pi: {} as any,
    cwd: "/tmp",
    config: { ...DEFAULT_CONFIG, timeoutMs: 10_000, maxOutputChars: 1_000, maxRetries: 0, persistArtifacts: false, persistState: false, profiles: {} },
    jobs,
    onChange: () => {},
    registerControl: () => {},
  }, job, [], controller.signal);
  assert.equal(result.status, "cancelled");
  assert.equal(result.finishedAt !== undefined, true);
});

test("requires actual tool evidence for requested repository work", () => {
  assert.match(workerEvidenceError("change value.txt from 1 to 2; do not modify any other files", ["read", "bash"]) ?? "", /edit or write tool/);
  assert.equal(workerEvidenceError("change value.txt from 1 to 2; do not modify any other files", ["read", "edit"]), undefined);
  assert.match(workerEvidenceError("change value.txt and run cat value.txt to validate", ["write"] ) ?? "", /command or test validation/);
  assert.equal(workerEvidenceError("change value.txt and run cat value.txt to validate", ["write", "bash"]), undefined);
  assert.match(workerEvidenceError("inspect the repository and report findings", []) ?? "", /repository tool/);
  assert.equal(workerEvidenceError("read package.json and report its version. Do not edit any files.", ["read"]), undefined);
  assert.equal(workerEvidenceError("test the newly configured research worker using web search", ["web_search"]), undefined);
  assert.equal(workerEvidenceError("Run the requested command through a child", ["workflow_spawn"]), undefined);
  assert.equal(workerEvidenceError("Have a child implement the requested fix", ["workflow_spawn"]), undefined);
});