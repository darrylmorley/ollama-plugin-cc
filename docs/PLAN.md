# Plan: Convert codex-plugin-cc → ollama-plugin-cc

A step-by-step plan to fork OpenAI's [codex-plugin-cc](https://github.com/openai/codex-plugin-cc) and convert it into a Claude Code plugin that delegates to a local Ollama server instead of the Codex CLI. Goal: like-for-like feature parity (review, adversarial-review, rescue, status/result/cancel, setup, optional stop-review gate, background jobs, hooks).

---

## Phase 0 — Prep & Scaffolding

### Step 0.1 — Clone the upstream repo as the starting point
- `git clone https://github.com/openai/codex-plugin-cc.git .` (into the empty `ollama-plugin-cc/` working dir)
- Remove the existing `.git/` and `git init` fresh, OR keep history and add upstream as a remote for future cherry-picks. **Recommendation: keep history** — easier to pull future upstream improvements.
- Add `upstream` remote: `git remote add upstream https://github.com/openai/codex-plugin-cc.git`.
- Create a working branch: `git checkout -b ollama-port`.

### Step 0.2 — Verify the upstream toolchain runs
- Install Node ≥ 18.18 (already required).
- `bun install` (or `npm install`) — only dev deps (`typescript`, `@types/node`).
- Run `node --test tests/*.test.mjs` to confirm the upstream test suite is green before touching anything. This becomes the regression baseline.
- Skip the `prebuild` script for now — it generates types from the Codex binary, which we won't have. We'll replace this in Phase 2.

### Step 0.3 — Decide on Ollama feature scope
Before writing code, lock down which Ollama capabilities we'll use. Recommended scope:
- **Chat completion**: `POST /api/chat` (streaming, multi-turn) — primary integration point.
- **Model listing**: `GET /api/tags` — for `/ollama:setup` and model validation.
- **Model pull**: `POST /api/pull` — for `/ollama:setup --pull <model>`.
- **Tool/function calling**: Ollama supports tool-calling for compatible models (Llama 3.1+, Qwen, etc.) — required if we want `rescue` to do agentic file edits.
- **Host config**: Default `http://localhost:11434`, override via `OLLAMA_HOST` env var.

Open question to resolve early: **how does `rescue` (write-capable agentic edits) work without a true app-server?** Options:
  - (a) Use Ollama's tool-calling to expose `read_file`, `write_file`, `apply_patch`, `run_bash` tools and run the agent loop in `ollama-companion.mjs` ourselves.
  - (b) Skip agentic rescue v1 — emit a patch/diff for Claude Code to apply.
  - **Recommendation: (a)** for parity, but ship (b) first as a stepping stone.

---

## Phase 1 — Rename & Rebrand (mechanical pass)

The goal here is to land a green build under the new name before touching backend logic.

### Step 1.1 — Filesystem renames
- `plugins/codex/` → `plugins/ollama/`
- `scripts/codex-companion.mjs` → `scripts/ollama-companion.mjs`
- `scripts/app-server-broker.mjs` → keep filename for now; mark as "to be deleted in Phase 2".
- `scripts/lib/codex.mjs` → `scripts/lib/ollama.mjs`
- `agents/codex-rescue.md` → `agents/ollama-rescue.md`
- `skills/codex-cli-runtime/` → `skills/ollama-cli-runtime/`
- `skills/codex-result-handling/` → `skills/ollama-result-handling/`
- `skills/gpt-5-4-prompting/` → **delete** (replace in Phase 4 with `skills/ollama-model-prompting/`).

### Step 1.2 — Manifest updates
- `package.json`: `name` → `@darrylmorley/ollama-plugin-cc`, version `0.1.0`, drop the `prebuild` script (no Codex binary to generate types from), update `repository`/`homepage`/`bugs` URLs.
- `.claude-plugin/marketplace.json`: change owner, plugin name, description, keywords.
- `plugins/ollama/.claude-plugin/plugin.json`: rename plugin id to `ollama`, update description ("Delegate code review and rescue tasks to a local Ollama model").
- `LICENSE`/`NOTICE`: keep Apache 2.0, add a NOTICE entry crediting OpenAI's original work.
- `README.md`: rewrite top section (defer full rewrite to Phase 5).

