---
description: Autonomously execute an approved Ollama plan, with implement → verify → retry per step
argument-hint: "<plan-id> [--implementer <name>] [--verifier <name>] [--max-retries <N>] [--step <N>] [--resume-from <N>] [--dry-run]"
allowed-tools: Bash(node:*)
---

Run the implement → verify → retry loop autonomously per step in the plan. The inner loop never crosses Claude's context.

Forward to the companion:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/ollama-companion.mjs" execute-plan $ARGUMENTS
```

Per step the pipeline:
1. Implements via the agentic toolset (`read_file`, `write_file`, `apply_patch`, `run_command`, `done`).
2. Captures the diff.
3. Verifies each `successCriterion` against the diff and the current state of in-scope files.
4. On pass, commits to git as `[ollama-plan <id>] step N: <description>` and advances.
5. On fail, rolls back the working tree and retries with the verifier's feedback. Capped at `--max-retries` (default 3).

If a step exhausts retries, the plan is marked `stuck` and execution returns to Claude. Use `/ollama:replan <id>` to refine, then `/ollama:execute-plan <id> --resume-from <N>` to continue.

Per-role model defaults: `OLLAMA_PLUGIN_IMPLEMENTER_MODEL`, `OLLAMA_PLUGIN_VERIFIER_MODEL`. CLI flags override env.

The pipeline refuses to start on a dirty working tree — commit or stash first.
