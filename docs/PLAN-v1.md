# Plan: ollama-plugin-cc v0.1.0 → v1.0.0

A step-by-step plan to take the shipped [v0.1.0](https://github.com/darrylmorley/ollama-plugin-cc/releases/tag/v0.1.0) baseline to a stable v1.0.0 marketplace launch.

The single biggest functional gap from v0.1 vs the upstream Codex plugin is `/ollama:rescue` — currently patch-emit only, vs Codex's agentic tool-calling loop. Phase 1 of this roadmap closes that gap; everything else is polish, hardening, and release engineering.

---

## Where v0.1.0 left us

**Working:**
- All 7 slash commands functional
- Schema-mode JSON output with one-shot retry on parse/validation failure
- Background job lifecycle (status, result, cancel)
- Stop-review-gate hook
- Cloud + local model parity
- Tool-calling capability matrix for current open-weight families
- 51+ unit tests green, smoke-tested live against `qwen3.5:9b` (local) and `glm-5.1:cloud`

**Known gaps from Codex parity (deferred to v1):**
- `/ollama:rescue` is patch-emit, not agentic — biggest gap
- No reasoning-effort tuning (no Ollama equivalent of Codex `--effort`)
- No cross-session thread resume
- No diff/file context discipline — model gets the diff but not the surrounding files
- Dead code warnings (4 unused vars in `ollama-companion.mjs`, 1 in `render.mjs`)
- No CI

---

## Phase 1 — Agentic rescue (the headline feature)

This is the marquee v1 feature. ~3–4 days. Splits into design + implementation.

### Step 1.1 — Define the tool surface
Decide which tools the rescue agent can call. Recommended minimal set:
- `read_file(path)` → returns file contents
- `list_directory(path)` → returns directory listing
- `apply_patch(patch)` → applies a unified diff to the working tree
- `run_command(cmd, args[])` → runs a shell command (with allowlist or user approval)
- `done(summary)` → signals end of agent loop

Open question: should `run_command` require user approval per-call, run with an allowlist (`git`, `npm`, `bun`, `cargo`, etc.), or run unrestricted? Recommendation: allowlist by default, configurable via `OLLAMA_PLUGIN_RESCUE_ALLOW_COMMANDS=*` for power users.

### Step 1.2 — Write the tool-calling loop
In `plugins/ollama/scripts/lib/ollama.mjs`, add:
- `runAgenticTask({ model, messages, tools, onProgress, signal, maxIterations })`
- Loop: call `chat()` with `tools` array → if response has `tool_calls`, execute each → append tool results as messages → continue. Exit when model returns no tool calls or `done`. Hard cap at `maxIterations` (default 20) to prevent runaway loops.

### Step 1.3 — Wire into `/ollama:rescue`
- Default `/ollama:rescue` to agentic mode
- Keep patch-emit as `--emit-patch` flag for fallback / models without tool-calling
- Auto-fallback to patch-emit if `modelSupportsToolCalling()` returns `false` and emit a warning
- Update `agents/ollama-rescue.md` to reflect the new behavior

### Step 1.4 — Persist tool-call log to job state
Each tool call (read, patch, command) goes in the job log. Background runs can be inspected via `/ollama:status <id>` to see what the agent did. Mirrors how Codex tracks turns.

### Step 1.5 — Tests
- Mock fixtures for tool-calling responses (extend `fake-ollama-server.mjs`)
- Test happy path, max-iterations cap, malformed tool-call recovery, command-not-allowed handling
- Live smoke test: rescue against the SQL injection fixture, verify it actually reads `app.js`, applies the parameterized-query patch, and the file content reflects it

### Step 1.6 — Docs
- README: update the `/ollama:rescue` description; remove the "patch-emit only" caveat
- `ollama-model-prompting` skill: add "agentic rescue support" column to the matrix
- CHANGELOG: bullet for "Agentic rescue with tool-calling"

**Bump to v0.5.0** — internal/personal use after this lands.

---

## Phase 2 — Diff context discipline

~1 day. Companion to Phase 1: the agent works better when it gets the right context up front.

### Step 2.1 — Inline file context in review prompts
Currently the review prompt contains the diff but not the full file. Pull in the changed files (or relevant sections) with line numbers so the model can reason about surroundings. Trim to a token budget per the model's context window.

### Step 2.2 — Token budgeting
Add a small token counter (rough char/4 estimate is fine; no tokenizer dep). Per-model context limits in a small config map. If diff + context exceeds budget, truncate context first, then diff, then warn.

### Step 2.3 — Better rescue prompt template
Rescue prompt should explicitly instruct: "Use `read_file` to load the relevant files before proposing changes." Stops the qwen3.5:9b "hallucinate Python for JS code" failure mode we saw in v0.1 smoke testing.

---

## Phase 3 — Hardening & polish

~2 days. Items that don't change behavior but make v1.0 a real release.

### Step 3.1 — CI (GitHub Actions)
- Workflow: on pull_request and push to main, run `node --test tests/*.test.mjs`
- Matrix on Node 18.18, 20, 22
- Status badge in README

### Step 3.2 — Dead code cleanup
Remove (or wire up):
- `buildPersistentTaskThreadName` import
- `validateNativeReviewRequest` function
- Unused `cwd` parameters in two places
- Unused `meta` in `render.mjs`

If anything looks intentionally-unused-as-future-API, leave a comment explaining; otherwise delete.

### Step 3.3 — Better unreachable-Ollama UX
Currently a generic error message. Detect common failure modes:
- Connection refused → "`ollama serve` not running"
- DNS failure → "Check `OLLAMA_HOST` value"
- Model not pulled → "Run `ollama pull <model>` first"

One-line actionable message per case.

### Step 3.4 — Streaming progress in `/ollama:status`
Today shows "starting" / "running". Update tracked-jobs to record token count or last log line; surface in status table.

### Step 3.5 — Cache identical-diff reviews
Hash `(model, prompt, diff)` → cache JSON result for 24h in `.ollama/cache/`. Cheap win for repeated `/ollama:review` runs on the same code.

### Step 3.6 — Lock down public API surface
Document what's public vs internal:
- CLI flags on `ollama-companion.mjs` (locked)
- Job state JSON shape (locked, versioned)
- Hook contract (locked)
- Internal lib functions (private, may break)

Add to `docs/API.md`. Sets up semver discipline for v1.x.

---

## Phase 4 — Battle test

~1 day. Empirical evidence backing the README's claims.

### Step 4.1 — Run smoke test against ≥4 models
Use [docs/SMOKE-TEST.md](SMOKE-TEST.md) as the script. Models to cover:
- `qwen3.5:9b` — small local baseline
- `qwen3.6:27b-coding-nvfp4` — strong local code model
- `gpt-oss:20b` — local frontier-ish
- `glm-5.1:cloud` — strong cloud model

For each: review, adversarial-review, rescue (agentic). Record verdict quality, JSON adherence, retry rate, tool-call success rate.

### Step 4.2 — Update README recommendation table
Replace the current "guessed" table with a results-backed one: "tested on X, verdict quality Y/10, tool-calling success Z%."

### Step 4.3 — Document model-specific gotchas
A short troubleshooting section: "If you see X, try model Y." Lives in the README or a new `docs/MODELS.md`.

---

## Phase 5 — Release engineering

~½ day.

### Step 5.1 — Marketplace publication
Investigate Claude Code marketplace process. Either:
- Submit to a community marketplace (research which one)
- Document manual install: users add `marketplace.json` URL to their settings

Update README install step from placeholder to actual command.

### Step 5.2 — Tag v1.0.0
- Bump `package.json` version → `1.0.0`
- Update `CHANGELOG.md` with cumulative changes since v0.1.0
- `git tag -a v1.0.0` with a real release note
- `gh release create` with a write-up of the journey from v0.1.0

### Step 5.3 — Announce
Optional but worth doing: short blog post or Twitter/Mastodon thread linking the GitHub repo and a quick demo gif. The audience is Claude Code users who want privacy-preserving review/rescue.

---

## Risk register

| Risk | Likelihood | Mitigation |
|---|---|---|
| Tool-calling unreliable on smaller models | High | Auto-fallback to patch-emit; document supported models clearly |
| `apply_patch` corrupts files on edge cases (CRLF, encoding) | Medium | Use `git apply` under the hood; refuse on conflict |
| `run_command` is a foot-gun | High | Allowlist by default; explicit opt-in for unrestricted |
| Agent loops indefinitely | Medium | Hard `maxIterations` cap; surface in status as "loop limit reached" |
| Token budget guesses are wrong → context overflow | Medium | Conservative limits; warn on truncation |
| Marketplace process changes | Low | Document manual install as fallback |

---

## Effort estimate

| Phase | Effort |
|---|---|
| 1 — Agentic rescue | 3–4 days |
| 2 — Diff context | 1 day |
| 3 — Hardening & polish | 2 days |
| 4 — Battle test | 1 day |
| 5 — Release engineering | ½ day |

**Total: ~7–9 focused days.**

Suggested cadence:
- **v0.5.0** at end of Phase 1 — internal/personal use
- **v0.9.0** at end of Phase 3 — feature-complete RC
- **v1.0.0** at end of Phase 5 — marketplace launch

---

## Out of scope for v1

Tracked here so they don't sneak into v1 by accident:

- Multi-model routing (use cheap model for gate, strong model for adversarial)
- Reasoning-effort tuning (`--effort`) — no clean Ollama mapping
- Cross-session thread resume — would need a server-side store; significant complexity
- Remote Ollama hosts over Tailscale/SSH — works today via `OLLAMA_HOST`; no plugin work needed
- Custom skills/tools per repo — interesting but a bigger design problem

Revisit these for v1.x or v2.
