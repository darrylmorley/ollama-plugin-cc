---
name: ollama-model-prompting
description: Guidance on selecting and prompting open-weight Ollama models for review and rescue tasks
user-invocable: false
---

# Ollama Model Prompting

Reference this skill when deciding which model to use and how to shape prompts for open-weight models.

---

## Recommended Models Per Use Case

| Use case | Recommended model | Notes |
|---|---|---|
| General review, baseline | `llama3.1:8b` | Fast, wide availability, sufficient for basic review |
| Code-heavy review | `qwen2.5-coder:14b` | Strong code understanding, reliable JSON output |
| Adversarial review | `deepseek-coder-v2:16b` | Best reasoning depth for adversarial analysis |
| Stop-review gate only | `qwen2.5:7b` | Minimal viable; handles the single-line ALLOW/BLOCK format |

Select via `--model <name>` on any companion command. Falls back to `OLLAMA_PLUGIN_DEFAULT_MODEL` if set, otherwise the companion will error and prompt you to run `/ollama:setup`.

---

## Tool-Calling Support Matrix

Tool calling is required for the agentic `rescue` flow (`--agentic` flag). Non-agentic rescue (patch-emit mode) works without it.

| Model family | Tool calling | Notes |
|---|---|---|
| Llama 3.1 8B/70B/405B | Reliable | Native tool-call support since 3.1 |
| Llama 3.2 3B/1B | Unreliable | Too small; output format degrades |
| Qwen 2.5 7B/14B/32B/72B | Reliable | Solid tool-call format across sizes |
| Qwen 2.5 Coder 7B/14B/32B | Reliable | Same base; code context does not hurt tool calls |
| DeepSeek-Coder-V2 16B/236B | Reliable | Strong reasoning; good tool adherence |
| DeepSeek-R1 (distills) | Unreliable | Thinking tokens interfere with JSON/tool output |
| Mistral 7B | Unreliable | v0.2 and earlier lack native tool-call format |
| Mistral Large / Nemo | Reliable | Larger Mistral variants support tool calls |
| Phi-3 / Phi-4 | Unreliable | Small; JSON adherence inconsistent |
| Gemma 2 9B/27B | Partial | Produces tool-call-like output but not standard format |

When in doubt: test with the stop-review gate first (simple ALLOW/BLOCK output). If that fails, the model is not ready for structured JSON tasks.

---

## Context Window Tradeoffs

Most local models have effective context windows of 8k–32k tokens, regardless of their advertised maximum.

- Keep git diffs trimmed. The companion script chunks large diffs automatically, but oversized context degrades output quality more than it adds information.
- Aim for diffs under 4k tokens for 7B–8B models. Up to 16k for 14B–16B models.
- For `adversarial-review`, include only the changed files plus their direct dependencies — not the full repo context.
- The schema inline in `adversarial-review.md` costs ~400 tokens. This is intentional: embedding the schema reduces hallucinated field names.

---

## JSON-Mode Reliability

Ollama supports two JSON enforcement modes:

**`format: "json"`** — Constrains output to valid JSON but does not enforce a specific shape. Use as a fallback for any model when you need valid JSON but cannot use schema mode.

**`format: <schema>`** (Ollama ≥ 0.5) — Constrained decoding against a JSON Schema. Significantly more reliable for structured output. Use this for `review` and `adversarial-review` with the schema from `schemas/review-output.schema.json`.

When to fall back:
- If the model is older or the Ollama version is < 0.5, use `format: "json"` and post-validate against the schema.
- If post-validation fails, retry once with a stricter prompt: add "Your previous response was missing required fields. Respond again with ALL required fields." at the top.
- If the second attempt also fails, surface the raw response with a clear error (see `ollama-result-handling` skill). Do not guess or fill in missing fields.

---

## Prompting Style for Open Models

Open models need more explicit direction than GPT-class models. Follow these rules when shaping prompts:

**Explicit beats implicit.** State the output format requirement at the start AND at the end of every prompt. Repeating the constraint is not redundant — small models drift in long contexts.

**Short beats long.** Each additional 500 tokens of instruction increases the chance the model ignores an earlier constraint. Cut every section that does not carry load-bearing information.

**Examples beat instructions.** Where possible, show a concrete example of the expected output shape rather than only describing it. Even a partial example anchors the model's output format.

**Repeat critical constraints.** The JSON-only reminder appears twice in `adversarial-review.md` (before the schema and after). Keep both. Do not merge them into one.

**Avoid deep chain-of-thought for small models.** Multi-step reasoning prompts ("first consider X, then evaluate Y, then synthesize Z") work well for 70B+ models. For 7B–16B models they cause drift — the model exhausts its output on reasoning tokens before producing structured output. Front-load the decision; keep reasoning sections short.

**Use the existing pseudo-XML tag style.** The `<role>`, `<task>`, `<output_format>` tag structure is established in this project's prompts. Open models trained on instruction-following data handle this well. Do not switch to plain prose for consistency.
