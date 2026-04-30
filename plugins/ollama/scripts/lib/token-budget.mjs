/**
 * token-budget.mjs — cheap per-model context budgeting.
 *
 * estimateTokens(text)        — char/4 heuristic; no tokenizer dep.
 * getModelContextLimit(host, model) — try /api/show, fall back to map.
 * resolveBudget(host, model)  — returns { tokens, source }; reserves
 *   headroom for the system prompt + response.
 */
import { ollamaShow } from "./ollama.mjs";

// Reserve room for system prompt + assistant reply.
const RESERVED_HEADROOM_TOKENS = 2048;

// Sane default when nothing else is known.
const DEFAULT_MODEL_TOKENS = 8192;

// Static fallback for cloud / unknown models. Keep tiny — the dynamic path
// covers most local cases.
const STATIC_LIMITS = {
  "glm-5.1:cloud": 128_000,
  "kimi-k2.6:cloud": 128_000,
  "qwen3-coder-next:cloud": 256_000
};

/**
 * Rough char/4 token estimate. Good enough for a budget check.
 * @param {string} text
 * @returns {number}
 */
export function estimateTokens(text) {
  if (!text) return 0;
  return Math.ceil(text.length / 4);
}

/**
 * Look up a model's context window. Prefers Ollama's /api/show; falls
 * back to STATIC_LIMITS, then DEFAULT_MODEL_TOKENS.
 *
 * @param {string} host  e.g. "http://127.0.0.1:11434"
 * @param {string} model
 * @returns {Promise<{ tokens: number, source: "show" | "static" | "default" }>}
 */
export async function getModelContextLimit(host, model) {
  if (model && Object.prototype.hasOwnProperty.call(STATIC_LIMITS, model)) {
    return { tokens: STATIC_LIMITS[model], source: "static" };
  }
  try {
    const info = await ollamaShow(host, model);
    const modelInfo = info?.model_info || {};
    for (const key of Object.keys(modelInfo)) {
      if (key.endsWith(".context_length") || key === "context_length") {
        const val = Number(modelInfo[key]);
        if (Number.isFinite(val) && val > 0) {
          return { tokens: val, source: "show" };
        }
      }
    }
  } catch {
    // Fall through to default.
  }
  return { tokens: DEFAULT_MODEL_TOKENS, source: "default" };
}

/**
 * Resolve the usable input-token budget for a model after reserving
 * headroom. Returns at least 1024.
 *
 * @param {string} host
 * @param {string} model
 * @returns {Promise<{ tokens: number, source: string, raw: number }>}
 */
export async function resolveBudget(host, model) {
  const { tokens: raw, source } = await getModelContextLimit(host, model);
  const usable = Math.max(1024, raw - RESERVED_HEADROOM_TOKENS);
  return { tokens: usable, source, raw };
}
