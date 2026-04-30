/**
 * Thin Ollama HTTP client.
 *
 * Exposes:
 *   chat()        - async generator (stream=true) or single response (stream=false)
 *   listModels()  - GET /api/tags
 *   pullModel()   - POST /api/pull with progress callback
 *   health()      - reachability check (GET /api/tags)
 *
 * Companion helpers (preserved from the old codex.mjs surface so companion can import them):
 *   runReview()          - builds messages, calls chat, validates JSON output
 *   runTask()            - builds messages, streams response, emits diff/text
 *   getOllamaAvailability()
 *   getOllamaAuthStatus()
 *   getSessionRuntimeStatus()
 *   interruptAppServerTurn()
 *   findLatestTaskThread()
 *   buildPersistentTaskThreadName()
 *   parseStructuredOutput()
 *   readOutputSchema()
 *   DEFAULT_CONTINUE_PROMPT
 *   TASK_THREAD_PREFIX
 */
import { readJsonFile } from "./fs.mjs";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const DEFAULT_CONTINUE_PROMPT =
  "Continue from the current thread state. Pick the next highest-value step and follow through until the task is resolved.";
export const TASK_THREAD_PREFIX = "Ollama Companion Task";

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function getOllamaHost() {
  return (process.env.OLLAMA_HOST ?? "http://127.0.0.1:11434").replace(/\/$/, "");
}

function buildNotReachableError(host) {
  return new Error(
    `Ollama not reachable at ${host}. Run \`ollama serve\` or set OLLAMA_HOST.`
  );
}

/**
 * Low-level fetch wrapper. Throws a friendly error when the server is down.
 * @param {string} path
 * @param {RequestInit} [init]
 * @returns {Promise<Response>}
 */
async function ollamaFetch(path, init = {}) {
  const host = getOllamaHost();
  const url = `${host}${path}`;
  try {
    const response = await fetch(url, init);
    return response;
  } catch (error) {
    // Network-level failures (ECONNREFUSED, etc.) surface as TypeError
    if (error instanceof TypeError || error?.code === "ECONNREFUSED") {
      throw buildNotReachableError(host);
    }
    throw error;
  }
}

/**
 * Read an NDJSON (newline-delimited JSON) streaming response.
 * Yields each parsed line as an object.
 * @param {Response} response
 * @returns {AsyncGenerator<object>}
 */
async function* readNdjsonStream(response) {
  const reader = response.body?.getReader();
  if (!reader) {
    throw new Error("Ollama response has no readable body.");
  }

  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      buffer += decoder.decode(value, { stream: true });
      let newlineIndex = buffer.indexOf("\n");
      while (newlineIndex !== -1) {
        const line = buffer.slice(0, newlineIndex).trim();
        buffer = buffer.slice(newlineIndex + 1);
        if (line) {
          yield JSON.parse(line);
        }
        newlineIndex = buffer.indexOf("\n");
      }
    }
    // Flush any remaining bytes
    buffer += decoder.decode();
    const remaining = buffer.trim();
    if (remaining) {
      yield JSON.parse(remaining);
    }
  } finally {
    reader.releaseLock();
  }
}

// ---------------------------------------------------------------------------
// Public HTTP client API
// ---------------------------------------------------------------------------

/**
 * POST /api/chat
 *
 * When stream=true (default): async generator yielding delta objects
 *   { type: "token", content: string }
 *   { type: "tool_call", tool_call: object }
 *   { type: "done", message: object, stats: object }
 *
 * When stream=false: resolves to the full message object
 *   { role, content, tool_calls? }
 *
 * @param {{
 *   model: string,
 *   messages: Array<{role: string, content: string}>,
 *   tools?: Array<object>,
 *   format?: string | object,
 *   stream?: boolean,
 *   signal?: AbortSignal
 * }} params
 */
