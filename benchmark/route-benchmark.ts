import { DEFAULT_CONFIG } from "../src/config.js";
import { routeTask } from "../src/router.js";

const cases = [
  ["inspect the repo and find where auth is configured", "fast"],
  ["implement a retrying HTTP client and add tests", "implement"],
  ["design the public API for a plugin system", "design"],
  ["analyze this screenshot for visual regressions", "vision"],
  ["survey recent papers on sparse attention", "research"],
  ["rename this variable and format the file", "fast"],
  ["summarize the error log", "fast"],
] as const;

let correct = 0;
for (const [task, expected] of cases) {
  const actual = routeTask({ task, hasImages: false }, DEFAULT_CONFIG).kind;
  const ok = actual === expected;
  if (ok) correct++;
  console.log(`${ok ? "PASS" : "FAIL"} ${expected.padEnd(9)} -> ${actual.padEnd(9)} ${task}`);
}
console.log(`\nStatic routing accuracy: ${correct}/${cases.length} (${Math.round((correct / cases.length) * 100)}%)`);
console.log("This is a deterministic routing sanity check, not a model-quality benchmark.");