# Competition benchmark

Run date: 2026-07-12

This is a **local engineering benchmark**, not a claim that one model is universally better. Tests ran on macOS with Node.js 26 and the repository heads available on the run date. Model-quality comparisons are intentionally not reported without a reproducible task corpus and stable provider snapshots.

## Results

| Project | Scope | Result |
|---|---|---|
| `pi-agent-workflow` | Typecheck + 4 routing tests | **4/4 passed** |
| `pi-agent-workflow` | Deterministic routing corpus | **7/7 (100%)** |
| `pi-agent-workflow` | Live end-to-end edit smoke test | **passed**: parent delegated `math.ts` fix; worker changed `a-b` to `a+b`; artifact/report persisted |
| `pi-agent-router` 0.9.0 | upstream utility/integration suite | **failed locally** at `session-paths-test.ts` (`493 !== 384`) after earlier suites passed; likely Node/platform-dependent, so not treated as a product-quality score |
| `pi-multiagent` 0.9.8 | upstream test suite | **269 passed** |
| `pi-analyst-worker-orchestrator` 0.1.18 | package load under its own dependencies | loaded; no `typecheck` or test script exposed by package |

## Live smoke-test details

Fixture:

```ts
export function add(a: number, b: number) { return a - b; }
```

Prompted parent Pi to use `delegate_work` without editing. The extension:

1. Classified the task as `implement`.
2. Selected the configured implementation profile.
3. Launched a clean child Pi process.
4. Applied the edit.
5. Ran a focused validation.
6. Returned the worker report to the parent.
7. Persisted `task.md`, `route.json`, and `result.md`.

For the smoke test only, the implementation profile was temporarily pointed at `openai-codex/gpt-5.3-codex-spark` because the benchmark machine did not have an available ElectronHub key in its keychain. This validates orchestration, not DevPass model quality.

## Interpretation

`pi-agent-workflow` is not the largest or most feature-rich system tested. Its target is narrower: one extension, one parent-facing tool, automatic model roles, image-first vision routing, clean non-recursive children, bounded evidence, and a small operator surface. `pi-multiagent` has a substantially larger and more exhaustive safety/graph test suite; `pi-agent-router` has a more mature delegation runtime. Those are strengths, not failures of this project. The remaining gap is broader fault-injection coverage and live model task benchmarking.

## Reproduction

```bash
npm ci
npm run check
npm run benchmark:static
```

Competition repositories were tested from their public repository heads with `npm install --ignore-scripts` followed by their documented test command. Raw logs were kept outside this repository to avoid publishing environment-specific paths and credentials.