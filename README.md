# pi-agent-workflow

One orchestrator. Automatically routed workers. Evidence before confidence.

`pi-agent-workflow` is a single Pi extension for developers and researchers who want a strong model to coordinate inexpensive, specialized workers without manually choosing a model for every task.

## Philosophy

- **The parent decides.** The active Pi session remains the analyst and final authority.
- **Workers are bounded.** A worker gets one bounded task, a narrow prompt, and declared tools. Profiles may permit depth-limited recursive delegation and live peer coordination.
- **Model choice is policy, not ceremony.** Routing is automatic and inspectable; users do not need to select a model per task.
- **Evidence beats confidence.** A worker must report changes and validation. The parent must inspect the actual repository state before claiming success.
- **Visual work is different.** Images go to a vision-capable worker first. A text-only analyst receives the resulting visual report, not a pretend visual interpretation.
- **Failures are data.** Timeouts, empty responses, failed commands, and fallback attempts remain visible.
- **Cost is a first-class constraint.** Cheap models handle exploration and mechanical work; stronger models are reserved for work that benefits from them.
- **Small parent footprint.** One extension and a compact prompt, with a lifecycle core adapted from OMP rather than OMP's full runtime.

## Install

```bash
pi install npm:pi-agent-workflow
```

Then reload Pi:

```text
/reload
```

The package is compatible with the `@earendil-works` Pi distribution and uses normal Pi model references. It does not contain or require API keys.

## How it works

The parent model sees workflow tools:

```text
delegate_work({ task: "..." })                          # waits by default
delegate_work({ task: "...", async: true })             # explicit background mode
delegate_work({ task: "...", isolated: true })          # clean-git worktree isolation
delegate_tasks({ context: "...", tasks: [...] })         # bounded parallel batch
wait_for_workers({ jobIds: ["w1234abcd"] })              # event-driven wait
worker_status({ jobIds: ["w1234abcd"] })                 # inspect without waiting
workflow_message({ jobId: "w1234abcd", message: "...", mode: "follow_up" })
worker_history({ jobIds: ["w1234abcd"] })                 # durable transcript
worker_result({ jobId: "w1234abcd" })                     # untruncated report
release_workers({ jobIds: ["w1234abcd"] })                # release idle sessions
cancel_workers({ jobIds: ["w1234abcd"] })                # targeted cancellation
```

The extension classifies each bounded task, chooses a worker profile, and launches a clean RPC child Pi process. Its scheduler supports batches, global and per-provider concurrency, background runs, targeted cancellation, live steering, same-session follow-ups, idle parking/revival, persisted recovery, durable transcripts, bounded artifacts, structured yields, token/cost/context accounting, soft request budgets, and optional worktree isolation. The parent still receives only a compact evidence report.

```text
user request
    │
    ▼
parent Pi session (analyst/orchestrator)
    │  decides whether independent work is worthwhile
    ▼
delegate_work / delegate_tasks
    │  deterministic routing + cancellable scheduler
    ▼
durable RPC child Pi session ◄── steering / same-context follow-up
    │  tools + required structured workflow_yield
    ▼
bounded report + full artifacts ──► parent verifies evidence
```

Delegation is proactive by default: the parent is instructed to call `delegate_work` for substantial independent work without requiring the user to mention it. Say “don’t delegate”, “don’t use a worker”, or “do it yourself” to opt out for the current turn. The extension also blocks the tool during that opt-out turn. It does not silently run every prompt through another model; delegation remains a tool call so the parent can avoid unnecessary latency and context duplication.

## Built-in worker profiles

The extension provides routing categories, but **you choose and configure the models**. There are no provider-specific model defaults in the package:

| Profile | Intended work | Recommended model class |
|---|---|---|
| `fast` | exploration, tests, logs, bounded mechanical work | fast tool-using model |
| `implement` | substantive implementation and debugging | strong coding/tool-use model |
| `design` | architecture, API, and UI trade-offs | reasoning-oriented model |
| `vision` | screenshots, diagrams, visual inspection | vision-capable model |
| `research` | papers, code archaeology, math, evidence | long-context/reasoning model |
| `trivial` | tiny summaries and read-only tasks | low-cost general model |

Configure each model using a normal Pi model reference in `agent-workflow.json`. Choose models based on tool calling, context length, reasoning, and vision support—not provider name.

## Automatic routing

Routing uses task text and attached-image presence:

- Attached image, screenshot, diagram, or visual regression → `vision`
- Architecture, API shape, UI/UX, or trade-offs → `design`
- Papers, citations, proofs, mathematics, or code archaeology → `research`
- Implement, fix, refactor, feature, migration, or multi-file work → `implement`
- Inspect, grep, search, tests, status, or mechanical validation → `fast`
- Otherwise → `trivial`

The image check wins. A non-vision parent is never asked to hallucinate visual observations: the vision worker reads the saved attachment and returns a structured report.

## Commands

