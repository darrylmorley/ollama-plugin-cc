# Public API surface

This document defines what is **public** (covered by semver) and what is
**internal** (may break in any release) for `ollama-plugin-cc` v1.0+.

If you build tooling that integrates with this plugin, depend only on the
**public** items below. Internal modules are subject to change.

---

## Public — semver-stable from v1.0.0

### CLI flags on `ollama-companion.mjs`

The plugin's user-facing entry point is the slash commands. Internally each
command shells out to `node scripts/ollama-companion.mjs <subcommand>`.
The flag surface is treated as public for v1.x:

| Subcommand | Public flags |
|---|---|
| `setup` | `--enable-review-gate` / `--disable-review-gate`, `--default-model <name>`, `--pull <model>`, `--json` |
| `review` | `--wait` / `--background`, `--base <ref>`, `--scope <auto\|working-tree\|branch>`, `--model <name>` |
| `adversarial-review` | same as `review`, plus a positional focus-text argument |
| `task` (rescue) | `--background` / `--wait`, `--write`, `--resume-last` / `--resume` / `--fresh`, `--model <name>`, `--effort <none\|minimal\|low\|medium\|high\|xhigh>`, `--emit-patch`, `--agentic` |
| `status` | `[job-id]`, `--all`, `--json` |
| `result` | `[job-id]`, `--json` |
| `cancel` | `[job-id]`, `--json` |

Adding new flags is non-breaking. Removing or repurposing a flag is a
**major** version bump.

### Environment variables

| Var | Purpose |
|---|---|
| `OLLAMA_HOST` | Override the Ollama API endpoint (default `http://127.0.0.1:11434`) |
| `OLLAMA_PLUGIN_DEFAULT_MODEL` | Default model when `--model` is not passed |
| `OLLAMA_PLUGIN_RESCUE_ALLOW_COMMANDS` | Extend the `run_command` allowlist (CSV, or `*` for unrestricted) |
| `OLLAMA_PLUGIN_LOG_LEVEL` | `debug` enables verbose progress logs |
| `OLLAMA_PLUGIN_COMPANION_SESSION_ID` | Session correlation; usually set by the slash-command harness |

### Job-state JSON shape

Job records persisted under `${workspace}/.ollama/companion-state.json`
expose a stable shape. Treat new fields as additive; existing fields
will not change semantics within v1.x.

```jsonc
{
  "jobs": [
    {
      "id": "string",
      "kind": "review" | "adversarial-review" | "task",
      "kindLabel": "string",
      "status": "queued" | "running" | "completed" | "failed" | "cancelled",
      "phase": "string | null",
      "lastMessage": "string | null",
      "summary": "string | null",
      "threadId": "string | null",
      "turnId": "string | null",
      "createdAt": "ISO-8601",
      "updatedAt": "ISO-8601",
      "completedAt": "ISO-8601 | undefined"
    }
  ]
}
```

The `status` enum is closed (no new values without a major bump). The
`phase` and `lastMessage` strings are advisory and may change wording
freely between minor versions.

### Hook contract

`plugins/ollama/hooks/hooks.json` declares the Stop hook used by the
review-gate feature. The hook contract (event names, JSON shape passed
to the hook script, expected exit codes) is public.

### Slash-command names

`/ollama:setup`, `/ollama:review`, `/ollama:adversarial-review`,
`/ollama:rescue`, `/ollama:status`, `/ollama:result`, `/ollama:cancel`.
Renaming or removing a slash command is a major version bump.

---

## Internal — may break without notice

Everything not listed above. In particular:

### `plugins/ollama/scripts/lib/*.mjs`

- `lib/ollama.mjs` — HTTP client, `chat`, `runReview`, `runTask`,
  `runAgenticTask`, `ollamaShow`, model metadata helpers
- `lib/agentic-tools.mjs` — tool definitions and `dispatchToolCall`
- `lib/git.mjs` — `collectReviewContext`, `applyContextBudget`,
  `resolveReviewTarget`
- `lib/token-budget.mjs` — `estimateTokens`, `getModelContextLimit`,
  `resolveBudget`
- `lib/state.mjs`, `lib/tracked-jobs.mjs` — job lifecycle plumbing
- `lib/render.mjs` — markdown rendering
- `lib/process.mjs`, `lib/fs.mjs`, `lib/args.mjs`, `lib/prompts.mjs`,
  `lib/job-control.mjs`, `lib/workspace.mjs` — internal helpers

These exports may change names, signatures, or disappear entirely
between releases. Do not import them from external code.

### Tests, fixtures, scripts/

`tests/`, `scripts/battle-test.mjs`, `scripts/bump-version.mjs` are
project tooling. Not a public surface.

### Output text

The exact wording of progress messages, error strings, and rendered
review/rescue output is **not** part of the public API. Match on
job-state JSON fields, not on rendered text.

---

## Versioning policy

- **Major** (`x.0.0`): removing or repurposing public CLI flags, env
  vars, slash-command names, status enum values, or hook contract.
- **Minor** (`0.x.0`): new public flags, new optional env vars, new
  slash commands, new additive job-state fields, new opt-in tools in
  the agentic loop.
- **Patch** (`0.0.x`): bug fixes, prompt tweaks, documentation,
  internal refactors.

Pre-1.0 releases (`0.x.y`) made no compatibility promises. v1.0
locks the surface defined here.
