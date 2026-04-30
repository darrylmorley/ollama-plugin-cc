# Smoke-Test Checklist — ollama-plugin-cc v0.1.0

Run before tagging a release. Requires a real Ollama instance.
**Prerequisites:** Claude Code installed, Node ≥ 18.18, `ollama` CLI on PATH.

---

## 1 — Install the plugin

**Command:** `/plugin install <path-to-ollama-plugin-cc>`
**Expected:** Plugin loads; `/ollama:*` commands appear in `/help`.
**If it fails:** Check `plugins/ollama/.claude-plugin/plugin.json` has `"name": "ollama"`.

---

## 2 — Setup with Ollama not running

**Command:** `/ollama:setup` _(while `ollama serve` is NOT running)_
**Expected:** Friendly "not reachable" message with `ollama serve` instructions. No stack trace.
**If it fails:** Verify `OLLAMA_HOST` isn't pointing to a live instance. Raw errors here are bugs.

---

## 3 — Setup with Ollama running

```bash
ollama serve          # separate terminal
ollama pull llama3.1:8b
/ollama:setup
/ollama:setup --default-model llama3.1:8b
```
**Expected:** Ollama reported reachable; `llama3.1:8b` listed with tool-calling flag; default model set.
**If it fails:** `curl http://127.0.0.1:11434/api/tags` — confirms API is up.

---

## 4 — Review against a small diff

**Setup:** Leave any small change unstaged in a git repo.
**Command:** `/ollama:review`
**Expected:** Structured review: verdict, summary, findings with severity. No raw JSON visible.
**If it fails:** `node ${CLAUDE_PLUGIN_ROOT}/scripts/ollama-companion.mjs review 2>&1 | head -30` — check for parse errors. Requires Ollama ≥ 0.3 for JSON mode.

---

## 5 — Adversarial review

**Command:** `/ollama:adversarial-review` _(same diff as step 4)_
**Expected:** Findings include `severity` (critical/high/medium/low) and `recommendation` per item.
**If it fails:** Schema-constrained decoding requires Ollama ≥ 0.5. Set `OLLAMA_PLUGIN_LOG_LEVEL=debug` to inspect raw output.

---

## 6 — Rescue (foreground)

**Command:** `/ollama:rescue "Add a docstring to the main function in <any small file>"`
**Expected:** Companion emits a unified diff. Claude Code presents it for review/apply.
**If it fails:** Confirm default model is set. Very small models (< 3B) may not produce usable diffs.

---

## 7 — Background job lifecycle

```
/ollama:rescue --background "Audit error handling in working tree"
```
- **Expected:** Returns job ID immediately.

```
/ollama:status
```
- **Expected:** Job shows as `running` or `completed` with phase and elapsed time.

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

**If it fails:** Check hook registration in `plugins/ollama/hooks/hooks.json`. Gate timeout is 900 s —
for slow machines try a faster model: `/ollama:setup --default-model qwen2.5:7b`.

---

_All commands accept `--model <name>` to override the default for a single run._
