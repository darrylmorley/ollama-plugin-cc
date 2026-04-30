---
description: Check whether the local Ollama CLI is ready and optionally toggle the stop-time review gate
argument-hint: '[--enable-review-gate|--disable-review-gate]'
allowed-tools: Bash(node:*), Bash(npm:*), AskUserQuestion
---

Run:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/ollama-companion.mjs" setup --json $ARGUMENTS
```

If the result says Ollama is unavailable:
- Present the setup output to the user.
- Direct the user to install Ollama from https://ollama.com.
<!-- TODO(phase-2): replace Codex-specific install flow (npm install -g @openai/codex / !codex login) with Ollama setup guidance -->

If Ollama is already installed:
- Do not ask about installation.

Output rules:
- Present the final setup output to the user.
- If installation was skipped, present the original setup output.
