# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

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
