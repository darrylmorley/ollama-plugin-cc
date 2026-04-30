/**
 * Agentic rescue tools — definitions and dispatcher.
 *
 * Provides:
 *   buildToolSchemas()       — Ollama-format tool-calling schema array
 *   dispatchToolCall(...)    — execute a named tool, always returns JSON-safe value
 *
 * All tools return a plain object or string. They NEVER throw — errors are
 * surfaced as { error: "..." } so the model can recover gracefully.
 */

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

// ---------------------------------------------------------------------------
// Allowlist
// ---------------------------------------------------------------------------

/** Commands always permitted in run_command. */
const DEFAULT_ALLOWLIST = new Set([
  "git", "npm", "bun", "pnpm", "yarn", "cargo",
  "node", "python", "python3", "pytest", "jest",
  "tsc", "eslint", "prettier", "make",
  "ls", "cat", "head", "tail", "grep", "rg", "find", "wc"
]);

/**
 * Resolve the effective command allowlist from:
 *   1. The default set above
 *   2. OLLAMA_PLUGIN_RESCUE_ALLOW_COMMANDS env var (or the allowCommands arg)
 *
 * Returns `null` if unrestricted ("*"), otherwise a Set<string>.
 *
 * @param {string | undefined} override  - CSV or "*"
 * @returns {Set<string> | null}
 */
function resolveAllowlist(override) {
  const raw = override ?? process.env.OLLAMA_PLUGIN_RESCUE_ALLOW_COMMANDS ?? "";
  if (raw.trim() === "*") {
    return null; // unrestricted
  }
  const extra = raw.split(",").map((s) => s.trim()).filter(Boolean);
  if (extra.length === 0) {
    return DEFAULT_ALLOWLIST;
  }
  return new Set([...DEFAULT_ALLOWLIST, ...extra]);
}

// ---------------------------------------------------------------------------
// Tool implementations
// ---------------------------------------------------------------------------

/** Max bytes read_file will return before truncating. */
const READ_FILE_MAX_BYTES = 256 * 1024; // 256 KB

/** Max bytes captured from run_command stdout/stderr each. */
const RUN_COMMAND_MAX_OUTPUT = 64 * 1024; // 64 KB

/**
 * read_file — return contents of a file.
 * @param {{ path: string }} args
 * @param {{ cwd: string }} ctx
 */
function toolReadFile({ path: filePath }, { cwd }) {
  try {
    const resolved = path.resolve(cwd, filePath);
    if (!fs.existsSync(resolved)) {
      return { error: `File not found: ${filePath}` };
    }
    const stat = fs.statSync(resolved);
    if (!stat.isFile()) {
      return { error: `Not a file: ${filePath}` };
    }
    const size = stat.size;
    if (size > READ_FILE_MAX_BYTES) {
      // Read only the first READ_FILE_MAX_BYTES bytes
      const fd = fs.openSync(resolved, "r");
      const buf = Buffer.allocUnsafe(READ_FILE_MAX_BYTES);
      const bytesRead = fs.readSync(fd, buf, 0, READ_FILE_MAX_BYTES, 0);
      fs.closeSync(fd);
      const content = buf.slice(0, bytesRead).toString("utf8");
      return {
        content,
        truncated: true,
        totalBytes: size,
        returnedBytes: bytesRead
      };
    }
    const content = fs.readFileSync(resolved, "utf8");
    return { content };
  } catch (err) {
    return { error: err.message };
  }
}

/**
 * list_directory — return entries of a directory.
 * @param {{ path: string }} args
 * @param {{ cwd: string }} ctx
 */
function toolListDirectory({ path: dirPath }, { cwd }) {
  try {
    const resolved = path.resolve(cwd, dirPath);
    if (!fs.existsSync(resolved)) {
      return { error: `Directory not found: ${dirPath}` };
    }
    const stat = fs.statSync(resolved);
    if (!stat.isDirectory()) {
      return { error: `Not a directory: ${dirPath}` };
    }
    const names = fs.readdirSync(resolved);
    const entries = names.map((name) => {
      try {
        const s = fs.statSync(path.join(resolved, name));
        return { name, type: s.isDirectory() ? "directory" : "file" };
      } catch {
        return { name, type: "unknown" };
      }
    });
    return { entries };
  } catch (err) {
    return { error: err.message };
  }
}

