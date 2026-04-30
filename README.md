# Ollama plugin for Claude Code

Use Ollama from inside Claude Code for code reviews or to delegate tasks to Ollama.

This plugin is for Claude Code users who want an easy way to start using Ollama from the workflow
they already have.

<!-- TODO(phase-5): update demo video -->
<video src="./docs/plugin-demo.webm" controls muted playsinline autoplay></video>

## What You Get

- `/ollama:review` for a normal read-only Ollama review
- `/ollama:adversarial-review` for a steerable challenge review
- `/ollama:rescue`, `/ollama:status`, `/ollama:result`, and `/ollama:cancel` to delegate work and manage background jobs

## Requirements

- **Ollama installed and running** — install from [ollama.com](https://ollama.com)
  <!-- TODO(phase-2): document Ollama model requirements -->
- **Node.js 18.18 or later**

## Install

<!-- TODO(phase-5): update install instructions for Ollama plugin -->

Add the marketplace in Claude Code:

```bash
/plugin marketplace add darrylmorley/ollama-plugin-cc
```

Install the plugin:

```bash
/plugin install ollama@darrylmorley-ollama
```

Reload plugins:

```bash
/reload-plugins
```

Then run:

```bash
/ollama:setup
```

`/ollama:setup` will tell you whether Ollama is ready. Install Ollama from [ollama.com](https://ollama.com) if needed.

<!-- TODO(phase-2): replace Codex-specific install/login flow with Ollama setup guidance -->

After install, you should see:

- the slash commands listed below
- the `ollama:ollama-rescue` subagent in `/agents`

One simple first run is:

```bash
/ollama:review --background
/ollama:status
/ollama:result
```

## Usage

### `/ollama:review`

Runs a normal Ollama review on your current work.

> [!NOTE]
> Code review especially for multi-file changes might take a while. It's generally recommended to run it in the background.

Use it when you want:

- a review of your current uncommitted changes
- a review of your branch compared to a base branch like `main`

Use `--base <ref>` for branch review. It also supports `--wait` and `--background`. It is not steerable and does not take custom focus text. Use [`/ollama:adversarial-review`](#ollamaadversarial-review) when you want to challenge a specific decision or risk area.

Examples:

```bash
/ollama:review
/ollama:review --base main
/ollama:review --background
```

This command is read-only and will not perform any changes. When run in the background you can use [`/ollama:status`](#ollamastatus) to check on the progress and [`/ollama:cancel`](#ollamacancel) to cancel the ongoing task.

### `/ollama:adversarial-review`

Runs a **steerable** review that questions the chosen implementation and design.

It can be used to pressure-test assumptions, tradeoffs, failure modes, and whether a different approach would have been safer or simpler.

It uses the same review target selection as `/ollama:review`, including `--base <ref>` for branch review.
It also supports `--wait` and `--background`. Unlike `/ollama:review`, it can take extra focus text after the flags.

Use it when you want:

- a review before shipping that challenges the direction, not just the code details
- review focused on design choices, tradeoffs, hidden assumptions, and alternative approaches
- pressure-testing around specific risk areas like auth, data loss, rollback, race conditions, or reliability

Examples:

```bash
/ollama:adversarial-review
/ollama:adversarial-review --base main challenge whether this was the right caching and retry design
/ollama:adversarial-review --background look for race conditions and question the chosen approach
```

This command is read-only. It does not fix code.

### `/ollama:rescue`

Hands a task to Ollama through the `ollama:ollama-rescue` subagent.

Use it when you want Ollama to:

- investigate a bug
- try a fix
- continue a previous Ollama task
- take a faster or cheaper pass with a smaller model

> [!NOTE]
> Depending on the task and the model you choose these tasks might take a long time and it's generally recommended to force the task to be in the background or move the agent to the background.

It supports `--background`, `--wait`, `--resume`, and `--fresh`. If you omit `--resume` and `--fresh`, the plugin can offer to continue the latest rescue thread for this repo.

Examples:

```bash
/ollama:rescue investigate why the tests started failing
/ollama:rescue fix the failing test with the smallest safe patch
/ollama:rescue --resume apply the top fix from the last run
/ollama:rescue --model llama3.2 --effort medium investigate the flaky integration test
/ollama:rescue --background investigate the regression
```

You can also just ask for a task to be delegated to Ollama:

```text
Ask Ollama to redesign the database connection to be more resilient.
```

**Notes:**

- if you do not pass `--model` or `--effort`, Ollama chooses its own defaults.
- follow-up rescue requests can continue the latest Ollama task in the repo

<!-- TODO(phase-2): update model/effort notes for Ollama-specific model names -->

### `/ollama:status`

Shows running and recent Ollama jobs for the current repository.

Examples:

```bash
/ollama:status
/ollama:status task-abc123
```

Use it to:

- check progress on background work
- see the latest completed job
- confirm whether a task is still running

### `/ollama:result`

Shows the final stored Ollama output for a finished job.
When available, it also includes the Ollama session ID.

<!-- TODO(phase-2): update session resume instructions once Ollama resume flow is implemented -->

Examples:

```bash
/ollama:result
/ollama:result task-abc123
```

### `/ollama:cancel`

Cancels an active background Ollama job.

Examples:

```bash
/ollama:cancel
/ollama:cancel task-abc123
```

### `/ollama:setup`

Checks whether Ollama is installed and running.

<!-- TODO(phase-2): implement Ollama-specific setup checks -->

You can also use `/ollama:setup` to manage the optional review gate.

#### Enabling review gate

```bash
/ollama:setup --enable-review-gate
/ollama:setup --disable-review-gate
```

When the review gate is enabled, the plugin uses a `Stop` hook to run a targeted Ollama review based on Claude's response. If that review finds issues, the stop is blocked so Claude can address them first.

> [!WARNING]
> The review gate can create a long-running Claude/Ollama loop and may drain usage limits quickly. Only enable it when you plan to actively monitor the session.

## Typical Flows

### Review Before Shipping

```bash
/ollama:review
```

### Hand A Problem To Ollama

```bash
/ollama:rescue investigate why the build is failing in CI
```

### Start Something Long-Running

```bash
/ollama:adversarial-review --background
/ollama:rescue --background investigate the flaky test
```

Then check in with:

```bash
/ollama:status
/ollama:result
```

## Ollama Integration

<!-- TODO(phase-2): rewrite Ollama Integration section once backend is wired up -->

The Ollama plugin will wrap the Ollama HTTP API. It will use the local `ollama` binary installed in your environment.

## FAQ

### Do I need a separate Ollama account for this plugin?

No. Ollama runs locally. No account is required.

<!-- TODO(phase-5): update FAQ for Ollama-specific questions -->
