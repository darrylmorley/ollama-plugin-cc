import test from "node:test";
import assert from "node:assert/strict";

import { estimateTokens, getModelContextLimit, resolveBudget } from "../plugins/ollama/scripts/lib/token-budget.mjs";

test("estimateTokens uses char/4 heuristic", () => {
  assert.equal(estimateTokens(""), 0);
  assert.equal(estimateTokens("abcd"), 1);
  assert.equal(estimateTokens("a".repeat(100)), 25);
});

test("estimateTokens handles null/undefined safely", () => {
  assert.equal(estimateTokens(null), 0);
  assert.equal(estimateTokens(undefined), 0);
});

test("getModelContextLimit returns static value for cloud models", async () => {
  const result = await getModelContextLimit(undefined, "glm-5.1:cloud");
  assert.equal(result.source, "static");
  assert.equal(result.tokens, 128_000);
});

test("getModelContextLimit falls back to default for unknown models with no /api/show", async () => {
  // No Ollama running on this fake host; should fall through to default.
  const prevHost = process.env.OLLAMA_HOST;
  process.env.OLLAMA_HOST = "http://127.0.0.1:1";
  try {
    const result = await getModelContextLimit(undefined, "definitely-not-a-real-model:latest");
    assert.equal(result.source, "default");
    assert.equal(result.tokens, 8192);
  } finally {
    if (prevHost === undefined) delete process.env.OLLAMA_HOST;
    else process.env.OLLAMA_HOST = prevHost;
  }
});

test("resolveBudget reserves headroom and floors at 1024", async () => {
  const result = await resolveBudget(undefined, "glm-5.1:cloud");
  assert.equal(result.raw, 128_000);
  assert.equal(result.tokens, 128_000 - 2048);
  assert.equal(result.source, "static");
});