/**
 * apply_patch — apply a unified diff using `git apply`.
 * Checks first with --check; rejects on conflict (no --3way, no --reject).
 *
 * @param {{ patch: string }} args
 * @param {{ cwd: string }} ctx
 */
function toolApplyPatch({ patch }, { cwd }) {
  if (!patch || typeof patch !== "string" || !patch.trim()) {
    return { applied: false, error: "Patch is empty or not a string." };
  }

  // Step 1: dry-run check
  const check = spawnSync("git", ["apply", "--check"], {
    input: patch,
    cwd,
    encoding: "utf8",
    timeout: 15_000
  });

  if (check.status !== 0) {
    const errText = (check.stderr || check.stdout || "").trim();
    return { applied: false, error: errText || "git apply --check failed (conflict or invalid patch)." };
  }

  // Step 2: extract touched filenames from the patch headers
  const touchedFiles = [];
  for (const line of patch.split("\n")) {
    // Unified diff: "--- a/path" and "+++ b/path" lines
    const match = line.match(/^\+\+\+ b\/(.+)/);
    if (match) {
      touchedFiles.push(match[1]);
    }
  }

  // Step 3: apply
  const apply = spawnSync("git", ["apply"], {
    input: patch,
    cwd,
    encoding: "utf8",
    timeout: 15_000
  });

  if (apply.status !== 0) {
    const errText = (apply.stderr || apply.stdout || "").trim();
    return { applied: false, error: errText || "git apply failed." };
  }

  return { applied: true, files: touchedFiles };
}

/**
 * run_command — spawn an allowlisted command.
 *
 * @param {{ command: string, args?: string[] }} args
 * @param {{ cwd: string, allowCommands?: string, signal?: AbortSignal }} ctx
 */
function toolRunCommand({ command, args: cmdArgs = [] }, { cwd, allowCommands, signal }) {
  if (!command || typeof command !== "string") {
    return { error: "command must be a non-empty string." };
  }

  const allowlist = resolveAllowlist(allowCommands);
  if (allowlist !== null && !allowlist.has(command)) {
    return {
      error: `Command "${command}" is not in the allowlist. Allowed commands: ${[...allowlist].sort().join(", ")}. To expand the allowlist, set OLLAMA_PLUGIN_RESCUE_ALLOW_COMMANDS=cmd1,cmd2 or =* for unrestricted.`
    };
  }

  if (!Array.isArray(cmdArgs)) {
    return { error: "args must be an array of strings." };
  }

  const stringArgs = cmdArgs.map(String);

  let timedOut = false;
  const result = spawnSync(command, stringArgs, {
    cwd,
    encoding: "utf8",
    timeout: 60_000,
    // signal is passed for cancellation awareness — spawnSync doesn't support
    // AbortSignal natively before Node 21, but we check after the fact.
    shell: false
  });

  if (result.error) {
    if (result.error.code === "ETIMEDOUT") {
      timedOut = true;
    } else if (result.error.code === "ENOENT") {
      return { error: `Command not found: ${command}` };
    } else {
      return { error: result.error.message };
    }
  }

  // Truncate large outputs to protect the model's context window
  function truncate(text, limit) {
    if (!text) return "";
    if (text.length <= limit) return text;
    return text.slice(0, limit) + `\n[... truncated, ${text.length - limit} bytes omitted]`;
  }

  return {
    exitCode: result.status ?? null,
    stdout: truncate(result.stdout ?? "", RUN_COMMAND_MAX_OUTPUT),
    stderr: truncate(result.stderr ?? "", RUN_COMMAND_MAX_OUTPUT),
    timedOut
  };
}

