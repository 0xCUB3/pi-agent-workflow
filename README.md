# pi-agent-workflow

One orchestrator. Automatically routed workers. Evidence before confidence.

`pi-agent-workflow` is a single Pi extension for developers and researchers who want a strong model to coordinate inexpensive, specialized workers without manually choosing a model for every task.

## Philosophy

- **The parent decides.** The active Pi session remains the analyst and final authority.
- **Workers are bounded.** A worker gets one bounded task, a narrow prompt, and built-in tools. It cannot recursively delegate, but it can be steered while running.
- **Model choice is policy, not ceremony.** Routing is automatic and inspectable; users do not need to select a model per task.
- **Evidence beats confidence.** A worker must report changes and validation. The parent must inspect the actual repository state before claiming success.
- **Visual work is different.** Images go to a vision-capable worker first. A text-only analyst receives the resulting visual report, not a pretend visual interpretation.
- **Failures are data.** Timeouts, empty responses, failed commands, and fallback attempts remain visible.
- **Cost is a first-class constraint.** Cheap models handle exploration and mechanical work; stronger models are reserved for work that benefits from them.
- **Small surface area.** One extension, one tool, a few commands, and a small configurable routing table.

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

The parent model sees two workflow tools:

```text
delegate_work({ task: "...", async: true })  # optional background mode
```

The extension classifies the bounded task, chooses a worker profile, launches a clean RPC child Pi process, tracks streamed activity in a Claude-Code-style widget, supports steering and follow-ups while it runs, retries with a fallback when appropriate, and returns a compact evidence report to the parent.

```text
user request
    │
    ▼
parent Pi session (analyst/orchestrator)
    │  decides whether independent work is worthwhile
    ▼
delegate_work
    │  deterministic, inspectable routing
    ▼
clean RPC child Pi process ◄── steering / follow-up
    │  live tool activity + tagged worker messages
    ▼
report + artifacts ──► parent inspects evidence and decides what happens next
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

For asynchronous jobs, the parent can call `workflow_message({ jobId, message, mode })` or use the `/workflow steer` and `/workflow followup` commands. Workers can surface live progress with `WORKFLOW_UPDATE:` and ask the parent with `WORKFLOW_ASK:`; a worker can relay to a peer with `WORKFLOW_TO: <job-id>: <message>`. These are bounded message channels, not unrestricted agent chatter.

The UI intentionally follows the Claude Code-style `pi-subagents` pattern:

- An animated, themed **Agents** widget above the editor with spinners, colored status icons, task summaries, model, attempts, elapsed time, tool count, and live worker narration (`⎿ reading…`, `⎿ editing…`).
- A navigable **fleet list** below the editor. At an empty prompt, press `↓` or `←`; use `↑`/`↓` to select a worker, `Enter` to open its live result viewer, and `Esc` to return.
- Finished workers linger briefly so completion and errors are readable. The viewer updates while a worker is running.

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
  "maxConcurrent": 1,
  "timeoutMs": 1800000,
  "maxRetries": 1,
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
    }
  }
}
```

Concurrency defaults to `1` to avoid edit races; raise it to `2` or more only when tasks are independent.

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

## Safety and reliability

- Child processes load no extensions, skills, prompt templates, or context files, preventing recursive delegation and ambient extension side effects.
- Child tools are limited to `read`, `bash`, `edit`, and `write`.
- Timeouts, cancellation, empty output, non-zero exit status, and failed retries are surfaced as failures.
- Output is bounded before it re-enters the parent context.
- Fallbacks are used only after a failed attempt and are recorded in the route details.
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

The goal here is not to claim universal superiority. It is to combine the lowest-complexity parts that matter for this workflow: native tool invocation, automatic roles, visual routing, clean child processes, bounded evidence, and failure visibility.

## Limitations

- Routing is deterministic keyword policy, not a learned benchmark-validated classifier.
- The parent still decides whether delegation is worthwhile.
- Worker quality depends on the provider and model snapshot.
- Child processes inherit Pi's model registry/auth configuration but not parent extensions or skills.
- A worker may edit files; inspect the diff and run project tests before accepting its report.

## Development

```bash
npm install
npm run check
npm run benchmark:static
```

Pull requests should add tests for routing, failure handling, artifact boundaries, or UI state transitions. Do not add benchmark numbers without reproducible raw artifacts.