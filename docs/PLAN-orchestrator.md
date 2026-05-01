# Plan: ollama-plugin-cc orchestrator (v1.x)

A spec for the **plan → execute → review** pipeline that turns Claude Code into
an orchestrator handing mechanical work to Ollama agents while staying in
charge of judgment-heavy gates.

> Status: design draft. Targets v1.1+ after the v1.0 marketplace launch.
>
> Builds on the agentic primitives shipped in v0.5–v0.10.

---

## Goal

Let Claude Code delegate substantial coding work to a chain of Ollama agents
— planner, implementer, verifier — so that:

- Claude only spends tokens on the **gates that need its judgment** (approve a
  plan, accept a final diff).
- The **mechanical loops** (implement → verify → retry) run entirely outside
  Claude's context.
- Claude can intervene at any time, but doesn't have to.

Token economy estimate (typical multi-file refactor):

| Approach | Claude tokens |
|---|---|
| Claude does it directly | 80k–200k |
| With this pipeline (happy path) | 5k–20k |
| With this pipeline (one reject loop) | 15k–40k |

A 5–10× reduction is realistic for tasks in the sweet spot — refactors,
migrations, error-handling sweeps, test generation, audit-and-fix work.

## Non-goals

- **Replacing Claude's judgment**. Claude still approves the plan and reviews
  the final diff. The pipeline is a delegation tool, not an autonomous agent.
- **Multi-agent debate / critic loops**. Out of scope for v1.x.
- **Cross-repo orchestration**. One repo per pipeline run.
- **Replacing `/ollama:rescue` or `/ollama:review`**. Those remain as standalone
  commands; the orchestrator is a layer on top, not a replacement.

---

## The three primitives

### `/ollama:plan`

Evidence-grounded planning. The planner uses the existing agentic loop
(`read_file`, `list_directory`) to ground itself in the actual codebase
before emitting a plan.

```
/ollama:plan "audit and fix error handling in lib/" \
  [--model <name>] \
  [--scope <files-or-glob>] \
  [--background]
```

Returns a **plan-id** and the plan content (rendered as markdown for Claude
to read).

**Plan schema** (persisted under `.ollama/plans/<id>.json`):

```jsonc
{
  "id": "pln_abc123",
  "task": "audit and fix error handling in lib/",
  "createdAt": "ISO-8601",
  "model": "qwen3-coder-next:cloud",
  "confidence": 0.85,
  "scope": ["lib/**/*.js"],
  "rationale": "string — why this plan, what was inspected",
  "steps": [
    {
      "id": 1,
      "description": "Wrap all DB calls in lib/db/*.js with try/catch",
      "files": ["lib/db/users.js:42-87", "lib/db/orders.js:12-55"],
      "successCriteria": [
        "Every db.query call has surrounding try/catch",
        "Errors are logged via existing logger.error",
        "Tests in test/db/*.test.js still pass"
      ],
      "dependencies": []
    },
    {
      "id": 2,
      "description": "...",
      "dependencies": [1]
    }
  ],
  "status": "draft" | "approved" | "rejected" | "executing" | "complete",
  "approvedAt": "ISO-8601 | null",
  "executionLog": []
}
```

**Confidence score**: `0.0–1.0`. Low confidence (< 0.6) signals to Claude
that the planner is unsure — Claude should scrutinise hard or refine.

### `/ollama:replan`

Refine an existing plan based on Claude's feedback.

```
/ollama:replan pln_abc123 "scope it to only the async handlers" \
  [--model <name>]
```

Mutates the plan in place, bumps a `revision` counter, and returns the new
plan content. Original plan is preserved as `revisions: [...]` for audit.

### `/ollama:execute-plan`

Drives the implement → verify → retry loop autonomously per the plan. The
inner loop runs entirely outside Claude's context.

```
/ollama:execute-plan pln_abc123 \
  [--implementer <model>] \
  [--verifier <model>] \
  [--max-retries-per-step <N>] (default 3) \
  [--step <N>] (run a single step, then return) \
  [--resume-from <N>] (skip steps 1..N-1) \
  [--dry-run] (plan-only; emit what it WOULD do without editing) \
  [--background] (always available)
```

