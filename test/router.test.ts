import test from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_CONFIG } from "../src/config.js";
import { routeTask } from "../src/router.js";

test("routes attached images to vision regardless of wording", () => {
  const result = routeTask({ task: "implement the dashboard", hasImages: true }, DEFAULT_CONFIG);
  assert.equal(result.kind, "vision");
  assert.match(result.reason, /visual/);
});

test("routes implementation to the configured implementation profile", () => {
  const config = { ...DEFAULT_CONFIG, profiles: { ...DEFAULT_CONFIG.profiles, implement: { ...DEFAULT_CONFIG.profiles.implement, model: "test-provider/coding-model" } } };
  const result = routeTask({ task: "implement the cache invalidation feature and run tests" }, config);
  assert.equal(result.kind, "implement");
  assert.equal(result.profile.model, "test-provider/coding-model");
});

test("routes matching user-defined profiles before built-ins", () => {
  const config = { ...DEFAULT_CONFIG, profiles: { ...DEFAULT_CONFIG.profiles, proof: { kind: "proof", label: "Proof worker", model: "test-provider/reasoning", thinking: "high" as const, description: "Proof checking", triggers: ["counterexample"], priority: 10 } } };
  const result = routeTask({ task: "find a counterexample to this theorem" }, config);
  assert.equal(result.kind, "proof");
  assert.match(result.reason, /user profile/);
});

test("routes research and design separately", () => {
  assert.equal(routeTask({ task: "survey papers on diffusion models" }, DEFAULT_CONFIG).kind, "research");
  assert.equal(routeTask({ task: "design the API and UI component boundary" }, DEFAULT_CONFIG).kind, "design");
});

test("routes exploration to fast worker and ambiguous work to trivial", () => {
  assert.equal(routeTask({ task: "inspect the repository and run tests" }, DEFAULT_CONFIG).kind, "fast");
  assert.equal(routeTask({ task: "check whether the app auto-updates, but only filter scripts should update" }, DEFAULT_CONFIG).kind, "fast");
  assert.equal(routeTask({ task: "inspect package.json; read-only, do not modify files" }, DEFAULT_CONFIG).kind, "fast");
  assert.equal(routeTask({ task: "what is this?" }, DEFAULT_CONFIG).kind, "trivial");
});