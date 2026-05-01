---
description: Refine an existing Ollama plan based on feedback, preserving prior revisions
argument-hint: "<plan-id> [--model <name>] \"<feedback>\""
allowed-tools: Bash(node:*)
---

Refine a draft plan that has not yet been executed. Forward to the companion:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/ollama-companion.mjs" replan $ARGUMENTS
```

The new revision replaces the steps; the prior version is archived in the plan's `revisions[]` for audit. Replan refuses if the plan is already `executing` or `complete` — use `/ollama:plan` to start fresh in that case.