**Internal loop per step:**

```
for step in plan.steps:
    if --step N specified and step.id != N: skip
    if step has unmet dependencies: error, abort
    if step.id < --resume-from: skip

    attempts = 0
    while attempts < max-retries:
        attempts += 1
        diff = implementer.run(plan, step)
        verdict = verifier.run(plan, step, diff)
        if verdict.passed:
            commit step status = "complete"
            break
        else:
            implementer.feedback = verdict.reasoning
            (loop)

    if not verdict.passed:
        plan.status = "stuck"
        return early with the stuck step + verifier's last reasoning
```

**Streams progress** to `/ollama:status` via the existing `lastMessage`
infrastructure: `"step 2/4: implementing"`, `"step 2/4: verify failed,
retry 1/3"`, `"step 2/4: complete"`.

**Returns** to Claude:
- The cumulative diff
- Per-step status (complete / failed-after-N-retries / skipped)
- Verifier's notes per step
- Total token usage (Ollama-side, for accounting)

---

## Per-role model defaults

| Env var | Role | Default |
|---|---|---|
| `OLLAMA_PLUGIN_PLANNER_MODEL` | Planner | `OLLAMA_PLUGIN_DEFAULT_MODEL` |
| `OLLAMA_PLUGIN_IMPLEMENTER_MODEL` | Implementer | `OLLAMA_PLUGIN_DEFAULT_MODEL` |
| `OLLAMA_PLUGIN_VERIFIER_MODEL` | Verifier | `OLLAMA_PLUGIN_PLANNER_MODEL` (verifier needs similar reasoning to planner) |

Set per-shell or in `~/.zshrc`:

```bash
export OLLAMA_PLUGIN_PLANNER_MODEL=qwen3-coder-next:cloud
export OLLAMA_PLUGIN_IMPLEMENTER_MODEL=gpt-oss:20b
export OLLAMA_PLUGIN_VERIFIER_MODEL=glm-5.1:cloud
```

CLI flags (`--implementer`, `--verifier`, `--model` for planner) override env.

Recommended starting matrix (from v0.10 battle-test data):

| Role | First choice | Why |
|---|---|---|
| Planner | `qwen3-coder-next:cloud` | Fastest reliable structured output. |
| Implementer | `gpt-oss:20b` (local) or `glm-5.1:cloud` | Strong agentic loop performance. |
| Verifier | `glm-5.1:cloud` | Reliable JSON output, good adversarial reasoning. |

---

## Pipeline as Claude sees it

```
User: "audit and fix error handling in lib/"

1. Claude → /ollama:plan "..."
   ↳ planner reads lib/* via agentic loop, returns:
     plan-id pln_abc, 4 steps, confidence 0.85

2. Claude reviews plan content.
   - High confidence + matches intent → approve
   - Low confidence or wrong scope → /ollama:replan pln_abc "..."

3. Claude → /ollama:execute-plan pln_abc --background

4. Pipeline runs autonomously:
   step 1: implement → verify ✓
   step 2: implement → verify ✗ (missing edge case)
                     → implement (retry) → verify ✓
   step 3: implement → verify ✓
   step 4: implement → verify ✓
   ↳ streams to /ollama:status

5. Claude polls /ollama:status, then /ollama:result pln_abc.
   Reviews cumulative diff itself.

6. Claude verdict:
   - Looks good → done
   - Issue found → /ollama:replan + /ollama:execute-plan --resume-from N
```

Claude only enters at:
- Plan approval (gate 1)
- Final review (gate 2)
- Optional re-plan if issue found (gate 3)

The implement↔verify retry loop never crosses Claude's context.

---

## Edge cases & failure modes

### Planner emits an unworkable plan

Verifier rejects step 1 repeatedly → `execute-plan` returns `stuck` after
max retries. Claude sees the verifier's reasoning, can `/ollama:replan` with
the verifier's feedback as input.

### Verifier always passes / always fails

