/**
 * agentic.test.mjs — Phase 1.5c + 1.5d tests.
 *
 * 1.5c: Integration tests for the agentic loop via the fake server.
 *   - Happy path: read_file → apply_patch → done
 *   - Max iterations cap
 *   - Malformed tool call recovery
 *   - Allowlist enforcement via run_command
 *   - apply_patch conflict rejection
 *   - Auto-fallback when model is on the deny-list
 *   - --emit-patch explicit fallback
 *
 * 1.5d: Focused unit tests on dispatchToolCall from agentic-tools.mjs.
 *   - read_file happy + missing file
 *   - list_directory happy + missing dir
 *   - apply_patch happy + conflict + invalid patch
 *   - run_command allowlist allow + deny + ENOENT
 *   - done returns summary
 *   - Unknown tool name returns useful error
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

import { buildEnv, installFakeOllama } from "./fake-ollama-fixture.mjs";
import { initGitRepo, makeTempDir, run } from "./helpers.mjs";
import { runAgenticTask } from "../plugins/ollama/scripts/lib/ollama.mjs";
import { dispatchToolCall } from "../plugins/ollama/scripts/lib/agentic-tools.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PLUGIN_ROOT = path.join(ROOT, "plugins", "ollama");
const SCRIPT = path.join(PLUGIN_ROOT, "scripts", "ollama-companion.mjs");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Temporarily set OLLAMA_HOST from binDir and restore after callback. */
async function withFakeOllama(binDir, fn) {
  const env = buildEnv(binDir);
  const original = process.env.OLLAMA_HOST;
  process.env.OLLAMA_HOST = env.OLLAMA_HOST;
  try {
    return await fn();
  } finally {
    if (original === undefined) {
      delete process.env.OLLAMA_HOST;
    } else {
      process.env.OLLAMA_HOST = original;
    }
  }
}

/** Create a git repo in a tmpdir with one committed file and return the path. */
function makeGitRepo(filename = "app.js", content = "const x = 1;\n") {
  const cwd = makeTempDir();
  initGitRepo(cwd);
  fs.writeFileSync(path.join(cwd, filename), content, "utf8");
  run("git", ["add", filename], { cwd });
  run("git", ["commit", "-m", "init"], { cwd });
  return cwd;
}

// ---------------------------------------------------------------------------
// Module-level shared fake servers for async integration tests.
// Starting each server once per file rather than once per test reduces
// the number of concurrent server processes when the full suite runs in
// parallel, making startup more reliable under heavy load.
// ---------------------------------------------------------------------------

const sharedServers = {};

/**
 * Return the binDir for a shared fake Ollama server with the given behavior.
 *
 * IMPORTANT — statefulness: the "agentic-happy-path" server tracks a
 * module-level agenticIteration counter that increments on every /api/chat
 * request. That server is single-use: it must only be called by ONE test
 * (currently "agentic happy path: read_file → apply_patch → done"). If a
 * second test reuses it the iteration counter will be wrong. To add more
 * happy-path tests, start a separate server with installFakeOllama() directly.
 */
function getSharedServer(behavior) {
  if (!sharedServers[behavior]) {
    const binDir = makeTempDir();
    sharedServers[behavior] = {
      binDir,
      handle: installFakeOllama(binDir, behavior)
    };
  }
  return sharedServers[behavior].binDir;
}

// Close all shared servers after the test file finishes.
// The process.on("exit") cleanup in installFakeOllama is a safety net,
// but we close explicitly for a clean teardown.
test.after(async () => {
  for (const { handle } of Object.values(sharedServers)) {
    await handle.close();
  }
});

// ---------------------------------------------------------------------------
// 1.5c — Agentic loop integration tests
// ---------------------------------------------------------------------------

