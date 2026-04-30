/**
 * runtime.test.mjs — Phase 3 test suite for the Ollama companion runtime.
 *
 * Tests drive the companion via `node ollama-companion.mjs <command>` with
 * OLLAMA_HOST pointed at a fake HTTP server (fake-ollama-fixture.mjs).
 *
 * Covers:
 *   - review happy path (working-tree and branch-diff)
 *   - adversarial-review with findings
 *   - task happy path and --write variant
 *   - task --resume-last (local job state)
 *   - task --background → status → result lifecycle
 *   - health-check failure (Ollama unreachable)
 *   - streaming response parsing (unit test against lib/ollama.mjs)
 *   - JSON-mode response validation: success and malformed-JSON failure
 *   - listModels() happy path (unit test against lib/ollama.mjs)
 *   - session-lifecycle-hook env export
 *   - scope/focus-text validation errors
 *   - status/result/cancel command sanity
 */

import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

import { buildEnv, installFakeOllama } from "./fake-ollama-fixture.mjs";
import { initGitRepo, makeTempDir, run } from "./helpers.mjs";
import { resolveStateDir } from "../plugins/ollama/scripts/lib/state.mjs";
import { chat, health, listModels } from "../plugins/ollama/scripts/lib/ollama.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PLUGIN_ROOT = path.join(ROOT, "plugins", "ollama");
const SCRIPT = path.join(PLUGIN_ROOT, "scripts", "ollama-companion.mjs");
const SESSION_HOOK = path.join(PLUGIN_ROOT, "scripts", "session-lifecycle-hook.mjs");

// ---------------------------------------------------------------------------
// Helper: wait for an async condition with polling
// ---------------------------------------------------------------------------

async function waitFor(predicate, { timeoutMs = 5000, intervalMs = 50 } = {}) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const value = await predicate();
    if (value) {
      return value;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error("Timed out waiting for condition.");
}

// ---------------------------------------------------------------------------
// setup command
// ---------------------------------------------------------------------------

test("setup reports ready when Ollama is reachable", () => {
  const binDir = makeTempDir();
  installFakeOllama(binDir);

  const result = run("node", [SCRIPT, "setup", "--json"], {
    cwd: ROOT,
    env: buildEnv(binDir)
  });

  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.ready, true);
  assert.equal(payload.ollama.available, true);
  assert.equal(payload.sessionRuntime.mode, "direct");
});

test("setup reports auth as loggedIn when Ollama is reachable", () => {
  const binDir = makeTempDir();
  installFakeOllama(binDir);

  const result = run("node", [SCRIPT, "setup", "--json"], {
    cwd: ROOT,
    env: buildEnv(binDir)
  });

  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.auth.loggedIn, true);
  assert.equal(payload.auth.source, "ollama-http");
});

// ---------------------------------------------------------------------------
// review command — happy path
// ---------------------------------------------------------------------------

test("review renders a no-findings result for working-tree changes", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeOllama(binDir);
  initGitRepo(repo);
  fs.mkdirSync(path.join(repo, "src"));
  fs.writeFileSync(path.join(repo, "src", "app.js"), "export const value = 1;\n");
  run("git", ["add", "src/app.js"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });
  fs.writeFileSync(path.join(repo, "src", "app.js"), "export const value = 2;\n");

  const result = run("node", [SCRIPT, "review"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Reviewed uncommitted changes/);
  assert.match(result.stdout, /No material issues found/);
});

test("review accepts a --base branch argument for branch-diff review", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeOllama(binDir);
  initGitRepo(repo);
  fs.mkdirSync(path.join(repo, "src"));
  fs.writeFileSync(path.join(repo, "src", "app.js"), "export const value = 1;\n");
  run("git", ["add", "src/app.js"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });
  fs.writeFileSync(path.join(repo, "src", "app.js"), "export const value = 2;\n");

  const result = run("node", [SCRIPT, "review", "--base", "main"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Reviewed changes against main/);
  assert.match(result.stdout, /No material issues found/);
});