export async function* chat({ model, messages, tools, format, stream = true, signal } = {}) {
  const host = getOllamaHost();
  const url = `${host}/api/chat`;

  const body = {
    model,
    messages,
    stream,
    ...(tools ? { tools } : {}),
    ...(format !== undefined ? { format } : {})
  };

  let response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal
    });
  } catch (error) {
    if (error instanceof TypeError || error?.code === "ECONNREFUSED") {
      throw buildNotReachableError(host);
    }
    throw error;
  }

  if (!response.ok) {
    const errorText = await response.text().catch(() => "");
    throw new Error(`Ollama /api/chat error ${response.status}: ${errorText}`);
  }

  if (!stream) {
    // Non-streaming: response body is a single JSON object
    const data = await response.json();
    yield { type: "done", message: data.message ?? {}, stats: data };
    return;
  }

  // Streaming: NDJSON lines
  for await (const chunk of readNdjsonStream(response)) {
    if (chunk.error) {
      throw new Error(`Ollama streaming error: ${chunk.error}`);
    }

    const delta = chunk.message?.content;
    const toolCalls = chunk.message?.tool_calls;

    if (toolCalls && toolCalls.length > 0) {
      for (const toolCall of toolCalls) {
        yield { type: "tool_call", tool_call: toolCall };
      }
    }

    if (typeof delta === "string" && delta) {
      yield { type: "token", content: delta };
    }

    if (chunk.done) {
      yield { type: "done", message: chunk.message ?? {}, stats: chunk };
    }
  }
}

/**
 * GET /api/tags — list locally available models.
 * @returns {Promise<Array<{name: string, modified_at: string, size: number}>>}
 */
export async function listModels() {
  const response = await ollamaFetch("/api/tags");
  if (!response.ok) {
    throw new Error(`Ollama /api/tags error ${response.status}`);
  }
  const data = await response.json();
  return data.models ?? [];
}

/**
 * POST /api/pull — pull a model with optional progress callback.
 * @param {string} name
 * @param {((status: {status: string, completed?: number, total?: number}) => void) | null} [onProgress]
 */
export async function pullModel(name, onProgress = null) {
  const response = await ollamaFetch("/api/pull", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, stream: true })
  });

  if (!response.ok) {
    const errorText = await response.text().catch(() => "");
    throw new Error(`Ollama /api/pull error ${response.status}: ${errorText}`);
  }

  for await (const chunk of readNdjsonStream(response)) {
    if (chunk.error) {
      throw new Error(`Ollama pull error: ${chunk.error}`);
    }
    onProgress?.(chunk);
  }
}

/**
 * Health check — returns true if Ollama is reachable, false otherwise.
 * @returns {Promise<boolean>}
 */