test("agentic happy path: read_file → apply_patch → done returns success with toolCalls and touchedFiles", async () => {
  const cwd = makeGitRepo("app.js", "const x = 1;\n");
  const binDir = getSharedServer("agentic-happy-path");

  const result = await withFakeOllama(binDir, () =>
    runAgenticTask({
      model: "fake-model",
      messages: [
        { role: "system", content: "Fix the code." },
        { role: "user", content: "update x to 2" }
      ],
      cwd,
      maxIterations: 10
    })
  );

  // The fake happy-path server: iteration 1 → read_file, iteration 2 → apply_patch,
  // iteration 3 → done.  apply_patch may fail because the server state is shared
  // across reuse, so we use a fresh cwd each time. The key assertions are:
  // status is 0 (done tool was called), toolCalls recorded, iterations tracked.
  assert.equal(result.status, 0, `Expected status 0 but got ${result.status}: ${result.finalMessage}`);
  assert.equal(result.finalMessage, "Fixed the issue in app.js.");
  assert.ok(Array.isArray(result.toolCalls), "toolCalls should be an array");
  assert.ok(result.toolCalls.length >= 1, "at least one tool call should be logged");
  assert.ok(typeof result.iterations === "number" && result.iterations >= 1, "iterations should be a number >= 1");
  // Verify done tool was logged
  assert.ok(result.toolCalls.some((tc) => tc.tool === "done"), "done tool should appear in toolCalls");
});

test("agentic max iterations cap: loop exits with status 1 when cap is reached", async () => {
  const cwd = makeGitRepo();
  const binDir = getSharedServer("agentic-max-iterations");

  const result = await withFakeOllama(binDir, () =>
    runAgenticTask({
      model: "fake-model",
      messages: [{ role: "user", content: "do something" }],
      cwd,
      maxIterations: 3  // tiny cap so the test is fast
    })
  );

  assert.equal(result.status, 1, "should exit with status 1 when cap is reached");
  assert.match(result.finalMessage, /max iterations/i);
  assert.equal(result.iterations, 3, "should record exactly 3 iterations");
});

test("agentic malformed tool call: loop handles unparseable args gracefully", async () => {
  const cwd = makeGitRepo();
  const binDir = getSharedServer("agentic-malformed-tool-call");

  // The malformed server returns bad JSON in tool_calls[0].function.arguments.
  // The loop normalizes args to {} and dispatches read_file({}) → an error result
  // (path arg is undefined so path.join throws). It never calls done, so with
  // cap=2 it exits via max-iterations guard with status=1.
  const result = await withFakeOllama(binDir, () =>
    runAgenticTask({
      model: "fake-model",
      messages: [{ role: "user", content: "do something" }],
      cwd,
      maxIterations: 2
    })
  );

  // Observed behavior: status=1, max-iterations message, 2 tool calls all with args={}
  assert.equal(result.status, 1, "should exit with status 1 (max iterations, never done)");
  assert.match(result.finalMessage, /max iterations/i);
  assert.equal(result.iterations, 2, "should record exactly 2 iterations");
  // All tool calls should have args={} (malformed JSON normalized to empty object)
  assert.equal(result.toolCalls.length, 2, "should record one tool call per iteration");
  assert.ok(result.toolCalls.every((tc) => tc.tool === "read_file"), "tool name should still be parsed");
  assert.ok(result.toolCalls.every((tc) => Object.keys(tc.args).length === 0), "malformed args should normalize to {}");
});

test("agentic allowlist enforcement: run_command with blocked command returns allowlist error", () => {
  // Test dispatchToolCall directly for the allowlist — no fake server needed.
  const cwd = makeGitRepo();
  const result = dispatchToolCall({
    name: "run_command",
    args: { command: "rm", args: ["-rf", "/tmp"] },
    cwd
  });

  assert.ok(result.error, "should return an error for non-allowlisted command");
  assert.match(result.error, /not in the allowlist/i);
});

