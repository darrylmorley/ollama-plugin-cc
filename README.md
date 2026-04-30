# ollama-plugin-cc

Use a local Ollama model from Claude Code to review code or delegate tasks.

This plugin lets you run code reviews and background rescue tasks against a local
[Ollama](https://ollama.com) server — no cloud account, no API key, no data leaving your machine.

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
| `/ollama:rescue` | Delegates a task to Ollama; emits a diff for Claude to apply |
| `/ollama:status` | Shows running and recent Ollama jobs for the current repo |
| `/ollama:result` | Shows the stored output for a finished job |
| `/ollama:cancel` | Cancels an active background job |
| `/ollama:setup` | Checks Ollama readiness, pulls models, sets defaults, toggles review gate |

## Model selection

See the `ollama-model-prompting` skill for full guidance. Short version:

| Use case | Recommended model |
|---|---|
| General review (baseline) | `llama3.1:8b` |
| Code-heavy review | `qwen2.5-coder:14b` |
| Adversarial review | `deepseek-coder-v2:16b` |
| Stop-review gate only | `qwen2.5:7b` |

Tool-calling (required for the future agentic rescue mode) is reliable on Llama 3.1+,
Qwen 2.5, and DeepSeek-Coder-V2. Smaller models (3B, 1B) and thinking-token models
(DeepSeek-R1 distills) are unreliable for structured output.

Override the model on any command with `--model <name>`.

## Configuration

| Variable | Description |
|---|---|
| `OLLAMA_HOST` | Ollama server URL (default: `http://127.0.0.1:11434`) |
| `OLLAMA_PLUGIN_DEFAULT_MODEL` | Fallback model when `--model` is not passed and no per-workspace config is set |

Per-workspace config (set via `/ollama:setup --default-model`) is stored in the plugin state
directory and takes precedence over `OLLAMA_PLUGIN_DEFAULT_MODEL`.

## Capabilities and limits

- **Review and adversarial-review** work on any model that produces valid JSON. Structured
  output uses Ollama's schema-constrained decoding (Ollama >= 0.5) for reliability.
- **Rescue** currently runs in patch-emit mode: the model outputs a unified diff that Claude
  Code applies. Agentic tool-calling (read/write/bash loop) is planned for a future release.
- **Stop-review gate** uses a `Stop` hook — enable with `/ollama:setup --enable-review-gate`.
  It can create long Claude/Ollama loops; only enable when actively monitoring the session.
- **Background jobs** work for all long-running operations. Use `--background` and check
  progress with `/ollama:status`.
- **Node.js 18.18 or later** is required to run the companion script.

## Credits

Ported from [openai/codex-plugin-cc](https://github.com/openai/codex-plugin-cc), Apache 2.0.
See `NOTICE` for attribution. This project is not affiliated with OpenAI or Anthropic.
