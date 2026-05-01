# Orchestrator pipeline

Claude Code as orchestrator, Ollama agents as specialists. Plan → execute-plan → review, with Claude at the gates.

This document is the user guide. For the design rationale see [PLAN-orchestrator.md](PLAN-orchestrator.md).

## TL;DR

```
/ollama:plan "audit and fix error handling in lib/"      # plan-id pln_xxx returned
# Claude reviews. Looks good.
/ollama:execute-plan pln_xxx                             # autonomous execution
# Claude reviews the resulting diff.
```

Three Ollama agents do the work; Claude only spends tokens on plan-approval and final-review. Typical 5-10× reduction in Claude token consumption for tasks in the sweet spot (refactors, migrations, audit-and-fix).

## Three commands

### `/ollama:plan "<task>"`

Evidence-grounded planning. The planner uses a **read-only** agentic loop (`read_file`, `list_directory`) to ground itself in the actual codebase before emitting a structured plan. Returns a plan-id and renders the plan as markdown for you to review.

```
/ollama:plan "audit error handling in lib/"
/ollama:plan "migrate routes from express to hono"
/ollama:plan --model qwen3-coder-next:cloud "add input validation to all POST handlers"
```

The plan includes:
- **Task** — verbatim from your request
- **Rationale** — what the planner inspected to ground itself
- **Confidence** — 0.0–1.0 self-assessment; below 0.6 means scrutinise hard
- **Steps** — each with `description`, `files` (with line ranges), `successCriteria`, optional `dependencies`

### `/ollama:replan <plan-id> "<feedback>"`

Refine a draft plan without losing prior context.

```
/ollama:replan pln_abc "tighten scope to just async handlers; skip deprecated paths"
```

The new revision replaces the steps; prior versions are archived in `revisions[]`.

### `/ollama:execute-plan <plan-id>`

Autonomous implement → verify → retry loop. Runs entirely outside Claude's context.

```
/ollama:execute-plan pln_abc
/ollama:execute-plan pln_abc --implementer gemma4:26b --verifier glm-5.1:cloud
/ollama:execute-plan pln_abc --max-retries 5
/ollama:execute-plan pln_abc --step 2          # one step then return
/ollama:execute-plan pln_abc --resume-from 3   # skip steps 1–2
/ollama:execute-plan pln_abc --dry-run         # plan-only, no edits
```

Behaviour per step:

1. Implementer makes the change using the existing agentic toolset (`read_file`, `write_file`, `apply_patch`, `run_command`, `done`).
2. Diff is captured.
3. Verifier reads the diff + the current state of in-scope files and checks every `successCriteria` against either the diff or the current state. (A criterion already satisfied by prior steps counts as met.)
4. On pass: changes are committed to git as `[ollama-plan <id>] step N: <description>`, plan state advances, next step.
5. On fail: working tree is rolled back to HEAD, implementer is given the verifier's reasoning, retry. Capped at `--max-retries` (default 3).
6. If a step can't pass after max retries, the plan is marked `stuck` and execution returns to Claude with the verifier's notes.

## Per-role model defaults

| Env var | Default fallback |
|---|---|
| `OLLAMA_PLUGIN_PLANNER_MODEL` | `OLLAMA_PLUGIN_DEFAULT_MODEL` |
| `OLLAMA_PLUGIN_IMPLEMENTER_MODEL` | `OLLAMA_PLUGIN_DEFAULT_MODEL` |
| `OLLAMA_PLUGIN_VERIFIER_MODEL` | `OLLAMA_PLUGIN_PLANNER_MODEL` then default |

Set per-shell or in `~/.zshrc`:

```bash
export OLLAMA_PLUGIN_PLANNER_MODEL=qwen3-coder-next:cloud
export OLLAMA_PLUGIN_IMPLEMENTER_MODEL=gpt-oss:20b
export OLLAMA_PLUGIN_VERIFIER_MODEL=glm-5.1:cloud
```

CLI flags (`--model` for planner, `--implementer`, `--verifier` for execute-plan) override env.

### Recommended starting matrix

Based on [v0.10 battle-test results](MODELS.md):

