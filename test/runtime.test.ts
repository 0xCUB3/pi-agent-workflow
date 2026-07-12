import test from "node:test";
import assert from "node:assert/strict";
import { protocolErrorFromJsonOutput, textFromJsonOutput, workerEvidenceError } from "../src/runtime.js";

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

test("requires actual tool evidence for requested repository work", () => {
  assert.match(workerEvidenceError("change value.txt from 1 to 2; do not modify any other files", ["read"]) ?? "", /mutation report/);
  assert.equal(workerEvidenceError("change value.txt from 1 to 2; do not modify any other files", ["read", "edit"]), undefined);
  assert.match(workerEvidenceError("change value.txt and run cat value.txt to validate", ["write"] ) ?? "", /command or test validation/);
  assert.equal(workerEvidenceError("change value.txt and run cat value.txt to validate", ["write", "bash"]), undefined);
  assert.match(workerEvidenceError("inspect the repository and report findings", []) ?? "", /repository tool/);
  assert.equal(workerEvidenceError("read package.json and report its version. Do not edit any files.", ["read"]), undefined);
});