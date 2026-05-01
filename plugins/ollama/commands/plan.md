---
description: Generate an evidence-grounded plan for a multi-step task using an Ollama planner model
argument-hint: "[--model <name>] \"<task description>\""
allowed-tools: Bash(node:*)
---

Run the `plan` subcommand of the Ollama companion. The planner uses a read-only agentic loop (`read_file`, `list_directory`) to ground itself in the actual codebase before emitting a structured JSON plan.

Forward the raw user request to the companion:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/ollama-companion.mjs" plan $ARGUMENTS
```

The output is rendered markdown showing the plan's task, rationale, confidence score, scope, and steps with success criteria. The final lines suggest follow-up commands (`/ollama:execute-plan` or `/ollama:replan`).

Review the plan before approving. If the rationale is shaky or the scope is wrong, refine with `/ollama:replan <plan-id> "<your feedback>"`. If the plan looks correct, proceed with `/ollama:execute-plan <plan-id>`.

Per-role model defaults can be set via env: `OLLAMA_PLUGIN_PLANNER_MODEL` (falls back to `OLLAMA_PLUGIN_DEFAULT_MODEL`).