| Role | First choice |
|---|---|
| Planner | `qwen3-coder-next:cloud` (fastest cloud) or `glm-5.1:cloud` |
| Implementer | `gpt-oss:20b` (local, fast) or `gemma4:26b` (local, resilient) |
| Verifier | `glm-5.1:cloud` (clean structured output) |

## Plan lifecycle

| Status | Meaning |
|---|---|
| `draft` | Newly planned or replanned. Not yet executed. |
| `executing` | `execute-plan` is running. |
| `complete` | All steps verified. |
| `stuck` | A step failed after max retries. Use `replan` then `execute-plan --resume-from N`. |
| `failed` | Same as stuck — terminal until replanned. |

State lives at `.ollama/plans/<id>.json` under the workspace root. Git commits per step give you a granular undo path.

## Worked example

```
$ /ollama:plan "fix the SQL injection in buggy.js by parameterizing queries"
# Plan pln_abc...
# 3 steps, confidence 0.95.

# Claude reads the plan. Looks good. Approves implicitly by executing:

$ /ollama:execute-plan pln_abc --implementer gemma4:26b --verifier glm-5.1:cloud
[step 1/3] starting: Fix SQL injection in findUser ...
[step 1/3] verify: Review complete.
[step 1/3] complete after 1 attempt
[step 2/3] starting: Fix SQL injection in deleteUser ...
[step 2/3] complete after 1 attempt
[step 3/3] starting: Verify no other patterns remain
[step 3/3] complete after 1 attempt (criteria met by current state)
Status: complete

# Per-step commits in git log:
# bf61932 [ollama-plan pln_abc] step 2: ...
# 11ee220 [ollama-plan pln_abc] step 1: ...
```

Total Claude tokens consumed: the plan markdown (~1k tokens) and the final report (~1k tokens). The implement→verify loop never crossed Claude's context.

## When to use the orchestrator vs `/ollama:rescue`

| Use this | When |
|---|---|
| `/ollama:rescue "..."` | Single bounded task. You know what you want fixed. ~5–30 minutes of work. |
| `/ollama:plan` + `/ollama:execute-plan` | Multi-step task. Several files. You want explicit verification at each step. ~1–8 hours of work. |
| Direct Claude work | The judgement load is the bottleneck (architecture, debugging, novel design). |

## Limitations & gotchas

### The pipeline refuses to run on a dirty tree

`execute-plan` uses git checkpoint commits per step. It refuses to start if `git status` shows uncommitted changes. Commit or stash first.

### Verification-only steps

A step like "verify no SQL injection patterns remain" with no edits to make will produce an empty diff. Recent versions of the verifier prompt handle this: a criterion satisfied by current state counts as met. Older models may not always grasp this — if you see a false-fail on a verification step, refine the plan to remove the redundant step (the per-step verifier already checks each criterion).

### Verifier blind spots

Verifier and implementer being the same model risks aligned blind spots. Prefer different models for the two roles. The default verifier falls back to the planner model if not set explicitly, which gives you a meaningful split when the implementer is local.

### Models known to drift on the planner schema

Per [MODELS.md](MODELS.md): `qwen3.6:27b-coding-nvfp4`, `batiai/qwen3.6-27b:q6` should not be used as the planner. Stick to `glm-5.1:cloud`, `qwen3-coder-next:cloud`, `gpt-oss:20b`, or `gemma4:26b`.

### Token / cost runaway

Each retry is another implementer + verifier round-trip. With cloud models this is a small dollar cost, but `--max-retries 10` could surprise you. Default 3 is conservative.

`/ollama:cancel <plan-id>` is not yet supported (it's a v1.2 item). For now: SIGINT the foreground execute-plan run.

## Reference

| Command | Purpose |
|---|---|
| `/ollama:plan "<task>"` | Create a plan |
| `/ollama:plans` | List all plans |
| `/ollama:plan-show <id>` | Show a plan |
| `/ollama:replan <id> "<feedback>"` | Refine a plan |
| `/ollama:plan-approve <id>` | Mark a plan approved (optional; execute-plan also approves) |
| `/ollama:execute-plan <id>` | Run the plan |