```text
/workflow status   # recent and active workers
/workflow config   # effective routing profiles and limits
/workflow steer <job-id> <message> # steer a running worker
/workflow followup <job-id> <message> # queue a follow-up
/workflow doctor   # check model refs without making model calls
/workflow doctor live # test configured model authentication
/workflow stop     # cancel active workers
```

Delegation waits for the report by default. Use `async: true` only for explicitly requested background work, then call `wait_for_workers` before continuing. `delegate_tasks` launches up to eight independent slices under the configured global and per-provider limits. The parent can steer running jobs with `workflow_message`; `mode: "follow_up"` continues a completed job in the exact same persisted Pi session, retaining its full model context. Idle sessions park after `agentIdleTtlMs` and transparently revive from their session file when messaged. Workers can emit bounded progress and questions. `workflow_peers` lists Main, siblings, parents, idle workers, and parked workers; `workflow_send` supports direct messages, broadcasts, IDs, receipts, `replyTo`, and bounded `awaitReply` round trips. `workflow_inbox` supports consume/peek and sender filters; `workflow_wait` blocks for the next matching message. `workflow_spawn` starts an allowed nested agent and returns its result synchronously. Workers can request a synchronous response from Main; Main answers with `workflow_reply`. Every successful worker must finish through the structured `workflow_yield` tool.

The UI intentionally follows the Claude Code-style `pi-subagents` pattern:

- An animated, themed **Agents** widget above the editor with spinners, colored status icons, task summaries, model, attempts, elapsed time, tool count, live worker narration (`⎿ reading…`, `⎿ editing…`), and a bounded streaming preview (`≋ …`) of visible assistant output. Thinking/reasoning content and workflow protocol markers are never shown.
- Finished workers linger briefly in the same panel so completion and errors remain readable.
- Background completions appear as report blobs tagged with the worker type and short id; they do not automatically trigger a parent turn.

Each run writes inspectable artifacts under:

```text
.pi/agent-workflow-runs/<job-id>/
```

Artifacts include the task, route decision, visual attachments when present, worker result, bounded child JSONL/stderr captures, and failure diagnostics. Provider and authentication failures are preserved verbatim instead of being mislabeled as empty worker responses.

## Configuration

Global configuration:

```text
~/.pi/agent/agent-workflow.json
```

Project configuration, which overrides global values:

```text
.pi/agent-workflow.json
```

Example:

```json
{
  "maxConcurrent": 2,
  "maxConcurrentPerProvider": 1,
  "timeoutMs": 1800000,
  "maxRetries": 1,
  "persistState": true,
  "recoverInterrupted": true,
  "isolation": true,
  "agentIdleTtlMs": 420000,
  "softRequestBudget": 200,
  "maxDepth": 3,
  "maxChildrenPerWorker": 4,
  "maxTotalWorkers": 32,
  "maxNestedConcurrent": 8,
  "profiles": {
    "fast": {
      "model": "your-provider/fast-tool-model"
    },
    "implement": {
      "model": "your-provider/coding-model",
      "fallback": "your-provider/second-coding-model"
    },
    "vision": {
      "model": "your-provider/vision-model"
    },
    "research": {
      "model": "your-provider/research-model",
      "web": true
    }
  }
}
```

Global concurrency defaults to `1` to avoid edit races. `maxConcurrentPerProvider` separately prevents one provider from being flooded. Raise either only for independent work. State is atomically persisted in `.pi/agent-workflow-runs/state.json`; interrupted queued/running jobs are eligible for recovery on the next process launch.

### User-defined profiles

Add specialized profiles without changing the extension. A profile’s `triggers` participate in automatic routing; the parent still calls only `delegate_work` and does not choose a model or role explicitly.

```json
{
  "profiles": {
    "proof": {
      "label": "Proof worker",
      "model": "your-provider/reasoning-model",
      "thinking": "high",
      "description": "Check mathematical proofs, derive results, and find counterexamples.",
      "instructions": "State assumptions explicitly and distinguish proof from conjecture.",
      "triggers": ["proof", "prove", "theorem", "counterexample"],
      "priority": 10
    },
    "ml_experiment": {
      "label": "ML experiment worker",
      "model": "your-provider/long-context-model",
      "description": "Plan reproducible ML experiments and analyze ablations and metrics.",
      "triggers": ["ablation", "experiment", "reproducibility", "training run"]
    }
  }
}
```

Custom profiles win when their trigger phrases match. Otherwise, the built-in deterministic router selects the closest category and records the reason in the job artifacts.

OMP-style Markdown agents are also discovered from project `.pi/agents/*.md` and `.omp/agents/*.md`, then user `~/.pi/agent/agents/*.md` and `~/.omp/agent/agents/*.md`. Supported YAML frontmatter includes `name`, `description`, `model` (string or fallback array), `thinking`, `tools`, `spawns`, `blocking`, `autoloadSkills`, `extensions`, `triggers`, `priority`, `web`, and structured `output` schemas. Project definitions take precedence.

