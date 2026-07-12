import test from "node:test";
import assert from "node:assert/strict";
import { protocolErrorFromJsonOutput, textFromJsonOutput } from "../src/runtime.js";

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