### Step 1.3 — Slash command renames
Rename every command file under `commands/` so the namespace becomes `ollama:` instead of `codex:`:
- `/codex:review` → `/ollama:review`
- `/codex:adversarial-review` → `/ollama:adversarial-review`
- `/codex:rescue` → `/ollama:rescue`
- `/codex:setup` → `/ollama:setup`
- `/codex:status` → `/ollama:status`
- `/codex:result` → `/ollama:result`
- `/codex:cancel` → `/ollama:cancel`

Inside each `.md` frontmatter and body, replace references to `codex-companion.mjs`, `codex` CLI, `Codex`, `OpenAI`, etc. Don't change behavioral instructions yet — just identifiers and paths.

### Step 1.4 — Global string sweep
- Run `rg -l 'codex|Codex|CODEX' plugins/ scripts/ tests/` and update each hit. Be careful: some references are to job-state directories (`.codex/companion-jobs/`) — change to `.ollama/companion-jobs/` consistently so old state isn't read.
- Update env var names: `CODEX_*` → `OLLAMA_PLUGIN_*` (don't reuse `OLLAMA_HOST` for plugin config — that's Ollama's own var).

### Step 1.5 — Smoke test
- `node --test tests/*.test.mjs` — most tests will fail because they import `codex.mjs` paths or assert Codex-specific output. That's fine; we're about to replace the backend. Land this commit anyway so the rename is reviewable on its own.

**Commit:** `chore: rename codex → ollama (mechanical rebrand pass)`

---

## Phase 2 — Replace the Backend (Codex JSON-RPC → Ollama HTTP)

This is the core engineering work. Done in three substeps.

### Step 2.1 — Build a thin Ollama client (`scripts/lib/ollama.mjs`)
Replace the contents of the renamed `scripts/lib/ollama.mjs` (formerly `codex.mjs`) with a small client around Ollama's HTTP API. Surface area to expose:
- `chat({ model, messages, tools?, stream: true, signal })` → async iterator of token/tool-call deltas.
- `listModels()` → `GET /api/tags`.
- `pullModel(name)` → `POST /api/pull` with progress streaming.
- `health()` → `GET /api/tags` doubles as a ping.
- Honor `OLLAMA_HOST` env var; default `http://127.0.0.1:11434`.
- Use Node's built-in `fetch` (Node ≥ 18) — no new runtime deps.

### Step 2.2 — Delete the broker, replace `app-server.mjs`
- **Delete** `scripts/app-server-broker.mjs`, `scripts/lib/broker-lifecycle.mjs`, `scripts/lib/broker-endpoint.mjs`, `scripts/lib/app-server.mjs`, `scripts/lib/app-server-protocol.d.ts`. Ollama's HTTP API is stateless and supports concurrency natively — no broker needed.
- Update `tests/broker-endpoint.test.mjs` → delete (and remove from CI).
- Anywhere that called the broker (`ollama-companion.mjs`, `tracked-jobs.mjs`) now calls `ollama.mjs` directly.

### Step 2.3 — Rewire `ollama-companion.mjs`
The companion script is the entry point for every command. Adapt its three flows:

1. **`review` flow** (read-only):
   - Build a system+user prompt from the git diff (logic in `git.mjs` is unchanged).
   - Stream `chat()` with `format: 'json'` and the schema from `schemas/review-output.schema.json` (Ollama supports JSON-mode for compatible models).
   - Parse + validate the response against the schema; emit to stdout for Claude Code to render verbatim.

2. **`task`/`rescue` flow** (write-capable):
   - **v1 (ship first):** non-agentic — model returns a unified diff in its response; companion prints it for Claude to apply. Simple, works with any model.
   - **v2:** agentic — register tools (`read_file`, `write_file`, `apply_patch`, `run_bash`), run a tool-call loop until the model returns no more tool calls. Persist each tool call to the job log.
   - Background mode (`--background`) keeps working via existing `tracked-jobs.mjs` — only the inner backend call changes.

3. **`adversarial-review` flow:** same as `review` but with the adversarial system prompt and stricter JSON schema constraints.

### Step 2.4 — Job tracking adjustments
- `tracked-jobs.mjs` and `state.mjs` are mostly backend-agnostic — only the "what's stored per turn" shape changes (no JSON-RPC turn IDs; instead store Ollama request/response pairs).
- Move job storage from `.codex/companion-jobs/` to `.ollama/companion-jobs/` (already done in Step 1.4).

### Step 2.5 — Hooks
- `session-lifecycle-hook.mjs`: previously started/stopped the Codex broker. Now it just verifies Ollama is reachable (warn if not) — no broker to manage.
- `stop-review-gate-hook.mjs`: rewire to call the new `review` flow. Behavior identical from the user's perspective.

**Commit (multiple):**
- `feat: add ollama HTTP client`
- `refactor: drop app-server broker, route through ollama client`
- `feat: rewire companion script flows to ollama backend`
- `feat: agentic tool-calling loop for /ollama:rescue` (separate commit, possibly Phase 3)

---

## Phase 3 — Tests

### Step 3.1 — Replace the Codex fixture
- `tests/fake-codex-fixture.mjs` simulated the Codex app-server. Replace with `tests/fake-ollama-fixture.mjs` — a tiny HTTP server on a random port that returns canned `/api/chat` streaming responses. Inject its URL via `OLLAMA_HOST`.

### Step 3.2 — Update tests
- `commands.test.mjs`, `runtime.test.mjs`: re-point at the new fake server, update expected output shapes.
- `state.test.mjs`, `git.test.mjs`, `render.test.mjs`, `process.test.mjs`: should pass mostly unchanged after path renames.
- Delete `broker-endpoint.test.mjs`.
- Add new tests:
  - Streaming response parsing (token deltas, tool-call deltas).
  - JSON-mode response validation against `review-output.schema.json`.
  - Health-check failure behavior (Ollama not running → friendly error, not stack trace).
  - Tool-call loop happy path + max-iterations safety limit.

### Step 3.3 — CI
- Keep `node --test` as the runner. No new dependencies needed.

**Commit:** `test: port test suite to ollama backend`

---

## Phase 4 — Prompts & Skills Retuning

Codex prompts assume GPT-5.4 capabilities (long context, strong JSON adherence, nuanced reasoning). Open models vary widely — we need prompts that degrade gracefully.

### Step 4.1 — `prompts/adversarial-review.md`
- Keep the adversarial framing.
- Add explicit "respond ONLY with JSON matching this schema" reminder near the end (smaller models drift).
- Reduce reliance on multi-step chain-of-thought — front-load the key questions.

### Step 4.2 — `prompts/stop-review-gate.md`
- Already lightweight; mostly fine. Tighten the ALLOW/BLOCK output format (one token, uppercase) so 7B/8B models can hit it reliably.

### Step 4.3 — Replace the prompting skill
- Delete `skills/gpt-5-4-prompting/`.
- Add `skills/ollama-model-prompting/` with guidance on:
  - Picking a model (`llama3.1:8b` baseline, `qwen2.5-coder:14b` for code-heavy work, `deepseek-coder-v2` for stronger reasoning).
  - Tool-calling support matrix (which models support it natively).
  - Context window tradeoffs.
  - When to fall back from JSON-mode to plain text + post-parse.

### Step 4.4 — Update other skills
- `skills/ollama-cli-runtime/`: rewrite to describe the new `ollama-companion.mjs` invocation, env vars, and host config.
- `skills/ollama-result-handling/`: largely unchanged — same "render verbatim, don't summarize" rule.

**Commit:** `feat: retune prompts and skills for open-weight models`

---

## Phase 5 — Setup Flow & UX Polish

### Step 5.1 — `/ollama:setup` command
Rewrite to:
1. Check Ollama is installed (`which ollama` or hit `OLLAMA_HOST`).
2. Check Ollama is running (`GET /api/tags`); if not, instruct: `ollama serve` or `brew services start ollama`.
3. List installed models; flag whether any support tool-calling.
4. Optional: `--pull <model>` to grab a recommended default.
5. Optional: `--enable-review-gate` (writes to Claude Code hooks config — same as upstream).

### Step 5.2 — Default model selection
- Add an `OLLAMA_PLUGIN_DEFAULT_MODEL` env var (or config file in `.ollama/plugin-config.json`).
- If not set, prompt the user during `/ollama:setup`.
- Pass through `--model` flag overrides on every command.

### Step 5.3 — README rewrite
- Quickstart: install Ollama → pull a model → install plugin → run `/ollama:setup` → try `/ollama:review`.
- Document the model-capability tradeoffs (review works on most models; rescue requires tool-calling).
- Document env vars: `OLLAMA_HOST`, `OLLAMA_PLUGIN_DEFAULT_MODEL`.
- Credit upstream `openai/codex-plugin-cc`.

### Step 5.4 — CHANGELOG
- Reset to `0.1.0` with a note: "Initial Ollama port of openai/codex-plugin-cc v1.0.4".

**Commit:** `docs: rewrite README and setup flow for ollama`

---

## Phase 6 — Release

### Step 6.1 — Manual end-to-end smoke
On a real project with real Ollama running:
- `/ollama:review` against a small diff — verify JSON output and Claude Code rendering.
- `/ollama:adversarial-review` — verify findings have severity + recommendations.
- `/ollama:rescue` (background) → `/ollama:status` → `/ollama:result` — verify the full async lifecycle.
- `/ollama:cancel` mid-task — verify cleanup.
- Enable review gate, make Claude write code, confirm gate runs on Stop.

### Step 6.2 — Marketplace metadata
- Decide hosting: personal GitHub repo + marketplace.json that users add manually, OR submit to a community marketplace.
- Tag a `v0.1.0` release.

### Step 6.3 — Iteration backlog (post-v0.1.0)
- Multi-model routing (use a fast model for review gate, a stronger one for adversarial review).
- Cache model responses for identical diffs (cheap win for repeated review runs).
- Streaming progress in `/ollama:status` (currently it'd just say "running").
- Optional: support remote Ollama hosts over Tailscale / SSH tunnel.

---

## Risk Register

| Risk | Likelihood | Mitigation |
|---|---|---|
| Open models produce malformed JSON despite JSON-mode | High | Validate + retry once with stricter prompt; fall back to lenient parsing. |
| Tool-calling unreliable on smaller models | Medium | Ship v1 as patch-emit (non-agentic) first; gate agentic mode behind `--agentic` flag. |
| Users confused by model selection | Medium | `/ollama:setup` walks them through it; README has a recommended model per use case. |
| Upstream codex-plugin-cc evolves and our fork drifts | Low | Keep `upstream` remote; periodically cherry-pick non-Codex-specific improvements (job tracking, hooks, render). |
| Ollama HTTP API changes | Low | Pin to current API surface; the client is small enough to update quickly. |

---

## Effort Estimate

- Phase 0: 0.5 day
- Phase 1: 0.5 day (mostly mechanical, but thorough)
- Phase 2: 2–3 days (real engineering — most of the project)
- Phase 3: 1 day
- Phase 4: 0.5 day
- Phase 5: 0.5 day
- Phase 6: 0.5 day

**Total: ~5–6 days of focused work to ship v0.1.0.**
