# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [0.8.0] - 2026-04-30

### Added

- **Battle-test results** — `scripts/battle-test.mjs` runs review, adversarial-review, and rescue against a fixture for each model in a matrix and emits a markdown results table.
- **`docs/MODELS.md`** — empirical recommendations for 5 tested models (qwen3.5:9b, gemma4:26b, gpt-oss:20b, qwen3.6:27b-coding-nvfp4, glm-5.1:cloud), with known gotchas and a reproducer.

### Changed

- **README model tables** — replaced the educated-guess recommendations from v0.1 with results-backed tables for both local and cloud models, including pass/fail and timings from the battle test.

### Notes

- All 5 tested models successfully fixed the SQL injection rescue task.
- `qwen3.6:27b-coding-nvfp4` hit a server-side mlx runner crash on long-prompt review tasks; rescue (shorter tool-call messages) worked. Documented in MODELS.md.

## [0.7.0] - 2026-04-30

### Added

- **CI** — GitHub Actions workflow runs the test suite on Node 18.18, 20, and 22 for every pull request and push to main. Status badge in README.
- **Actionable Ollama-unreachable errors** — connection-refused, DNS-failure, and timeout cases now surface one-line messages with the fix (`Run \`ollama serve\``, `Check OLLAMA_HOST`).
- **Model-not-pulled detection** — 404 from `/api/chat` with a "model not found" body now returns `Run \`ollama pull <model>\` first` instead of the raw API error.

### Removed

- Dead code: `validateNativeReviewRequest`, `buildNativeReviewTarget`, and the unused `buildPersistentTaskThreadName` import from companion.

## [0.6.0] - 2026-04-30

### Added

- **Inline file context with line numbers** — review and adversarial-review now embed the post-change content of each tracked changed file (with line numbers) alongside the diff. Models can cite concrete line numbers (`file.js:42`) and reason about surroundings, not just hunks.
- **Token budgeting** — per-model context limits resolved via Ollama's `/api/show` (when available), falling back to a small static map for cloud models, then to an 8k default. `applyContextBudget` drops the inline file content section first when over budget; the diff is preserved as the load-bearing input.
- New `lib/token-budget.mjs` and `lib/git.mjs#applyContextBudget` exports.

### Changed

- `collectReviewContext` now returns `changedFileContents` separately from `content`, so callers can inspect or strip it without re-parsing.

## [0.5.0] - 2026-04-30

### Added

- **Agentic rescue (default):** `/ollama:rescue` now runs a tool-calling loop by default. Available tools: `read_file`, `list_directory`, `write_file`, `apply_patch`, `run_command`, `done`.
- **`write_file` tool** — the most reliable way for the model to edit files. Live smoke testing showed several models (glm-5.1, qwen3.6-coding, gpt-oss:20b) failed to produce clean unified diffs for `apply_patch`; with `write_file` available, all four tested models (those three plus gemma4:26b) successfully landed the fix. `apply_patch` is still preferred by the system prompt for small surgical edits.
- **20-iteration hard cap** on the agentic rescue loop to prevent runaway sessions.
- **`run_command` allowlist** — default set covers common dev tools (git, npm, bun, pnpm, yarn, cargo, node, python, python3, pytest, jest, tsc, eslint, prettier, make, ls, cat, head, tail, grep, rg, find, wc). Override with `OLLAMA_PLUGIN_RESCUE_ALLOW_COMMANDS=cmd1,cmd2` or `=*` for unrestricted.
- **`--emit-patch` flag** to explicitly force the legacy one-shot patch-emit path.

### Changed

- **Auto-fallback to patch-emit** when the selected model does not support tool calling (`modelSupportsToolCalling()` returns false).

### Fixed

- `TOOL_CALLING_DENY_FAMILIES` now correctly excludes small/older models (phi-3, gemma2) from the tool-calling path, preventing malformed output on models that lack reliable tool-call adherence.
