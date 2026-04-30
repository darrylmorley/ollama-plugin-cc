---
description: Check Ollama installation and readiness, pull models, set defaults, and toggle the stop-time review gate
argument-hint: '[--pull <model>] [--default-model <name>] [--enable-review-gate|--disable-review-gate]'
allowed-tools: Bash(node:*), AskUserQuestion
---

Run:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/ollama-companion.mjs" setup --json $ARGUMENTS
```

The setup command checks:

1. Whether Node.js is available (required to run the companion script).
2. Whether the `ollama` binary is installed (`ollama --version`).
3. Whether the Ollama server is reachable (`GET /api/tags` on `OLLAMA_HOST`, default `http://127.0.0.1:11434`).
4. Which models are installed locally; flags each one for tool-calling support.
5. Whether a default model is configured (`OLLAMA_PLUGIN_DEFAULT_MODEL` or per-workspace config).
6. Whether the stop-time review gate is enabled.

## If Ollama is not installed

Direct the user to install Ollama from https://ollama.com.

For macOS the recommended install is the desktop app or:

```bash
brew install ollama
```

## If Ollama is installed but not running

Tell the user to start the server:

```bash
ollama serve
# or on macOS with Homebrew:
brew services start ollama
```

## If no models are installed

Recommend pulling a model before using the plugin. Suggest based on use case:

- General review (baseline): `ollama pull llama3.1:8b`
- Code-heavy review: `ollama pull qwen2.5-coder:14b`
- Adversarial review: `ollama pull deepseek-coder-v2:16b`
- Stop-review gate only (minimal): `ollama pull qwen2.5:7b`

Or let the command pull for the user:

```bash
/ollama:setup --pull llama3.1:8b
```

## Optional flags

### `--pull <model>`

Pulls the named model from the Ollama registry. Progress is streamed during the pull.

```bash
/ollama:setup --pull llama3.1:8b
/ollama:setup --pull qwen2.5-coder:14b
```

### `--default-model <name>`

Writes the model name to the per-workspace plugin config. All commands fall back to this
when `--model` is not passed. `OLLAMA_PLUGIN_DEFAULT_MODEL` env var is also honoured as a
fallback if the config key is not set.

```bash
/ollama:setup --default-model llama3.1:8b
```

### `--enable-review-gate` / `--disable-review-gate`

Toggles the stop-time review gate for the current workspace. When enabled, the plugin's
`Stop` hook runs an Ollama adversarial review after every Claude response and blocks the
stop if issues are found. Use with caution — it can create long Claude/Ollama loops.

```bash
/ollama:setup --enable-review-gate
/ollama:setup --disable-review-gate
```

## Output rules

- Present the final setup output to the user verbatim.
- Do not summarise or paraphrase the next steps — show them exactly as returned.
- If the setup reports not-ready, guide the user through the listed next steps.