Set `"web": true` on a profile to load `pi-web-access` in that worker and enable `web_search`, `fetch_content`, and `get_search_content`. The built-in `research` profile enables web access by default and retains `read`/`bash` for local evidence audits. Other profiles remain local-only.

## Safety and reliability

- Child processes disable ambient extension discovery, prompt templates, and context files. Declared `autoloadSkills` are resolved and injected into the worker prompt; declared extension paths are loaded explicitly.
- Local workers are limited to `read`, `bash`, `edit`, and `write`. Web-enabled profiles explicitly load only `pi-web-access` and add its three research tools.
- A cancellable scheduler handles queueing, global/per-provider limits, targeted cancellation, and event-driven waiting.
- Timeouts, empty output, non-zero exits, blocked structured yields, missing evidence, and failed retries are surfaced as failures.
- Compact output is bounded by characters, bytes, and lines before it re-enters parent context; the full worker report plus bounded diagnostic JSONL/stderr stay in artifacts.
- State is written atomically and active in-process jobs survive extension reloads through a process-global scheduler.
- `isolated: true` requires a clean Git tree, runs in a detached temporary worktree, checks a binary patch, and applies it without committing the main branch. Overlapping main-tree changes fail closed and preserve the patch; disjoint isolated patches can merge in completion order.
- Fallbacks are used only after a failed attempt and are recorded in route details.
- The parent is explicitly told that worker output is evidence rather than authority.
- The extension never commits, pushes, deletes branches, or changes credentials on behalf of a worker.

No agent framework can make arbitrary shell commands safe. Review the task scope and use repository-level permissions appropriate to your environment.

## Benchmarks

Run deterministic routing checks:

```bash
npm run benchmark:static
```

Run the full local suite:

```bash
npm run check
```

The checked-in benchmark deliberately separates **mechanical correctness** from **model quality**. It does not fabricate live model scores, because provider latency, quotas, model snapshots, and repositories change. Live benchmark results belong in `benchmarks/live/` and must include the exact model refs, Pi version, commit, task fixture, timestamps, and raw artifacts.

### Competition review

The design was compared against the public feature sets of:

- [`@tintinweb/pi-subagents`](https://github.com/tintinweb/pi-subagents): excellent Claude-Code-style subagent UX and custom agents, but model routing and delegation policy are user-configured.
- [`MasuRii/pi-agent-router`](https://github.com/MasuRii/pi-agent-router): strong tracked task delegation, retries, chain/parallel execution, and runtime controls, but requires more agent/profile configuration.
- [`UnicornGlade/pi-analyst-worker-orchestrator`](https://github.com/UnicornGlade/pi-analyst-worker-orchestrator): closest analyst/worker philosophy, but its current package imports the older `@mariozechner` Pi package names and has only one worker role.
- [`Tiziano-AI/pi-multiagent`](https://github.com/Tiziano-AI/pi-multiagent): strong authority boundaries and graph workflows, but intentionally more explicit and workflow-heavy.
- [`@kdejaeger/pi-model-router`](https://github.com/kdejaeger/pi-model-router): good per-turn model tier routing, but not a delegation runtime.

The goal here is not to claim universal superiority. It is to combine the lowest-context parts that matter for this workflow: native tool invocation, automatic roles, robust task lifecycle, visual routing, clean child processes, bounded evidence, and failure visibility.

The scheduler lifecycle and worktree-isolation design are adapted from the MIT-licensed [oh-my-pi](https://github.com/can1357/oh-my-pi) task system. This package uses a Pi-native child executor rather than importing OMP's runtime. See `NOTICE` for attribution.

## Limitations

- Routing is deterministic keyword policy, not a learned benchmark-validated classifier.
- The parent still decides whether delegation is worthwhile.
- Worker quality depends on the provider and model snapshot.
- Recursive spawning and worker IRC use a bounded local IPC bridge plus a durable in-process mailbox. Direct messages wake idle workers and revive parked sessions; broadcasts target live peers. Parent cancellation propagates through the entire child tree, including children active during soft-budget aborts.
- Resource-style addresses are available through `workflow_resource`: `agent://<id>/result`, `agent://<id>/history`, `agent://<id>/status`, and `history://<id>`.
- Profiles listing MCP/LSP tools inherit the parent tool extension path when Pi exposes it, or can declare explicit `extensions` paths. Pi has no generic API for invoking arbitrary parent tools, so calls execute inside the worker rather than being relayed through the parent.
- Isolation snapshots dirty tracked and untracked files, merges with content-hash conflict checks, and clones nested Git repositories into the worker worktree. Clean trees still use checked Git worktrees.
- A worker may edit files; inspect the diff and run project tests before accepting its report.

## Development

```bash
npm install
npm run check
npm run benchmark:static
```

Pull requests should add tests for routing, failure handling, artifact boundaries, or UI state transitions. Do not add benchmark numbers without reproducible raw artifacts.