/**
 * done — signals successful completion of the agentic loop.
 * Returns the summary so the loop can use it as the final message.
 *
 * @param {{ summary: string }} args
 */
function toolDone({ summary }) {
  return { done: true, summary: String(summary ?? "") };
}

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

/**
 * Dispatch a tool call by name.
 *
 * @param {{
 *   name: string,
 *   args: object,
 *   cwd: string,
 *   allowCommands?: string,
 *   signal?: AbortSignal
 * }} options
 * @returns {unknown}  Always a JSON-serializable value.
 */
export function dispatchToolCall({ name, args, cwd, allowCommands, signal }) {
  const ctx = { cwd, allowCommands, signal };

  try {
    switch (name) {
      case "read_file":
        return toolReadFile(args, ctx);
      case "list_directory":
        return toolListDirectory(args, ctx);
      case "apply_patch":
        return toolApplyPatch(args, ctx);
      case "run_command":
        return toolRunCommand(args, ctx);
      case "done":
        return toolDone(args);
      default:
        return { error: `Unknown tool: "${name}". Available tools: read_file, list_directory, apply_patch, run_command, done.` };
    }
  } catch (err) {
    // Absolute last resort — no tool should throw, but guard anyway
    return { error: `Tool "${name}" threw unexpectedly: ${err.message}` };
  }
}

// ---------------------------------------------------------------------------
// Ollama tool schema (function-calling format)
// ---------------------------------------------------------------------------

/**
 * Return the array of tool definitions in Ollama's tool-calling format.
 * @returns {Array<object>}
 */
export function buildToolSchemas() {
  return [
    {
      type: "function",
      function: {
        name: "read_file",
        description: "Read the contents of a file. Returns the content as a string, or an error object if the file cannot be read. Large files are truncated at 256 KB with a marker.",
        parameters: {
          type: "object",
          required: ["path"],
          properties: {
            path: {
              type: "string",
              description: "Path to the file to read, relative to the working directory or absolute."
            }
          }
        }
      }
    },
    {
      type: "function",
      function: {
        name: "list_directory",
        description: "List the entries of a directory. Returns an array of { name, type } objects where type is 'file' or 'directory'.",
        parameters: {
          type: "object",
          required: ["path"],
          properties: {
            path: {
              type: "string",
              description: "Path to the directory to list, relative to the working directory or absolute."
            }
          }
        }
      }
    },
    {
      type: "function",
      function: {
        name: "apply_patch",
        description: "Apply a unified diff (patch) to the working tree using `git apply`. Returns { applied: true, files: [...] } on success, or { applied: false, error: '...' } if the patch conflicts or is invalid. Does NOT force-apply — rejects on conflict.",
        parameters: {
          type: "object",
          required: ["patch"],
          properties: {
            patch: {
              type: "string",
              description: "A valid unified diff string (output of `git diff` or `diff -u`). Must be applicable without conflicts."
            }
          }
        }
      }
    },
    {
      type: "function",
      function: {
        name: "run_command",
        description: "Run an allowlisted shell command and return its stdout, stderr, and exit code. The allowlist includes common dev tools (git, npm, bun, node, python, etc.). Returns { exitCode, stdout, stderr, timedOut }.",
        parameters: {
          type: "object",
          required: ["command"],
          properties: {
            command: {
              type: "string",
              description: "The command to run (e.g. 'git', 'npm', 'bun'). Must be in the allowlist."
            },
            args: {
              type: "array",
              items: { type: "string" },
              description: "Arguments to pass to the command (e.g. ['status', '--short'])."
            }
          }
        }
      }
    },
    {
      type: "function",
      function: {
        name: "done",
        description: "Signal that the rescue task is complete. Call this when you have finished all necessary changes and verified the result. The summary becomes the final user-facing message.",
        parameters: {
          type: "object",
          required: ["summary"],
          properties: {
            summary: {
              type: "string",
              description: "A concise summary of what was done, what was changed, and any important notes for the user."
            }
          }
        }
      }
    }
  ];
}