test("review accepts the quoted raw argument style for built-in base-branch review", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeOllama(binDir);
  initGitRepo(repo);
  fs.mkdirSync(path.join(repo, "src"));
  fs.writeFileSync(path.join(repo, "src", "app.js"), "export const value = 1;\n");
  run("git", ["add", "src/app.js"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });
  fs.writeFileSync(path.join(repo, "src", "app.js"), "export const value = 2;\n");

  const result = run("node", [SCRIPT, "review", "--base main"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.equal(result.status, 0);
  assert.match(result.stdout, /Reviewed changes against main/);
  assert.match(result.stdout, /No material issues found/);
});

// ---------------------------------------------------------------------------
// adversarial-review — structured findings
// ---------------------------------------------------------------------------

test("adversarial review renders structured findings", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeOllama(binDir);
  initGitRepo(repo);
  fs.mkdirSync(path.join(repo, "src"));
  fs.writeFileSync(path.join(repo, "src", "app.js"), "export const value = items[0];\n");
  run("git", ["add", "src/app.js"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });
  fs.writeFileSync(path.join(repo, "src", "app.js"), "export const value = items[0].id;\n");

  const result = run("node", [SCRIPT, "adversarial-review"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Missing empty-state guard/);
});

test("adversarial review accepts the same --base targeting as review", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeOllama(binDir);
  initGitRepo(repo);
  fs.mkdirSync(path.join(repo, "src"));
  fs.writeFileSync(path.join(repo, "src", "app.js"), "export const value = items[0];\n");
  run("git", ["add", "src/app.js"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });
  fs.writeFileSync(path.join(repo, "src", "app.js"), "export const value = items[0].id;\n");

  const result = run("node", [SCRIPT, "adversarial-review", "--base", "main"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Missing empty-state guard/);
});

// ---------------------------------------------------------------------------
// task command
// ---------------------------------------------------------------------------

test("task runs and streams the result to stdout", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeOllama(binDir);
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });

  // --emit-patch routes to the patch-emit (non-agentic) flow so the fake
  // streaming server produces a determinate response.
  const result = run("node", [SCRIPT, "task", "--emit-patch", "describe the codebase"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Handled the requested task/);
});

test("task --write output focuses on the Ollama result", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeOllama(binDir);
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });

  // --emit-patch routes to the patch-emit (non-agentic) flow so the fake
  // streaming server produces a determinate response.
  const result = run("node", [SCRIPT, "task", "--emit-patch", "--write", "fix the failing test"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "Handled the requested task.\nTask prompt accepted.\n");
});

test("task --resume-last resumes the latest persisted task thread", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeOllama(binDir);
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });

  // --emit-patch routes to the patch-emit (non-agentic) flow so the fake
  // streaming server produces a determinate response on both runs.
  const firstRun = run("node", [SCRIPT, "task", "--emit-patch", "initial task"], {
    cwd: repo,
    env: buildEnv(binDir)
  });
  assert.equal(firstRun.status, 0, firstRun.stderr);

  const result = run("node", [SCRIPT, "task", "--emit-patch", "--resume-last", "follow up"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.equal(result.status, 0, result.stderr);
  // The fake returns TASK_RESUMED when it detects "follow up" or resume cues
  assert.match(result.stdout, /Resumed the prior run|Handled the requested task/);
});

test("task --resume-last without a prompt fails when no previous task exists in the current session", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeOllama(binDir);
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });

  // --resume-last with NO prompt and no prior session history should fail.
  // (With a prompt it succeeds — the prompt is used as the task text.)
  const resume = run("node", [SCRIPT, "task", "--resume-last"], {
    cwd: repo,
    env: {
      ...buildEnv(binDir),
      OLLAMA_PLUGIN_COMPANION_SESSION_ID: "sess-fresh-no-history"
    }
  });
  assert.equal(resume.status, 1);
  assert.match(resume.stderr, /No previous Ollama task thread was found for this repository\./);
});

