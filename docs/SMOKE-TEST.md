# Smoke-Test Checklist — ollama-plugin-cc

Run before tagging a release. Requires a real Ollama instance.
**Prerequisites:** Claude Code installed, Node ≥ 18.18, `ollama` CLI on PATH.

For automated multi-model testing, prefer `node scripts/battle-test.mjs`
([`docs/MODELS.md`](MODELS.md) explains).

---

## 1 — Install the plugin

**Command:** `/plugin install <path-to-ollama-plugin-cc>`
**Expected:** Plugin loads; `/ollama:*` commands appear in `/help`.
**If it fails:** Check `plugins/ollama/.claude-plugin/plugin.json` has `"name": "ollama"`.

---

## 2 — Setup with Ollama not running

**Command:** `/ollama:setup` _(while `ollama serve` is NOT running)_
**Expected:** One-line "connection refused" message with `ollama serve` instructions. No stack trace.
**If it fails:** Verify `OLLAMA_HOST` isn't pointing to a live instance. Raw errors here are bugs.

---

## 3 — Setup with Ollama running

```bash
ollama serve          # separate terminal
ollama pull gpt-oss:20b   # or any battle-tested model from docs/MODELS.md
/ollama:setup
/ollama:setup --default-model gpt-oss:20b
```

**Expected:** Ollama reported reachable; the model listed with tool-calling capability; default model set.
**If it fails:** `curl http://127.0.0.1:11434/api/tags` confirms the API is up. If the model isn't listed, run `ollama pull <model>` and retry.

---

## 4 — Review against a small diff

**Setup:** Leave any small change unstaged in a git repo.
**Command:** `/ollama:review`
**Expected:** Structured review: verdict, summary, findings with severity, **line numbers cited from the inline file content** (Phase 2 feature). No raw JSON visible.
**If it fails:** `node ${CLAUDE_PLUGIN_ROOT}/scripts/ollama-companion.mjs review 2>&1 | head -30` to see raw output. JSON drift triggers one automatic retry; if both attempts fail, the model's review path may not be schema-reliable — see [`docs/MODELS.md`](MODELS.md).

---

## 5 — Adversarial review

**Command:** `/ollama:adversarial-review` _(same diff as step 4)_
**Expected:** Findings include `severity` (critical/high/medium/low) and `recommendation` per item. The harsher prompt typically yields more findings than `/ollama:review`.
**If it fails:** Schema-constrained decoding requires Ollama ≥ 0.5. Set `OLLAMA_PLUGIN_LOG_LEVEL=debug` to inspect raw output.

---

## 6 — Agentic rescue (foreground)

**Command:** `/ollama:rescue "Add a docstring to the main function in <file>"`
**Expected:** The companion runs an agentic tool-calling loop — you should see `[ollama] Iteration N of 20.` lines on stderr, then either `Agent called done.` or `Agent completed`. The file is modified directly (via `write_file` or `apply_patch`).
**If you want patch-emit instead:** `/ollama:rescue --emit-patch "..."` returns a unified diff for Claude to apply.
**If it fails:**
- Confirm the model supports tool calling — see [`docs/MODELS.md`](MODELS.md). Models in `TOOL_CALLING_DENY_FAMILIES` auto-fall back to patch-emit with a warning.
- If the agent hits the 20-iteration cap, try a model from the local-recommended list in MODELS.md.
- Very small models (< 3B) typically can't sustain a tool-calling loop.

---

## 7 — Background job lifecycle

```
/ollama:rescue --background "Audit error handling in working tree"
```
- **Expected:** Returns job ID immediately.

```
/ollama:status
```
- **Expected:** Job shows as `running` or `completed` with phase, elapsed time, and a `Last update:` line for in-flight jobs (Phase 3.4 feature).

```
/ollama:result
```
- **Expected:** Stored output for latest finished job.

Start another background job, then:
```
/ollama:cancel <job-id>
```
- **Expected:** Job transitions to `cancelled`; worker stops; no orphan `node` processes.

**If any step fails:** Check `.ollama/companion-jobs/` in workspace root. Set `OLLAMA_PLUGIN_LOG_LEVEL=debug`.

---

## 8 — Stop-review gate

```
/ollama:setup --enable-review-gate
```
**Expected:** "Review gate enabled."

Make a small change, let Claude respond, allow Claude to stop.
**Expected:** `Stop` hook fires; Ollama runs adversarial review; outputs ALLOW or BLOCK with findings.

```
/ollama:setup --disable-review-gate
```
**Expected:** Gate disabled; normal stop behaviour resumes.

**If it fails:** Check hook registration in `plugins/ollama/hooks/hooks.json`. Gate timeout is 900 s — for slow machines try a faster model: `/ollama:setup --default-model gpt-oss:20b` or `glm-5.1:cloud`.

---

## 9 — Multi-model battle test (optional, ~30 min)

```
node scripts/battle-test.mjs --models gpt-oss:20b,gemma4:26b,glm-5.1:cloud
```

Runs review, adversarial-review, and rescue against a fixture for each model.
Outputs a markdown results table to stdout. See [`docs/MODELS.md`](MODELS.md)
for the v0.10.0 reference results across 8 models.

---

_All commands accept `--model <name>` to override the default for a single run._
