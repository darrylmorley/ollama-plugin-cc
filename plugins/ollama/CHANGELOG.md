# Changelog

## 0.1.0 (unreleased)

- Forked from openai/codex-plugin-cc v1.0.4
- Replaced Codex JSON-RPC backend with Ollama HTTP API (`/api/chat`, `/api/tags`, `/api/pull`)
- Dropped TCP app-server broker; Ollama HTTP is stateless and natively concurrent
- New `ollama-model-prompting` skill with per-use-case model recommendations and tool-calling support matrix
- `/ollama:setup` rewritten: checks binary install, server reachability, lists installed models with tool-calling flags, supports `--pull <model>`, `--default-model <name>`, and `--enable-review-gate`/`--disable-review-gate`
- Rescue runs in patch-emit mode (model emits a unified diff for Claude to apply); agentic tool-calling loop deferred
- `OLLAMA_PLUGIN_DEFAULT_MODEL` env var and per-workspace `defaultModel` config key for default model selection