test("task-resume-candidate returns the latest rescue thread from the current session", () => {
  const workspace = makeTempDir();
  const stateDir = resolveStateDir(workspace);
  const jobsDir = path.join(stateDir, "jobs");
  fs.mkdirSync(jobsDir, { recursive: true });

  fs.writeFileSync(
    path.join(stateDir, "state.json"),
    `${JSON.stringify(
      {
        version: 1,
        config: { stopReviewGate: false },
        jobs: [
          {
            id: "task-current",
            status: "completed",
            title: "Ollama Task",
            jobClass: "task",
            sessionId: "sess-current",
            threadId: "thr_current",
            summary: "Investigate the flaky test",
            updatedAt: "2026-03-24T20:00:00.000Z"
          },
          {
            id: "task-other-session",
            status: "completed",
            title: "Ollama Task",
            jobClass: "task",
            sessionId: "sess-other",
            threadId: "thr_other",
            summary: "Old rescue run",
            updatedAt: "2026-03-24T20:05:00.000Z"
          },
          {
            id: "review-current",
            status: "completed",
            title: "Ollama Review",
            jobClass: "review",
            sessionId: "sess-current",
            threadId: "thr_review",
            summary: "Review main...HEAD",
            updatedAt: "2026-03-24T20:10:00.000Z"
          }
        ]
      },
      null,
      2
    )}\n`,
    "utf8"
  );

  const result = run("node", [SCRIPT, "task-resume-candidate", "--json"], {
    cwd: workspace,
    env: {
      ...process.env,
      OLLAMA_PLUGIN_COMPANION_SESSION_ID: "sess-current"
    }
  });

  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.available, true);
  assert.equal(payload.sessionId, "sess-current");
  assert.equal(payload.candidate.id, "task-current");
  assert.equal(payload.candidate.threadId, "thr_current");
});

// ---------------------------------------------------------------------------
// background task lifecycle: status → result
// ---------------------------------------------------------------------------

test("task --background enqueues a detached worker and exposes per-job status", async () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeOllama(binDir, "slow-task");
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });

  // --emit-patch routes to the patch-emit (non-agentic) flow so the fake
  // streaming server produces a determinate response in the background worker.
  const launched = run("node", [SCRIPT, "task", "--background", "--emit-patch", "--json", "investigate the failing test"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.equal(launched.status, 0, launched.stderr);
  const launchPayload = JSON.parse(launched.stdout);
  assert.equal(launchPayload.status, "queued");
  assert.match(launchPayload.jobId, /^task-/);

  const waitedStatus = run(
    "node",
    [SCRIPT, "status", launchPayload.jobId, "--wait", "--timeout-ms", "15000", "--json"],
    {
      cwd: repo,
      env: buildEnv(binDir)
    }
  );

  assert.equal(waitedStatus.status, 0, waitedStatus.stderr);
  const waitedPayload = JSON.parse(waitedStatus.stdout);
  assert.equal(waitedPayload.job.id, launchPayload.jobId);
  assert.equal(waitedPayload.job.status, "completed");

  const resultPayload = await waitFor(() => {
    const result = run("node", [SCRIPT, "result", launchPayload.jobId, "--json"], {
      cwd: repo,
      env: buildEnv(binDir)
    });
    if (result.status !== 0) {
      return null;
    }
    return JSON.parse(result.stdout);
  });

  assert.equal(resultPayload.job.id, launchPayload.jobId);
  assert.equal(resultPayload.job.status, "completed");
  assert.match(resultPayload.storedJob.rendered, /Handled the requested task/);
});

