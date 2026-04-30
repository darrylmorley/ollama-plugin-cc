---
description: Cancel an active background Ollama job in this repository
argument-hint: '[job-id]'
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/ollama-companion.mjs" cancel "$ARGUMENTS"`
