# ollama-plugin-cc

[![CI](https://github.com/darrylmorley/ollama-plugin-cc/actions/workflows/ci.yml/badge.svg)](https://github.com/darrylmorley/ollama-plugin-cc/actions/workflows/ci.yml)

Use a local Ollama model from Claude Code to review code or delegate tasks.

This plugin lets you run code reviews and background rescue tasks against an
[Ollama](https://ollama.com) server — local by default, with optional access to
hosted frontier models via Ollama Cloud (`:cloud` suffix). No OpenAI account, no
API key plumbing, and your code stays on your hardware unless you explicitly
choose a cloud-hosted model.

## Quickstart

1. **Install Ollama** — download the desktop app or follow the CLI instructions at [ollama.com](https://ollama.com).

2. **Pull a model**:
   ```bash
   ollama pull llama3.1:8b
   ```

3. **Install the plugin** (placeholder — update once published to a marketplace):
   ```bash
   /plugin install ollama@darrylmorley/ollama-plugin-cc
   ```

4. **Run setup**:
   ```bash
   /ollama:setup
   ```
   Setup checks that Ollama is installed, running, and has at least one model. It also lets
   you set a default model and optionally enable the stop-time review gate.

5. **Try a review**:
   ```bash
   /ollama:review
   ```

## Commands

| Command | What it does |
|---|---|
| `/ollama:review` | Read-only review of current uncommitted changes or a branch diff |
| `/ollama:adversarial-review` | Steerable review that challenges design decisions and tradeoffs |
| `/ollama:rescue` | Delegates a task to Ollama; runs an agentic tool-calling loop by default (`--emit-patch` for one-shot diff) |
| `/ollama:status` | Shows running and recent Ollama jobs for the current repo |
| `/ollama:result` | Shows the stored output for a finished job |
| `/ollama:cancel` | Cancels an active background job |
| `/ollama:setup` | Checks Ollama readiness, pulls models, sets defaults, toggles review gate |

## Model selection

See the `ollama-model-prompting` skill for full guidance. Short version:

### Local models

Empirically battle-tested against a SQL-injection fixture. See
[`docs/MODELS.md`](docs/MODELS.md) for the full results table and reproducer.

| Model | Review | Adv. review | Rescue | Best for |
|---|---|---|---|---|
| `gpt-oss:20b` | ✓ 26s | ✓ 24s | ✓ 4 iter / 20s | All-rounder, balanced size/quality |
| `gemma4:26b` | ✓ 69s | ✓ 110s | ✓ 5 iter / 29s | Rescue when patches reject; reliable structured output |
| `qwen3.5:9b` | ✓ 79s | ✓ 74s | ✓ 3 iter / 44s | VRAM-constrained rigs (6.6 GB) |
| `qwen3.6:27b-coding-nvfp4` | ✗ schema | flaky | ✓ 4 iter / 120s | Rescue only — review path unstable on Apple Silicon |
| `batiai/qwen3.6-27b:q6` | ✗ schema | ✗ schema | ✓ 1 iter / 300s | Rescue only — review path drifts off schema |

Tool-calling (used by agentic rescue) is reliable on Llama 3.1+,
Qwen 2.5+/3+, DeepSeek-Coder-V2+, GPT-OSS, Gemma 3+, GLM 4+, Kimi K2+, and
Granite 3. Smaller models (3B, 1B), thinking-token models (DeepSeek-R1
distills), and pre-3 Gemma fall back to patch-emit automatically.

### Cloud models (Ollama Cloud)

If your hardware can't run a strong local model — or you want frontier-quality
output for a tough adversarial review — Ollama Cloud exposes hosted models
behind the same API via a `:cloud` suffix. The plugin treats them identically
to local models; nothing in the plugin needs to change.

| Model | Review | Adv. review | Rescue | Notes |
|---|---|---|---|---|
| `qwen3-coder-next:cloud` | ✓ 6s | ✓ 6s | ✓ 3 iter / 9s | **Fastest across the board** — 80B FP8 |
| `glm-5.1:cloud` | ✓ 63s | ✓ 47s | ✓ 6 iter / 29s | Reliable structured output; strong rescue |
| `kimi-k2.6:cloud` | flaky | ✓ 113s | ✓ 3 iter / 13s | 1T params; review schema drift, adversarial fine |

Cloud models send your diff context to Ollama's hosted endpoint — opt in by
passing one explicitly via `--model` or `/ollama:setup --default-model`.
Everything else stays local.

Override the model on any command with `--model <name>`.

## Configuration

| Variable | Description |
|---|---|
| `OLLAMA_HOST` | Ollama server URL (default: `http://127.0.0.1:11434`) |
| `OLLAMA_PLUGIN_DEFAULT_MODEL` | Fallback model when `--model` is not passed and no per-workspace config is set |
| `OLLAMA_PLUGIN_RESCUE_ALLOW_COMMANDS` | Comma-separated list of extra commands for agentic rescue's `run_command` tool; use `*` to allow all |

Per-workspace config (set via `/ollama:setup --default-model`) is stored in the plugin state
directory and takes precedence over `OLLAMA_PLUGIN_DEFAULT_MODEL`.

## Capabilities and limits

- **Review and adversarial-review** work on any model that produces valid JSON. Structured
  output uses Ollama's schema-constrained decoding (Ollama >= 0.5) for reliability.
- **Rescue** runs an agentic tool-calling loop by default: the model can read files, list
  directories, write files, apply patches, and run allowlisted commands autonomously (hard cap:
  20 iterations).
  Use `--emit-patch` to force the legacy one-shot diff output instead. Models that do not support
  tool calling fall back to patch-emit automatically. Override the command allowlist with
  `OLLAMA_PLUGIN_RESCUE_ALLOW_COMMANDS=cmd1,cmd2` (or `=*` for unrestricted).
- **Stop-review gate** uses a `Stop` hook — enable with `/ollama:setup --enable-review-gate`.
  It can create long Claude/Ollama loops; only enable when actively monitoring the session.
- **Background jobs** work for all long-running operations. Use `--background` and check
  progress with `/ollama:status`.
- **Node.js 18.18 or later** is required to run the companion script.

## Orchestrator pipeline (v0.11+)

Beyond per-task dispatch, the plugin now supports a **plan → execute → review** pipeline that lets Claude delegate multi-step work to a chain of Ollama agents:

```
/ollama:plan "audit and fix error handling in lib/"     # planner reads the code, emits a structured plan
# Claude reviews. Looks good.
/ollama:execute-plan pln_abc                            # implement → verify → retry loop, autonomous per step
# Claude reviews the cumulative diff.
```

Three roles, three models (planner/implementer/verifier), Claude only at the gates. Typically 5–10× reduction in Claude tokens for refactors and audit-and-fix work. See [`docs/ORCHESTRATOR.md`](docs/ORCHESTRATOR.md).

## Documentation

- [`docs/ORCHESTRATOR.md`](docs/ORCHESTRATOR.md) — orchestrator pipeline user guide
- [`docs/MODELS.md`](docs/MODELS.md) — empirical model recommendations + battle-test results
- [`docs/API.md`](docs/API.md) — public vs internal surface for v1.x
- [`docs/SMOKE-TEST.md`](docs/SMOKE-TEST.md) — pre-release verification checklist
- [`docs/PLAN-v1.md`](docs/PLAN-v1.md) — v0.1 → v1.0 roadmap and status
- [`docs/PLAN-orchestrator.md`](docs/PLAN-orchestrator.md) — orchestrator design rationale
- [`CHANGELOG.md`](CHANGELOG.md) — release notes

## Credits

Ported from [openai/codex-plugin-cc](https://github.com/openai/codex-plugin-cc), Apache 2.0.
See `NOTICE` for attribution. This project is not affiliated with OpenAI or Anthropic.