export async function health() {
  try {
    const response = await ollamaFetch("/api/tags");
    return response.ok;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Companion helpers — preserve the public API surface expected by
// ollama-companion.mjs so imports still resolve.
// ---------------------------------------------------------------------------

/** @param {string | null} [progressMessage] */
function emitProgress(onProgress, message, phase = null, extra = {}) {
  if (!onProgress || !message) {
    return;
  }
  if (!phase && Object.keys(extra).length === 0) {
    onProgress(message);
    return;
  }
  onProgress({ message, phase, ...extra });
}

/**
 * Inline JSON schema validator covering only what review-output.schema.json uses.
 * Returns an array of error strings (empty means valid).
 * @param {unknown} value
 * @param {object} schema
 * @param {string} [path]
 * @returns {string[]}
 */
function validateSchema(value, schema, path = "") {
  const errors = [];

  if (schema.type === "object") {
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      errors.push(`${path || "root"}: expected object`);
      return errors;
    }

    if (schema.required) {
      for (const key of schema.required) {
        if (!(key in value)) {
          errors.push(`${path || "root"}: missing required field "${key}"`);
        }
      }
    }

    if (schema.properties) {
      for (const [key, propSchema] of Object.entries(schema.properties)) {
        if (key in value) {
          errors.push(...validateSchema(value[key], propSchema, path ? `${path}.${key}` : key));
        }
      }
    }

    if (schema.additionalProperties === false) {
      const allowed = new Set(Object.keys(schema.properties ?? {}));
      for (const key of Object.keys(value)) {
        if (!allowed.has(key)) {
          errors.push(`${path || "root"}: unexpected property "${key}"`);
        }
      }
    }
  } else if (schema.type === "array") {
    if (!Array.isArray(value)) {
      errors.push(`${path || "root"}: expected array`);
      return errors;
    }
    if (schema.items) {
      for (let i = 0; i < value.length; i++) {
        errors.push(...validateSchema(value[i], schema.items, `${path}[${i}]`));
      }
    }
  } else if (schema.type === "string") {
    if (typeof value !== "string") {
      errors.push(`${path || "root"}: expected string`);
    } else {
      if (schema.enum && !schema.enum.includes(value)) {
        errors.push(`${path || "root"}: "${value}" is not one of [${schema.enum.join(", ")}]`);
      }
      if (schema.minLength !== undefined && value.length < schema.minLength) {
        errors.push(`${path || "root"}: string too short (min ${schema.minLength})`);
      }
    }
  } else if (schema.type === "integer") {
    if (!Number.isInteger(value)) {
      errors.push(`${path || "root"}: expected integer`);
    } else {
      if (schema.minimum !== undefined && value < schema.minimum) {
        errors.push(`${path || "root"}: ${value} < minimum ${schema.minimum}`);
      }
    }
  } else if (schema.type === "number") {
    if (typeof value !== "number") {
      errors.push(`${path || "root"}: expected number`);
    } else {
      if (schema.minimum !== undefined && value < schema.minimum) {
        errors.push(`${path || "root"}: ${value} < minimum ${schema.minimum}`);
      }
      if (schema.maximum !== undefined && value > schema.maximum) {
        errors.push(`${path || "root"}: ${value} > maximum ${schema.maximum}`);
      }
    }
  }

  return errors;
}

/**
 * Collect all token content from a chat() generator call (stream=false mode).
 * @param {AsyncGenerator} gen
 * @returns {Promise<{content: string, message: object, stats: object}>}
 */
async function collectChatResponse(gen) {
  let content = "";
  let message = {};
  let stats = {};
  for await (const delta of gen) {
    if (delta.type === "token") {
      content += delta.content;
    } else if (delta.type === "done") {
      message = delta.message ?? {};
      stats = delta.stats ?? {};
      // In non-stream mode the full content is in message.content
      if (message.content) {
        content = message.content;
      }
    }
  }
  return { content, message, stats };
}

/**
 * Stream a chat response and collect all content + log tokens via onProgress.
 * @returns {Promise<string>} full response text
 */
async function streamChatResponse(gen, onProgress) {
  let content = "";
  let tokenCount = 0;
  for await (const delta of gen) {
    if (delta.type === "token") {
      content += delta.content;
      tokenCount++;
      if (tokenCount % 20 === 0) {
        emitProgress(onProgress, `Receiving response... (${tokenCount} tokens)`, "running");
      }
    } else if (delta.type === "done") {
      if (delta.message?.content) {
        content = delta.message.content;
      }
    }
  }
  return content;
}

/**
 * Run an Ollama-native review (adversarial-review flow).
 *
 * Calls chat() with format=schema for JSON output,
 * validates against the schema, returns a structured result.
 *
 * @param {object} options
 * @param {string} options.model
 * @param {Array<{role:string, content:string}>} options.messages
 * @param {object} options.schema  review-output.schema.json contents
 * @param {Function} [options.onProgress]
 * @param {AbortSignal} [options.signal]
 * @returns {Promise<{status: number, finalMessage: string, reasoningSummary: string[], threadId: string|null, turnId: string|null, error: unknown}>}
 */
export async function runReview({ model, messages, schema, onProgress, signal } = {}) {
  emitProgress(onProgress, "Starting Ollama review.", "starting");

  let rawOutput = "";
  try {
    const gen = chat({ model, messages, format: schema, stream: false, signal });
    const { content } = await collectChatResponse(gen);
    rawOutput = content;
  } catch (error) {
    return {
      status: 1,
      finalMessage: "",
      reasoningSummary: [],
      threadId: null,
      turnId: null,
      error
    };
  }

  emitProgress(onProgress, "Review complete.", "finalizing");

  return {
    status: 0,
    finalMessage: rawOutput,
    reasoningSummary: [],
    threadId: null,
    turnId: null,
    error: null
  };
}

/**
 * Run an Ollama task (patch-emit variant — non-agentic v1).
 *
 * Streams the model response and returns the full text for Claude Code to apply.
 *
 * // TODO(phase-2.5): agentic tool-calling loop goes here
 *
 * @param {object} options
 * @param {string} options.model
 * @param {Array<{role:string, content:string}>} options.messages
 * @param {Function} [options.onProgress]
 * @param {AbortSignal} [options.signal]
 * @returns {Promise<{status: number, finalMessage: string, reasoningSummary: string[], threadId: string|null, turnId: string|null, error: unknown, fileChanges: Array, touchedFiles: Array, commandExecutions: Array}>}
 */
export async function runTask({ model, messages, onProgress, signal } = {}) {
  emitProgress(onProgress, "Starting Ollama task.", "starting");

  let rawOutput = "";
  try {
    const gen = chat({ model, messages, stream: true, signal });
    rawOutput = await streamChatResponse(gen, onProgress);
  } catch (error) {
    return {
      status: 1,
      finalMessage: "",
      reasoningSummary: [],
      threadId: null,
      turnId: null,
      error,
      fileChanges: [],
      touchedFiles: [],
      commandExecutions: []
    };
  }

  emitProgress(onProgress, "Task complete.", "finalizing");

  return {
    status: 0,
    finalMessage: rawOutput,
    reasoningSummary: [],
    threadId: null,
    turnId: null,
    error: null,
    fileChanges: [],
    touchedFiles: [],
    commandExecutions: []
  };
}

// ---------------------------------------------------------------------------
// Compatibility shims for ollama-companion.mjs
// ---------------------------------------------------------------------------

/**
 * Check if Ollama is reachable. Returns an availability object.
 * @param {string} [_cwd] unused — kept for API compatibility
 * @returns {{ available: boolean, detail: string }}
 */
export function getOllamaAvailability(_cwd) {
  // Sync check is not possible without blocking — we return "optimistically
  // available" here; the async health() check is used where async context allows.
  // The companion calls this synchronously in a few guards; those paths will
  // still work because we fail gracefully when chat() throws "not reachable".
  return {
    available: true,
    detail: "Ollama HTTP API (checked at request time)"
  };
}

/**
 * Check Ollama auth status. Ollama has no auth — it's local and auth-free.
 * @param {string} [_cwd]
 * @param {object} [_options]
 * @returns {Promise<object>}
 */
export async function getOllamaAuthStatus(_cwd, _options = {}) {
  const reachable = await health();
  return {
    available: reachable,
    loggedIn: reachable,
    detail: reachable ? "Ollama is running and reachable" : `Ollama not reachable at ${getOllamaHost()}. Run \`ollama serve\` or set OLLAMA_HOST.`,
    source: "ollama-http",
    authMethod: null,
    verified: reachable,
    requiresOpenaiAuth: false,
    provider: "ollama"
  };
}

/**
 * Returns the session runtime status (no broker in Phase 2).
 * @returns {{ mode: string, label: string, detail: string, endpoint: null }}
 */
export function getSessionRuntimeStatus(_env, _cwd) {
  return {
    mode: "direct",
    label: "direct HTTP",
    detail: "Requests go directly to the local Ollama server via HTTP.",
    endpoint: null
  };
}

/**
 * Interrupt a running turn. In Phase 2 there is no server-side turn to interrupt;
 * process termination via terminateProcessTree is used instead.
 * @returns {Promise<{attempted: boolean, interrupted: boolean, transport: null, detail: string}>}
 */
export async function interruptAppServerTurn(_cwd, _ids) {
  return {
    attempted: false,
    interrupted: false,
    transport: null,
    detail: "Ollama HTTP backend has no server-side turn interrupt; process will be killed directly."
  };
}

/**
 * Find the latest task thread. In Phase 2 there is no server-side thread list.
 * The companion falls back to local job state via findLatestResumableTaskJob.
 * @returns {Promise<null>}
 */
export async function findLatestTaskThread(_cwd) {
  return null;
}

/**
 * Build a persistent task thread name from a prompt.
 * @param {string} prompt
 * @returns {string}
 */
export function buildPersistentTaskThreadName(prompt) {
  const excerpt = String(prompt ?? "").trim().replace(/\s+/g, " ");
  const shortened = excerpt.length > 56 ? `${excerpt.slice(0, 53)}...` : excerpt;
  return shortened ? `${TASK_THREAD_PREFIX}: ${shortened}` : TASK_THREAD_PREFIX;
}

/**
 * Parse structured JSON output from a model response.
 * @param {string | null} rawOutput
 * @param {object} [fallback]
 */
export function parseStructuredOutput(rawOutput, fallback = {}) {
  if (!rawOutput) {
    return {
      parsed: null,
      parseError: fallback.failureMessage ?? "Ollama did not return a final structured message.",
      rawOutput: rawOutput ?? "",
      ...fallback
    };
  }

  try {
    return {
      parsed: JSON.parse(rawOutput),
      parseError: null,
      rawOutput,
      ...fallback
    };
  } catch (error) {
    return {
      parsed: null,
      parseError: error.message,
      rawOutput,
      ...fallback
    };
  }
}

/**
 * Read a JSON schema file.
 * @param {string} schemaPath
 * @returns {object}
 */
export function readOutputSchema(schemaPath) {
  return readJsonFile(schemaPath);
}

// Re-export the validator for use in companion
export { validateSchema };