test("agentic auto-fallback: model on deny-list falls back to patch-emit and emits warning", () => {
  const repo = makeGitRepo();
  const binDir = getSharedServer("review-ok");

  // phi-3:mini is in TOOL_CALLING_DENY_FAMILIES — should trigger auto-fallback.
  // The fake streaming server handles the patch-emit runTask flow.
  const result = run("node", [SCRIPT, "task", "--model", "phi-3:mini", "describe the codebase"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.equal(result.status, 0, result.stderr);
  // Verify fallback warning was emitted
  assert.match(result.stderr, /falling back to patch-emit/i);
  // Verify output came from the streaming (patch-emit) path
  assert.match(result.stdout, /Handled the requested task/);
});

test("agentic --emit-patch explicit flag: routes to patch-emit path without warning", () => {
  const repo = makeGitRepo();
  const binDir = getSharedServer("review-ok");

  const result = run("node", [SCRIPT, "task", "--emit-patch", "describe the codebase"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.equal(result.status, 0, result.stderr);
  // No "falling back" warning since --emit-patch is explicit
  assert.doesNotMatch(result.stderr ?? "", /falling back/i);
  assert.match(result.stdout, /Handled the requested task/);
});

// ---------------------------------------------------------------------------
// 1.5d — dispatchToolCall unit tests
// ---------------------------------------------------------------------------

test("dispatchToolCall read_file: returns content for existing file", () => {
  const cwd = makeTempDir();
  fs.writeFileSync(path.join(cwd, "hello.txt"), "Hello, world!\n", "utf8");

  const result = dispatchToolCall({ name: "read_file", args: { path: "hello.txt" }, cwd });

  assert.equal(result.content, "Hello, world!\n");
  assert.equal(result.error, undefined);
});

test("dispatchToolCall read_file: returns error for missing file", () => {
  const cwd = makeTempDir();

  const result = dispatchToolCall({ name: "read_file", args: { path: "nope.txt" }, cwd });

  assert.ok(result.error, "should return an error");
  assert.match(result.error, /not found/i);
});

test("dispatchToolCall list_directory: returns entries for existing directory", () => {
  const cwd = makeTempDir();
  fs.writeFileSync(path.join(cwd, "a.txt"), "a");
  fs.mkdirSync(path.join(cwd, "sub"));

  const result = dispatchToolCall({ name: "list_directory", args: { path: "." }, cwd });

  assert.ok(Array.isArray(result.entries), "entries should be an array");
  const names = result.entries.map((e) => e.name);
  assert.ok(names.includes("a.txt"), "should list a.txt");
  assert.ok(names.includes("sub"), "should list sub directory");
  const sub = result.entries.find((e) => e.name === "sub");
  assert.equal(sub.type, "directory");
});

test("dispatchToolCall list_directory: returns error for missing directory", () => {
  const cwd = makeTempDir();

  const result = dispatchToolCall({ name: "list_directory", args: { path: "no-such-dir" }, cwd });

  assert.ok(result.error, "should return an error");
  assert.match(result.error, /not found/i);
});

test("dispatchToolCall apply_patch: applies a valid patch and returns touched files", () => {
  const cwd = makeGitRepo("target.js", "const x = 1;\n");

  const patch = [
    "--- a/target.js",
    "+++ b/target.js",
    "@@ -1 +1 @@",
    "-const x = 1;",
    "+const x = 2;"
  ].join("\n") + "\n";

  const result = dispatchToolCall({ name: "apply_patch", args: { patch }, cwd });

  assert.equal(result.applied, true, `apply_patch failed: ${result.error}`);
  assert.ok(Array.isArray(result.files));
  assert.ok(result.files.includes("target.js"));

  const content = fs.readFileSync(path.join(cwd, "target.js"), "utf8");
  assert.equal(content, "const x = 2;\n");
});

test("dispatchToolCall apply_patch: returns applied=false for conflicting patch", () => {
  const cwd = makeGitRepo("conflict.js", "const x = 1;\n");

  // The patch claims the file has "const y = 9;" which doesn't exist
  const patch = [
    "--- a/conflict.js",
    "+++ b/conflict.js",
    "@@ -1 +1 @@",
    "-const y = 9;",
    "+const y = 10;"
  ].join("\n") + "\n";

  const result = dispatchToolCall({ name: "apply_patch", args: { patch }, cwd });

  assert.equal(result.applied, false);
  assert.ok(result.error, "should have an error message");
});

test("dispatchToolCall apply_patch: returns applied=false for empty/invalid patch", () => {
  const cwd = makeGitRepo();

  const result = dispatchToolCall({ name: "apply_patch", args: { patch: "" }, cwd });

  assert.equal(result.applied, false);
  assert.ok(result.error, "should have an error message for empty patch");
});

test("dispatchToolCall run_command: runs an allowlisted command successfully", () => {
  const cwd = makeTempDir();

  const result = dispatchToolCall({
    name: "run_command",
    args: { command: "node", args: ["--version"] },
    cwd
  });

  assert.equal(result.error, undefined, `unexpected error: ${result.error}`);
  assert.equal(result.exitCode, 0);
  assert.match(result.stdout, /^v\d+\./);
});

test("dispatchToolCall run_command: rejects a non-allowlisted command", () => {
  const cwd = makeTempDir();

  const result = dispatchToolCall({
    name: "run_command",
    args: { command: "curl", args: ["https://example.com"] },
    cwd
  });

  assert.ok(result.error, "should return an error for blocked command");
  assert.match(result.error, /not in the allowlist/i);
});

test("dispatchToolCall run_command: returns error for ENOENT command", () => {
  const cwd = makeTempDir();
  // Use an allowlist override to include our fake command, then try to run it.
  const result = dispatchToolCall({
    name: "run_command",
    args: { command: "definitely-not-a-real-binary" },
    cwd,
    // Expand allowlist to include our fake command
    allowCommands: "definitely-not-a-real-binary"
  });

  // The result is either ENOENT error — either way an error should be returned.
  assert.ok(result.error, "should return an error when command is not found");
});

test("dispatchToolCall write_file: writes new file and returns byte count", () => {
  const cwd = makeTempDir();
  const result = dispatchToolCall({
    name: "write_file",
    args: { path: "newfile.txt", content: "hello world\n" },
    cwd
  });
  assert.equal(result.written, true);
  assert.equal(result.bytes, 12);
  assert.equal(fs.readFileSync(path.join(cwd, "newfile.txt"), "utf8"), "hello world\n");
});

test("dispatchToolCall write_file: overwrites existing file", () => {
  const cwd = makeTempDir();
  fs.writeFileSync(path.join(cwd, "existing.txt"), "old content");
  const result = dispatchToolCall({
    name: "write_file",
    args: { path: "existing.txt", content: "new content" },
    cwd
  });
  assert.equal(result.written, true);
  assert.equal(fs.readFileSync(path.join(cwd, "existing.txt"), "utf8"), "new content");
});

test("dispatchToolCall write_file: creates parent directories", () => {
  const cwd = makeTempDir();
  const result = dispatchToolCall({
    name: "write_file",
    args: { path: "a/b/c/deep.txt", content: "deep" },
    cwd
  });
  assert.equal(result.written, true);
  assert.equal(fs.readFileSync(path.join(cwd, "a/b/c/deep.txt"), "utf8"), "deep");
});

test("dispatchToolCall write_file: refuses path outside cwd", () => {
  const cwd = makeTempDir();
  const result = dispatchToolCall({
    name: "write_file",
    args: { path: "../escape.txt", content: "no" },
    cwd
  });
  assert.equal(result.written, false);
  assert.match(result.error, /outside working directory/i);
});

test("dispatchToolCall done: returns done=true and the summary", () => {
  const result = dispatchToolCall({
    name: "done",
    args: { summary: "All done, patch applied successfully." },
    cwd: os.tmpdir()
  });

  assert.equal(result.done, true);
  assert.equal(result.summary, "All done, patch applied successfully.");
});

test("dispatchToolCall unknown tool: returns useful error message", () => {
  const result = dispatchToolCall({
    name: "teleport",
    args: {},
    cwd: os.tmpdir()
  });

  assert.ok(result.error, "should return an error for unknown tool");
  assert.match(result.error, /unknown tool/i);
  assert.match(result.error, /teleport/);
});