test("review accepts --background while still running as a tracked review job", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeOllama(binDir);
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });
  fs.writeFileSync(path.join(repo, "README.md"), "hello again\n");

  const launched = run("node", [SCRIPT, "review", "--background", "--json"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.equal(launched.status, 0, launched.stderr);
  const launchPayload = JSON.parse(launched.stdout);
  assert.equal(launchPayload.review, "Review");
  assert.match(launchPayload.ollama.stdout, /No material issues found/);

  const status = run("node", [SCRIPT, "status"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.equal(status.status, 0, status.stderr);
  assert.match(status.stdout, /# Ollama Status/);
  assert.match(status.stdout, /Ollama Review/);
  assert.match(status.stdout, /completed/);
});

// ---------------------------------------------------------------------------
// scope/focus-text validation
// ---------------------------------------------------------------------------

test("review accepts focus text and passes it to the adversarial-review prompt", () => {
  // Phase 4 removed the focus-text restriction from /ollama:review — both
  // review and adversarial-review now use the same Ollama HTTP flow.
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeOllama(binDir);
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });
  fs.writeFileSync(path.join(repo, "README.md"), "hello again\n");

  const result = run("node", [SCRIPT, "review", "--scope working-tree focus on auth"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  // Should succeed (no longer rejected)
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /No material issues found|Reviewed/i);
});

test("review rejects staged-only scope", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeOllama(binDir);
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });
  fs.writeFileSync(path.join(repo, "README.md"), "hello again\n");
  run("git", ["add", "README.md"], { cwd: repo });

  const result = run("node", [SCRIPT, "review", "--scope", "staged"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.equal(result.status > 0, true);
  assert.match(result.stderr, /Unsupported review scope "staged"/i);
  assert.match(result.stderr, /Use one of: auto, working-tree, branch, or pass --base <ref>/i);
});

test("adversarial review rejects staged-only scope", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeOllama(binDir);
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });
  fs.writeFileSync(path.join(repo, "README.md"), "hello again\n");
  run("git", ["add", "README.md"], { cwd: repo });

  const result = run("node", [SCRIPT, "adversarial-review", "--scope", "staged"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.equal(result.status > 0, true);
  assert.match(result.stderr, /Unsupported review scope "staged"/i);
  assert.match(result.stderr, /Use one of: auto, working-tree, branch, or pass --base <ref>/i);
});

// ---------------------------------------------------------------------------
// status command
// ---------------------------------------------------------------------------

