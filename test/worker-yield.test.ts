import test from "node:test";
import assert from "node:assert/strict";
import { outputConstraintError } from "../src/worker-yield.js";

test("accepts an exact concise bullet result", () => {
  const task = "Return exactly two concise bullets, one for each function.";
  const result = "- `runOnce` spawns `pi` and parses JSONL events.\n- `runJob` owns retries, isolation, and job state.";
  assert.equal(outputConstraintError(task, result), undefined);
});

test("rejects the wrong explicit bullet count", () => {
  const error = outputConstraintError("Return exactly two bullets.", "- One bullet only.");
  assert.match(error ?? "", /requires exactly 2 bullets/);
});

test("rejects overlong concise bullets with measured feedback", () => {
  const words = Array.from({ length: 71 }, (_, i) => `word${i}`).join(" ");
  const error = outputConstraintError("Return exactly two concise bullets.", `- ${words}\n- short`);
  assert.match(error ?? "", /at most 70 words/);
  assert.match(error ?? "", /contains 72/);
});

test("honors an explicit total word limit", () => {
  const error = outputConstraintError("Return exactly one bullet at most 5 words total.", "- one two three four five six");
  assert.match(error ?? "", /at most 5 words/);
});