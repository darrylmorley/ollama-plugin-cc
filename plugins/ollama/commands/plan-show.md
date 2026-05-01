---
description: Render an existing Ollama plan as markdown
argument-hint: "<plan-id> [--json]"
allowed-tools: Bash(node:*)
---

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/ollama-companion.mjs" plan-show $ARGUMENTS
```