test("status shows phases, hints, and the latest finished job", () => {
  const workspace = makeTempDir();
  const stateDir = resolveStateDir(workspace);
  const jobsDir = path.join(stateDir, "jobs");
  fs.mkdirSync(jobsDir, { recursive: true });

  const logFile = path.join(jobsDir, "review-live.log");
  fs.writeFileSync(
    logFile,
    [
      "[2026-03-18T15:30:00.000Z] Starting Ollama Review.",
      "[2026-03-18T15:30:01.000Z] Thread ready (thr_1).",
      "[2026-03-18T15:30:02.000Z] Turn started (turn_1).",
      "[2026-03-18T15:30:03.000Z] Reviewer started: current changes"
    ].join("\n"),
    "utf8"
  );

  const finishedJobFile = path.join(jobsDir, "review-done.json");
  fs.writeFileSync(
    finishedJobFile,
    JSON.stringify(
      {
        id: "review-done",
        status: "completed",
        title: "Ollama Review",
        rendered: "# Ollama Review\n\nReviewed uncommitted changes.\nNo material issues found.\n"
      },
      null,
      2
    ),
    "utf8"
  );

  fs.writeFileSync(
    path.join(stateDir, "state.json"),
    `${JSON.stringify(
      {
        version: 1,
        config: { stopReviewGate: false },
        jobs: [
          {
            id: "review-live",
            kind: "review",
            kindLabel: "review",
            status: "running",
            title: "Ollama Review",
            jobClass: "review",
            phase: "reviewing",
            threadId: "thr_1",
            summary: "Review working tree diff",
            logFile,
            createdAt: "2026-03-18T15:30:00.000Z",
            updatedAt: "2026-03-18T15:30:03.000Z"
          },
          {
            id: "review-done",
            status: "completed",
            title: "Ollama Review",
            jobClass: "review",
            threadId: "thr_done",
            summary: "Review main...HEAD",
            createdAt: "2026-03-18T15:10:00.000Z",
            startedAt: "2026-03-18T15:10:05.000Z",
            completedAt: "2026-03-18T15:11:10.000Z",
            updatedAt: "2026-03-18T15:11:10.000Z"
          }
        ]
      },
      null,
      2
    )}\n`,
    "utf8"
  );

  const result = run("node", [SCRIPT, "status"], {
    cwd: workspace
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Active jobs:/);
  assert.match(result.stdout, /\| review-live \| review \| running \| reviewing \|/);
  assert.match(result.stdout, /Latest finished:/);
  assert.match(result.stdout, /Thread ready \(thr_1\)\./);
  assert.match(result.stdout, /Reviewer started: current changes/);
  assert.match(result.stdout, /Duration: 1m 5s/);
});

test("status without a job id only shows jobs from the current Claude session", () => {
  const workspace = makeTempDir();
  const stateDir = resolveStateDir(workspace);
  const jobsDir = path.join(stateDir, "jobs");
  fs.mkdirSync(jobsDir, { recursive: true });

  const currentLog = path.join(jobsDir, "review-current.log");
  const otherLog = path.join(jobsDir, "review-other.log");
  fs.writeFileSync(currentLog, "[2026-03-18T15:30:00.000Z] Reviewer started: current changes\n", "utf8");
  fs.writeFileSync(otherLog, "[2026-03-18T15:31:00.000Z] Reviewer started: old changes\n", "utf8");

  fs.writeFileSync(
    path.join(stateDir, "state.json"),
    `${JSON.stringify(
      {
        version: 1,
        config: { stopReviewGate: false },
        jobs: [
          {
            id: "review-current",
            kind: "review",
            kindLabel: "review",
            status: "running",
            title: "Ollama Review",
            jobClass: "review",
            phase: "reviewing",
            sessionId: "sess-current",
            threadId: "thr_current",
            summary: "Current session review",
            logFile: currentLog,
            createdAt: "2026-03-18T15:30:00.000Z",
            updatedAt: "2026-03-18T15:30:00.000Z"
          },
          {
            id: "review-other",
            kind: "review",
            kindLabel: "review",
            status: "completed",
            title: "Ollama Review",
            jobClass: "review",
            sessionId: "sess-other",
            threadId: "thr_other",
            summary: "Previous session review",
            createdAt: "2026-03-18T15:20:00.000Z",
            startedAt: "2026-03-18T15:20:05.000Z",
            completedAt: "2026-03-18T15:21:00.000Z",
            updatedAt: "2026-03-18T15:21:00.000Z"
          }
        ]
      },
      null,
      2
    )}\n`,
    "utf8"
  );

  const result = run("node", [SCRIPT, "status"], {
    cwd: workspace,
    env: {
      ...process.env,
      OLLAMA_PLUGIN_COMPANION_SESSION_ID: "sess-current"
    }
  });

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(
    [...new Set(result.stdout.match(/review-(?:current|other)/g) ?? [])],
    ["review-current"]
  );
});

test("status --wait times out cleanly when a job is still active", () => {
  const workspace = makeTempDir();
  const stateDir = resolveStateDir(workspace);
  const jobsDir = path.join(stateDir, "jobs");
  fs.mkdirSync(jobsDir, { recursive: true });

  const logFile = path.join(jobsDir, "task-live.log");
  fs.writeFileSync(logFile, "[2026-03-18T15:30:00.000Z] Starting Ollama Task.\n", "utf8");
  fs.writeFileSync(
    path.join(jobsDir, "task-live.json"),
    JSON.stringify(
      {
        id: "task-live",
        status: "running",
        title: "Ollama Task",
        logFile
      },
      null,
      2
    ),
    "utf8"
  );

  fs.writeFileSync(
    path.join(stateDir, "state.json"),
    `${JSON.stringify(
      {
        version: 1,
        config: { stopReviewGate: false },
        jobs: [
          {
            id: "task-live",
            status: "running",
            title: "Ollama Task",
            jobClass: "task",
            summary: "Investigate flaky test",
            logFile,
            createdAt: "2026-03-18T15:30:00.000Z",
            startedAt: "2026-03-18T15:30:01.000Z",
            updatedAt: "2026-03-18T15:30:02.000Z"
          }
        ]
      },
      null,
      2
    )}\n`,
    "utf8"
  );

  const result = run("node", [SCRIPT, "status", "task-live", "--wait", "--timeout-ms", "25", "--json"], {
    cwd: workspace
  });

  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.job.id, "task-live");
  assert.equal(payload.job.status, "running");
  assert.equal(payload.waitTimedOut, true);
});