Single-source-of-truth problem. Mitigations:
- Verifier model differs from implementer model (different blind spots).
- `--strict` flag adds adversarial-style prompt to the verifier (defaults off).
- Claude's final review gate catches verifier blind spots.

### Implementer goes off-script

The implementer sees the plan + the specific step + the success criteria. If
it makes unrelated changes, the verifier should catch them. If verifier
misses, Claude's final review catches.

### Plan and code drift mid-execution (someone else commits)

`execute-plan` is non-atomic. If the working tree changes underneath it
(another tool, another agent), behaviour is undefined. v1.x guidance:
*don't*. Lock external work during pipeline execution.

### Token / time blowout

Each call to a cloud model has cost. Mitigations:
- `--max-retries-per-step` cap (default 3) prevents runaway loops.
- `--background` + `/ollama:cancel` lets Claude or user stop a runaway pipeline.
- Plan emits a token-budget estimate; Claude can decline to execute.

### Tool-calling-deny-listed model assigned as implementer

Auto-falls back to patch-emit (existing behavior). Verifier still works on
the resulting diff. Documented in MODELS.md.

---

## Implementation phases

### Phase 6.1 — Plan state + schema (~½ day)

- New `plugins/ollama/scripts/lib/plans.mjs`: read/write/list/delete plans
  under `.ollama/plans/<id>.json`.
- Schema validation against `schemas/plan.schema.json` (new file).
- Tests for the state module.

### Phase 6.2 — `/ollama:plan` command (~1 day)

- New slash command `plan` in `plugins/ollama/commands/`.
- Companion subcommand: `node ollama-companion.mjs plan "..."`.
- Reuses `runAgenticTask` for evidence-grounded planning. The agentic loop
  has access to `read_file`, `list_directory`, but **not** `write_file` or
  `apply_patch` (planner is read-only).
- Output schema enforced via Ollama's structured-output mode.
- Renderer for plan markdown (uses `lib/render.mjs`).
- Tests: schema validation, persistence, smoke-test planner against fixture.

### Phase 6.3 — `/ollama:replan` command (~½ day)

- Subcommand `replan <id> "feedback"`.
- Loads existing plan, builds a refine-prompt that includes the original
  plan + Claude's feedback, runs the planner again, persists revision.
- Tests for revision tracking.

### Phase 6.4 — `/ollama:execute-plan` command (~1.5 days)

- Subcommand `execute-plan <id> [flags]`.
- Internal loop driver in `lib/pipeline.mjs`:
  - Per-step implement (reuses agentic rescue infrastructure).
  - Per-step verify (new — reuses review JSON infra with plan/step context).
  - Retry loop with attempt counter.
  - Progress streamed via existing `tracked-jobs` `lastMessage` field.
- Per-role model resolution.
- `--step`, `--resume-from`, `--dry-run` flags.
- Tests: happy path, verify-rejects-then-passes, max-retries-stuck,
  skip-completed-steps, dry-run.

### Phase 6.5 — Verifier prompt template (~½ day)

- New prompt template `verify.md` in `plugins/ollama/prompts/`.
- Schema includes per-step pass/fail with reasoning.
- Tested empirically against the SQL injection fixture: implementer makes
  the fix, verifier confirms; intentionally introduce a bug, verifier
  catches it.

### Phase 6.6 — Battle-test the pipeline (~½ day)

- Extend `scripts/battle-test.mjs` with `--pipeline` mode that runs a full
  plan → execute → re-plan loop against the fixture.
- Test matrix: at least 3 model combinations (planner/implementer/verifier).
- Update `docs/MODELS.md` with pipeline results.

### Phase 6.7 — Docs (~½ day)

- New `docs/ORCHESTRATOR.md`: end-user guide for the pipeline.
- Update `docs/API.md`: new public commands and env vars.
- Update README: orchestrator section.
- Update CHANGELOG with the v1.1 entry.

**Total: ~5 days of focused work.** Realistic over a week with iteration.

---

## Public surface added

Public per `docs/API.md` semver policy:

| Item | Type | Notes |
|---|---|---|
| `/ollama:plan` | Slash command | New |
| `/ollama:replan` | Slash command | New |
| `/ollama:execute-plan` | Slash command | New |
| `companion plan/replan/execute-plan` | CLI subcommands | New |
| `OLLAMA_PLUGIN_PLANNER_MODEL` | Env var | New |
| `OLLAMA_PLUGIN_IMPLEMENTER_MODEL` | Env var | New |
| `OLLAMA_PLUGIN_VERIFIER_MODEL` | Env var | New |
| Plan JSON shape | Persisted state | New, additive only after v1.1.0 |

Existing public surface unchanged.

---

## Risk register

| Risk | Likelihood | Mitigation |
|---|---|---|
| Planner produces plausible-but-wrong plans | Medium | Confidence score; Claude approval gate; planner's evidence-grounded approach reduces this |
| Verifier blind spots align with implementer blind spots | Medium | Different models for each role; Claude's final review gate; optional `--strict` mode |
| Pipeline runs amok consuming cloud tokens | Low | `--max-retries-per-step` cap; `/ollama:cancel`; pre-execution token estimate |
| Plan execution leaves working tree in an inconsistent state | Medium | Per-step is atomic via existing `apply_patch`; on `stuck`, Claude inherits a partial state and can choose to revert |
| Models drift on the verifier schema | Low | Same retry-on-parse-fail infra as `/ollama:review` |
| Per-role env vars confuse users | Low | Clear docs; sensible defaults inheriting from `OLLAMA_PLUGIN_DEFAULT_MODEL` |

---

## Open design questions

1. **Should plans be revisable post-approval?** I.e., can Claude `/ollama:replan` an already-`approved` plan, or must it be `draft` again? **Decision needed.**
2. **What happens to a plan when execution is `stuck`?** Auto-mark as `failed`, or stay `executing` for resume? **Lean: stay `executing`, let user decide.**
3. **Should `execute-plan --dry-run` actually invoke the implementer with no `write_file`/`apply_patch` available, or just emit what it WOULD do based on the plan?** **Lean: invoke implementer in read-only mode** so we get realistic dry-run output.
4. **Do we surface the implementer's per-iteration tool calls in the execute-plan log, or just the final per-step diff?** **Lean: per-step diff only**, with full tool-call log available via `/ollama:result <plan-id> --verbose`.
5. **Should there be a `/ollama:swarm` parallel-fanout primitive?** Out of scope for the orchestrator pipeline (which is sequential). Defer to a future v1.x.

---

## Why this design vs alternatives

### vs. "Claude approves every step"

Original sketch had Claude in the loop at every implement→verify. This pays
4N round-trips per task. Moving the inner loop into `execute-plan` cuts
this to 2 round-trips (approve, review-final), keeping Claude's high-leverage
gates while delegating the mechanical work. Token savings 5–10×.

### vs. "Single autonomous agent"

A `/ollama:auto "do the thing"` command that internally plans + implements
+ verifies + recovers would be more impressive but loses the explicit gate
where Claude can refine the plan. The plan-approval gate is **the cheapest
and highest-leverage** intervention point — getting the plan right means
the rest is mechanics. Skipping it is penny-wise pound-foolish.

### vs. "Claude plans, Ollama implements"

Claude could be the planner. But:
- Claude doing planning costs Claude tokens that the cloud planner doesn't.
- Cloud planners (`qwen3-coder-next:cloud`, `kimi-k2.6:cloud`) are
  competitive with Claude on this kind of structured work.
- Claude's value is *judgment of the plan*, not *generation of the plan* —
  it's faster and cheaper to review than to author.

The cloud planner pulls work that doesn't need Claude-quality reasoning out
of Claude's context.

---

## Out of scope for v1.1

- Parallel fanout (multiple implementers on independent steps simultaneously)
- Critic loops (two implementers debate)
- Cross-repo planning
- Long-term plan memory (a plan persists across Claude sessions)
- Web-search-augmented planner
- Cost-aware routing (auto-pick cheaper model when task is simple)

These belong to v1.2+ once we have usage signal from v1.1.
