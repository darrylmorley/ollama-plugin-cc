---
description: Delegate investigation, an explicit fix request, or follow-up rescue work to the Ollama rescue subagent
argument-hint: "[--background|--wait] [--resume|--fresh] [--model <model>] [--effort <none|minimal|low|medium|high|xhigh>] [what Ollama should investigate, solve, or continue]"
allowed-tools: Bash(node:*), AskUserQuestion, Agent
---

Invoke the `ollama:ollama-rescue` subagent via the `Agent` tool (`subagent_type: "ollama:ollama-rescue"`), forwarding the raw user request as the prompt.
`ollama:ollama-rescue` is a subagent, not a skill — do not call `Skill(ollama:ollama-rescue)` (no such skill) or `Skill(ollama:rescue)` (that re-enters this command and hangs the session). The command runs inline so the `Agent` tool stays in scope; forked general-purpose subagents do not expose it.
The final user-visible response must be Ollama's output verbatim.

Raw user request:
$ARGUMENTS

Execution mode:

- If the request includes `--background`, run the `ollama:ollama-rescue` subagent in the background.
- If the request includes `--wait`, run the `ollama:ollama-rescue` subagent in the foreground.
- If neither flag is present, default to foreground.
- `--background` and `--wait` are execution flags for Claude Code. Do not forward them to `task`, and do not treat them as part of the natural-language task text.
- `--model` and `--effort` are runtime-selection flags. Preserve them for the forwarded `task` call, but do not treat them as part of the natural-language task text.
- If the request includes `--resume`, do not ask whether to continue. The user already chose.
- If the request includes `--fresh`, do not ask whether to continue. The user already chose.
- Otherwise, before starting Ollama, check for a resumable rescue thread from this Claude session by running:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/ollama-companion.mjs" task-resume-candidate --json
```

- If that helper reports `available: true`, use `AskUserQuestion` exactly once to ask whether to continue the current Ollama thread or start a new one.
- The two choices must be:
  - `Continue current Ollama thread`
  - `Start a new Ollama thread`
- If the user is clearly giving a follow-up instruction such as "continue", "keep going", "resume", "apply the top fix", or "dig deeper", put `Continue current Ollama thread (Recommended)` first.
- Otherwise put `Start a new Ollama thread (Recommended)` first.
- If the user chooses continue, add `--resume` before routing to the subagent.
- If the user chooses a new thread, add `--fresh` before routing to the subagent.
- If the helper reports `available: false`, do not ask. Route normally.

Operating rules:

- The subagent is a thin forwarder only. It should use one `Bash` call to invoke `node "${CLAUDE_PLUGIN_ROOT}/scripts/ollama-companion.mjs" task ...` and return that command's stdout as-is.
- Return the Ollama companion stdout verbatim to the user.
- Do not paraphrase, summarize, rewrite, or add commentary before or after it.
- Do not ask the subagent to inspect files, monitor progress, poll `/ollama:status`, fetch `/ollama:result`, call `/ollama:cancel`, summarize output, or do follow-up work of its own.
- Leave `--effort` unset unless the user explicitly asks for a specific reasoning effort.
- Leave the model unset unless the user explicitly asks for one.
- Leave `--resume` and `--fresh` in the forwarded request. The subagent handles that routing when it builds the `task` command.
- If the helper reports that Ollama is missing or unauthenticated, stop and tell the user to run `/ollama:setup`.
- If the user did not supply a request, ask what Ollama should investigate or fix.