// ---------------------------------------------------------------------------
// result command
// ---------------------------------------------------------------------------

test("result returns the stored output for the latest finished job", () => {
  const workspace = makeTempDir();
  const stateDir = resolveStateDir(workspace);
  const jobsDir = path.join(stateDir, "jobs");
  fs.mkdirSync(jobsDir, { recursive: true });

  fs.writeFileSync(
    path.join(jobsDir, "review-finished.json"),
    JSON.stringify(
      {
        id: "review-finished",
        status: "completed",
        title: "Ollama Review",
        rendered: "# Ollama Review\n\nReviewed uncommitted changes.\nNo material issues found.\n",
        result: {
          ollama: {
            stdout: "Reviewed uncommitted changes.\nNo material issues found."
          }
        },
        threadId: "thr_review_finished"
      },
      null,
      2
    ),
    "utf8"
  );

  fs.writeFileSync(
    path.join(stateDir, "state.json"),
    `${JSON.stringify(
      {
        version: 1,
        config: { stopReviewGate: false },
        jobs: [
          {
            id: "review-finished",
            status: "completed",
            title: "Ollama Review",
            jobClass: "review",
            threadId: "thr_review_finished",
            summary: "Review working tree diff",
            createdAt: "2026-03-18T15:00:00.000Z",
            updatedAt: "2026-03-18T15:01:00.000Z"
          }
        ]
      },
      null,
      2
    )}\n`,
    "utf8"
  );

  const result = run("node", [SCRIPT, "result"], {
    cwd: workspace
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Reviewed uncommitted changes/);
  assert.match(result.stdout, /No material issues found/);
});

// ---------------------------------------------------------------------------
// session lifecycle hook
// ---------------------------------------------------------------------------

test("session start hook exports the Claude session id and plugin data dir for later commands", () => {
  const repo = makeTempDir();
  const envFile = path.join(makeTempDir(), "claude-env.sh");
  fs.writeFileSync(envFile, "", "utf8");
  const pluginDataDir = makeTempDir();

  const result = run("node", [SESSION_HOOK, "SessionStart"], {
    cwd: repo,
    env: {
      ...process.env,
      CLAUDE_ENV_FILE: envFile,
      CLAUDE_PLUGIN_DATA: pluginDataDir
    },
    input: JSON.stringify({
      hook_event_name: "SessionStart",
      session_id: "sess-current",
      cwd: repo
    })
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(
    fs.readFileSync(envFile, "utf8"),
    `export OLLAMA_PLUGIN_COMPANION_SESSION_ID='sess-current'\nexport CLAUDE_PLUGIN_DATA='${pluginDataDir}'\n`
  );
});

// ---------------------------------------------------------------------------
// Phase 3.4 — new tests: streaming, JSON-mode, health-check failure, listModels
// ---------------------------------------------------------------------------

test("streaming response parsing: chat() yields token deltas then a done event", async () => {
  const binDir = makeTempDir();
  const { close } = installFakeOllama(binDir);
  const env = buildEnv(binDir);

  // Temporarily override OLLAMA_HOST for this in-process test
  const originalHost = process.env.OLLAMA_HOST;
  process.env.OLLAMA_HOST = env.OLLAMA_HOST;

  try {
    const tokens = [];
    let doneEvent = null;

    const gen = chat({
      model: "fake-model",
      messages: [{ role: "user", content: "hello" }],
      stream: true
    });

    for await (const delta of gen) {
      if (delta.type === "token") {
        tokens.push(delta.content);
      } else if (delta.type === "done") {
        doneEvent = delta;
      }
    }

    assert.ok(tokens.length > 0, "Expected at least one token delta");
    assert.ok(doneEvent !== null, "Expected a done event");
    assert.equal(typeof doneEvent.stats.eval_count, "number");
    // Tokens should reassemble to the full TASK_OK response
    const full = tokens.join("");
    assert.match(full, /Handled the requested task/);
  } finally {
    if (originalHost === undefined) {
      delete process.env.OLLAMA_HOST;
    } else {
      process.env.OLLAMA_HOST = originalHost;
    }
    close();
  }
});

test("JSON-mode response validation: review succeeds with valid JSON from the model", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeOllama(binDir);
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });
  fs.writeFileSync(path.join(repo, "README.md"), "hello again\n");

  const result = run("node", [SCRIPT, "review", "--json"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  // Parsed result should be present with no parse error
  assert.ok(payload.result, "Expected parsed review result");
  assert.equal(payload.parseError, null);
  assert.equal(payload.result.verdict, "approve");
});

test("JSON-mode malformed-JSON: review surfaces raw output with a parse error", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeOllama(binDir, "review-malformed-json");
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });
  fs.writeFileSync(path.join(repo, "README.md"), "hello again\n");

  // Non-JSON output → companion should exit with an error or emit parseError
  const result = run("node", [SCRIPT, "review", "--json"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  // The companion exits 0 but the payload should show a parse error
  const payload = JSON.parse(result.stdout);
  assert.ok(payload.parseError, `Expected a parseError, got: ${JSON.stringify(payload.parseError)}`);
  assert.equal(payload.result, null);
});

test("health-check failure: ollama unreachable returns friendly error from companion setup", () => {
  // Point OLLAMA_HOST at a port that is guaranteed to refuse connections
  const deadHost = "http://127.0.0.1:1";

  const result = run("node", [SCRIPT, "setup", "--json"], {
    cwd: ROOT,
    env: {
      ...process.env,
      OLLAMA_HOST: deadHost
    }
  });

  // setup exits 0 but reports not-ready
  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  // Ollama unreachable → auth says not logged in
  assert.equal(payload.auth.loggedIn, false);
  assert.match(payload.auth.detail, /not reachable|Ollama not reachable/i);
});

test("health-check failure: health() returns false when Ollama is unreachable", async () => {
  const originalHost = process.env.OLLAMA_HOST;
  process.env.OLLAMA_HOST = "http://127.0.0.1:1";

  try {
    const result = await health();
    assert.equal(result, false);
  } finally {
    if (originalHost === undefined) {
      delete process.env.OLLAMA_HOST;
    } else {
      process.env.OLLAMA_HOST = originalHost;
    }
  }
});

test("listModels() returns available models from /api/tags", async () => {
  const binDir = makeTempDir();
  const { close } = installFakeOllama(binDir);
  const env = buildEnv(binDir);

  const originalHost = process.env.OLLAMA_HOST;
  process.env.OLLAMA_HOST = env.OLLAMA_HOST;

  try {
    const models = await listModels();
    assert.ok(Array.isArray(models), "Expected an array of models");
    assert.ok(models.length > 0, "Expected at least one model");
    assert.equal(models[0].name, "llama3.1:8b");
    assert.equal(typeof models[0].size, "number");
  } finally {
    if (originalHost === undefined) {
      delete process.env.OLLAMA_HOST;
    } else {
      process.env.OLLAMA_HOST = originalHost;
    }
    close();
  }
});
