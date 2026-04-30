/**
 * Fake Ollama HTTP server fixture for tests.
 *
 * Replaces the old Codex JSON-RPC binary emulator with a real HTTP server
 * that serves canned responses on /api/chat, /api/tags, and /api/pull.
 *
 * The HTTP server runs in a SEPARATE CHILD PROCESS so that spawnSync calls
 * in the test body do not block the event loop and prevent the server from
 * accepting connections.
 *
 * Usage:
 *   const { close } = installFakeOllama(binDir, "review-ok");
 *   // run tests …
 *   close();
 *
 * buildEnv(binDir) injects OLLAMA_HOST so the companion points at the server.
 */

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { spawnSync, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const SERVER_SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), "fake-ollama-server.mjs");
const HOST_FILE = "ollama-host.txt";

/**
 * Start a fake Ollama HTTP server as a background child process and
 * write its URL to binDir/ollama-host.txt.
 *
 * @param {string} binDir  Temp directory created by the test (used to store the URL).
 * @param {string} [behavior]  Controls what canned responses are emitted.
 * @returns {{ close: () => void }}
 */
export function installFakeOllama(binDir, behavior = "review-ok") {
  const hostFile = path.join(binDir, HOST_FILE);

  // Spawn the server as a detached child process.
  // We keep stdin open via a pipe so that closing the pipe terminates the server.
  const child = spawn(process.execPath, [SERVER_SCRIPT], {
    env: {
      ...process.env,
      FAKE_OLLAMA_BEHAVIOR: behavior,
      FAKE_OLLAMA_HOST_FILE: hostFile
    },
    stdio: ["pipe", "pipe", "pipe"],
    detached: false
  });

  child.stderr.on("data", (data) => {
    // Suppress stderr in tests unless debugging
    if (process.env.FAKE_OLLAMA_DEBUG) {
      process.stderr.write(`[fake-ollama] ${data}`);
    }
  });

  // Wait synchronously for the server to be ready (it writes the host file
  // and prints READY: to stdout).  We poll the host file — this is safe
  // because the server is a separate process and its event loop is running.
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (fs.existsSync(hostFile)) {
      const content = fs.readFileSync(hostFile, "utf8").trim();
      if (content.startsWith("http://")) {
        break;
      }
    }
    // Small spin — acceptable because the server starts in <100ms
    const end = Date.now() + 10;
    while (Date.now() < end) { /* spin */ }
  }

  if (!fs.existsSync(hostFile) || !fs.readFileSync(hostFile, "utf8").trim()) {
    child.kill();
    throw new Error(`Fake Ollama server did not start within 5s (behavior="${behavior}")`);
  }

  // Ensure cleanup on test process exit
  const cleanup = () => {
    try { child.kill("SIGTERM"); } catch { /* ignore */ }
  };
  process.on("exit", cleanup);

  return {
    close: () => {
      try { child.kill("SIGTERM"); } catch { /* ignore */ }
      process.off("exit", cleanup);
    }
  };
}

/**
 * Build environment variables for a test invocation.
 * Reads the OLLAMA_HOST from binDir and injects it.
 */
export function buildEnv(binDir) {
  const hostFile = path.join(binDir, HOST_FILE);
  // Poll briefly in case the server hasn't written the file yet
  let host = null;
  const deadline = Date.now() + 2000;
  while (Date.now() < deadline) {
    if (fs.existsSync(hostFile)) {
      host = fs.readFileSync(hostFile, "utf8").trim();
      if (host) break;
    }
    // Busy-wait in small increments — safe because server is a separate process
    const until = Date.now() + 10;
    while (Date.now() < until) { /* spin */ }
  }
  if (!host) {
    throw new Error(`Fake Ollama server URL not found in ${hostFile}. Did you call installFakeOllama first?`);
  }
  return {
    ...process.env,
    OLLAMA_HOST: host
  };
}
