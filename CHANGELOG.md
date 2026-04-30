# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [0.10.0] - 2026-05-01

### Added

- **Full battle test across 8 models** — qwen3.5:9b, gemma4:26b, gpt-oss:20b, qwen3.6:27b-coding-nvfp4, batiai/qwen3.6-27b:q6, glm-5.1:cloud, kimi-k2.6:cloud, qwen3-coder-next:cloud. **All 8 passed rescue.**

### Fixed

- `scripts/battle-test.mjs` — driver now merges stderr into the classifier input, so the agentic-vs-patch-emit mode and iteration counts are accurate (was reporting all rescues as "patch-emit" with 0 iterations in v0.8).

### Changed

- README + `docs/MODELS.md` — full results table including the 3 previously-untested models (`batiai/qwen3.6-27b:q6`, `kimi-k2.6:cloud`, `qwen3-coder-next:cloud`) and corrected iteration counts for the 5 already-tested models.

### Notable findings

- `qwen3-coder-next:cloud` is the fastest tested model end-to-end (6–9 s per command).
- Both qwen3.6 27B local variants drift off the JSON schema for review; use them only for rescue.
- `kimi-k2.6:cloud` review path is flaky; adversarial works fine.

## [0.9.0] - 2026-05-01

### Added

- **Streaming progress in `/ollama:status`** — running jobs now show a "Last update" line with the most recent progress message. Disk writes are throttled (every 2s within a phase; immediate on phase change) to avoid FS pressure on token streams.
- **`docs/API.md`** — defines the public vs internal surface for v1.0+: CLI flags, env vars, job-state JSON shape, hook contract, slash-command names are public. Library exports under `lib/` are internal.

### Changed

- Job records now carry an additive `lastMessage` field. Pre-existing consumers continue to work unchanged.

### Notes

- v0.9.0 is the v1.0 release candidate. Phase 5 (marketplace publication + v1.0 tag) is the only work remaining.
- Deferred from this release: review cache (3.5) — defer to v1.x pending real-world demand. Gemma4 adversarial schema drift remains documented as a caveat in `docs/MODELS.md`.

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
