import test from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_CONFIG } from "../src/config.js";
import { routeTask } from "../src/router.js";

test("routes attached images to vision regardless of wording", () => {
  const result = routeTask({ task: "implement the dashboard", hasImages: true }, DEFAULT_CONFIG);
  assert.equal(result.kind, "vision");
  assert.match(result.reason, /visual/);
});

test("routes implementation to GLM profile", () => {
  const result = routeTask({ task: "implement the cache invalidation feature and run tests" }, DEFAULT_CONFIG);
  assert.equal(result.kind, "implement");
  assert.match(result.profile.model, /glm-5\.2/);
});

test("routes research and design separately", () => {
  assert.equal(routeTask({ task: "survey papers on diffusion models" }, DEFAULT_CONFIG).kind, "research");
  assert.equal(routeTask({ task: "design the API and UI component boundary" }, DEFAULT_CONFIG).kind, "design");
});

test("routes exploration to fast worker and ambiguous work to trivial", () => {
  assert.equal(routeTask({ task: "inspect the repository and run tests" }, DEFAULT_CONFIG).kind, "fast");
  assert.equal(routeTask({ task: "what is this?" }, DEFAULT_CONFIG).kind, "trivial");
});