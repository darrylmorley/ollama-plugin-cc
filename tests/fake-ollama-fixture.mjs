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
 *   await close();   // close() returns a Promise; await in t.after()
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

// Increase the max listeners limit so many tests can each install an exit
// cleanup handler without triggering the Node.js MaxListenersExceededWarning.
// Each installFakeOllama() call adds one "exit" listener.
process.setMaxListeners(Math.max(process.getMaxListeners(), 50));

/**
 * Synchronous sleep using Atomics.wait on a SharedArrayBuffer.
 * This yields to the OS scheduler without busy-spinning or spawning processes.
 * @param {number} ms  Milliseconds to sleep.
 */
function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Start a fake Ollama HTTP server as a background child process and
 * write its URL to binDir/ollama-host.txt.
 *
 * Readiness detection: the server writes the host URL to FAKE_OLLAMA_HOST_FILE
 * when it starts listening. We poll that file synchronously.
 *
 * Fixture leak prevention: child.unref() + stream.unref() so the parent's
 * event loop can exit as soon as all tests finish, without waiting for the
 * background server to be killed.  The close() method (or the process.on("exit")
 * cleanup handler) terminates the server via SIGTERM/SIGKILL.
 *
 * @param {string} binDir  Temp directory created by the test (used to store the URL).
 * @param {string} [behavior]  Controls what canned responses are emitted.
 * @returns {{ close: () => Promise<void> }}
 */
export function installFakeOllama(binDir, behavior = "review-ok") {
  const hostFile = path.join(binDir, HOST_FILE);

  const child = spawn(process.execPath, [SERVER_SCRIPT], {
    env: {
      ...process.env,
      FAKE_OLLAMA_BEHAVIOR: behavior,
      FAKE_OLLAMA_HOST_FILE: hostFile
    },
    stdio: ["pipe", "pipe", "pipe"],
    detached: false
  });

  // Capture PID before unref so we can still send signals.
  const pid = child.pid;

  // Wait synchronously for the host file.
  // sleepSync(10) yields to the OS scheduler so the child process gets CPU
  // time to start its HTTP server, even when many tests run in parallel.
  const deadline = Date.now() + 15000; // 15s — generous for parallel suites
  let ready = false;
  while (Date.now() < deadline) {
    if (fs.existsSync(hostFile)) {
      const content = fs.readFileSync(hostFile, "utf8").trim();
      if (content.startsWith("http://")) {
        ready = true;
        break;
      }
    }
    sleepSync(10); // 10ms — yields CPU to child process
  }

  if (!ready) {
    try { child.kill("SIGKILL"); } catch { /* ignore */ }
    throw new Error(`Fake Ollama server did not start within 10s (behavior="${behavior}")`);
  }

  // After startup, unref everything so no open handle keeps the parent's
  // event loop alive after all tests complete.
  try { child.stdout?.unref(); } catch { /* ignore */ }
  try { child.stderr?.unref(); } catch { /* ignore */ }
  try { child.stdin?.unref(); } catch { /* ignore */ }
  child.unref();

  if (process.env.FAKE_OLLAMA_DEBUG) {
    child.stderr?.on("data", (data) => process.stderr.write(`[fake-ollama] ${data}`));
  }

  // process.on("exit") cleanup — fires when the parent exits.
  const cleanup = () => {
    try { process.kill(pid, "SIGTERM"); } catch { /* ignore */ }
  };
  process.on("exit", cleanup);

  return {
    /**
     * Shut down the fake server.
     * Returns a Promise that resolves once the server process has exited.
     * Falls back to SIGKILL after 2s.
     */
    close: () => {
      process.off("exit", cleanup);
      return new Promise((resolve) => {
        // Attempt SIGTERM
        try { process.kill(pid, "SIGTERM"); } catch { /* already gone */ return resolve(); }

        // Poll until dead or 2s, then SIGKILL.
        // Keep the interval ref'd so it holds the event loop alive during teardown.
        const startMs = Date.now();
        const interval = setInterval(() => {
          let alive = true;
          try {
            process.kill(pid, 0); // throws ESRCH when process is gone
          } catch {
            alive = false;
          }
          if (!alive || Date.now() - startMs > 2000) {
            clearInterval(interval);
            if (alive) {
              try { process.kill(pid, "SIGKILL"); } catch { /* ignore */ }
            }
            resolve();
          }
        }, 30);
      });
    }
  };
}

/**
 * Build environment variables for a test invocation.
 * Reads the OLLAMA_HOST from binDir and injects it.
 */
export function buildEnv(binDir) {
  const hostFile = path.join(binDir, HOST_FILE);
  let host = null;
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    if (fs.existsSync(hostFile)) {
      host = fs.readFileSync(hostFile, "utf8").trim();
      if (host) break;
    }
    sleepSync(10);
  }
  if (!host) {
    throw new Error(`Fake Ollama server URL not found in ${hostFile}. Did you call installFakeOllama first?`);
  }
  return {
    ...process.env,
    OLLAMA_HOST: host
  };
}
