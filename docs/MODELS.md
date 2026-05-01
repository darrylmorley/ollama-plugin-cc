# Model recommendations

Empirical results from `scripts/battle-test.mjs` against a known-vulnerable fixture
(SQL injection in `buggy.js`, "fix by parameterizing" task). Each model was asked
to:

1. **Review** the working-tree change — must produce structured JSON with verdict + findings.
2. **Adversarial-review** — same input, harsher prompt.
3. **Rescue** — agentic loop must read the file, edit it, and exit cleanly.

> Run `node scripts/battle-test.mjs` against your own fixture to reproduce.

## Battle-test results (v0.10.0, 2026-05-01)

8 distinct models tested against the SQL-injection fixture. **All 8 passed
rescue.** Review and adversarial-review pass rates vary by model.

### Local models

| Model | Review | Adv. review | Rescue | Findings count (R / A) |
|---|---|---|---|---|
| `qwen3.5:9b` (9.7B Q4) | ✓ 79s | ✓ 74s | ✓ 3 iter / 44s | 3 / 3 |
| `gemma4:26b` (Q4) | ✓ 69s | ✓ 110s | ✓ 5 iter / 29s | 1 / 2 |
| `gpt-oss:20b` (MXFP4) | ✓ 26s | ✓ 24s | ✓ 4 iter / 20s | 1 / 2 |
| `qwen3.6:27b-coding-nvfp4` | ✗ schema drift | ✗ verdict missing | ✓ 4 iter / 120s | – / – |
| `batiai/qwen3.6-27b:q6` (Q6_K) | ✗ verdict missing | ✗ verdict missing | ✓ 1 iter / 300s | – / – |

### Cloud models

| Model | Review | Adv. review | Rescue | Findings (R / A) |
|---|---|---|---|---|
| `qwen3-coder-next:cloud` (80B FP8) | ✓ 6s | ✓ 6s | ✓ 3 iter / 9s | 1 / 1 |
| `glm-5.1:cloud` | ✓ 63s | ✓ 47s | ✓ 6 iter / 29s | 2 / 2 |
| `kimi-k2.6:cloud` (1T int4) | ✗ verdict missing | ✓ 113s | ✓ 3 iter / 13s | – / 3 |

### Headlines

- **Fastest tested (anywhere)**: `qwen3-coder-next:cloud` — review and rescue
  in single-digit seconds.
- **Best local all-rounder**: `gpt-oss:20b` — fastest local on every command,
  reliable structured output.
- **Best for rescue**: every tested model passed; `gpt-oss:20b` and
  `glm-5.1:cloud` are the fastest.
- **Worst structured-output reliability**: both qwen3.6 27B local variants
  (`-coding-nvfp4`, `batiai/...:q6`) drift off the JSON schema on the review
  prompts. They still rescue cleanly via tool calls.
- **kimi-k2.6:cloud caveat**: review missed verdict; adversarial worked.
  The harsher prompt seems to anchor it; the gentler review prompt drifts.

All 8 models successfully fixed the rescue task. Iteration counts are now
captured correctly (the v0.8.0 driver had a stdout/stderr split bug).

### Reading the findings count: stylistic, not signal

The "findings" column above counts top-level finding objects. **More findings
≠ more thorough.** Models differ in how they group issues:

- **Per-site splitters** (`qwen3.5:9b`, `glm-5.1:cloud`): one finding per
  vulnerable line/function. Easier for line-by-line triage.
- **Bundlers** (`gpt-oss:20b`): one finding spanning a line range, e.g.
  `buggy.js:4-10`. Easier for executive summaries.
- **Run-to-run variance**: `qwen3.5:9b` produced 3 findings in one run and
  2 in a re-run on the identical fixture. The 3rd was an additional secondary
  concern (input validation), not a duplicate.

Sample output from the SQL injection fixture:

| Style | Model | Findings |
|---|---|---|
| Per-site | `qwen3.5:9b` | `[critical] SQL Injection in findUser (buggy.js:4)` + `[critical] SQL Injection in deleteUser (buggy.js:9)` |
| Bundled | `gpt-oss:20b` | `[critical] SQL Injection via String Concatenation (buggy.js:4-10)` |
| Per-site | `glm-5.1:cloud` | Two `[critical]` SQL injection findings, one per function |

Both styles correctly identified all real issues. Pick by triage workflow,
not by raw count.

## Recommendations by use case

| Use case | First choice | Why |
|---|---|---|
| **Cloud, anything** | `qwen3-coder-next:cloud` | Fastest tested across review/adv/rescue (6–9 s each). |
| **Cloud rescue, alt** | `glm-5.1:cloud` | Reliable structured output; 6 iter / 29s rescue. |
| **Local all-rounder** | `gpt-oss:20b` | Fastest local on every command; reliable JSON. |
| **Local rescue** | `gemma4:26b` | Most resourceful when `apply_patch` rejects; reliable JSON. |
| **VRAM-constrained** | `qwen3.5:9b` | 6.6 GB; works on every command (~80 s review). |
| **Adversarial-only cloud** | `kimi-k2.6:cloud` | Strong adversarial; review schema drift makes it less suitable for `/ollama:review`. |

## Known gotchas

### `apply_patch` is strict

`/ollama:rescue` uses `git apply --check` (no `--3way`, no `--reject`). If the model
produces a unified diff with mismatched context lines, the patch is rejected.
Empirically this happened with `glm-5.1:cloud`, `qwen3.6:27b-coding-nvfp4`, and
`gpt-oss:20b` on the smoke-test fixture before v0.5.0.

**Fix landed in v0.5.0:** the model now also has a `write_file` tool. The system
prompt steers it toward `write_file` for non-trivial edits; `apply_patch` is only
preferred for small surgical changes. With `write_file` available, all four
tested models land the fix in ≤5 iterations.

### Models that lack reliable tool calling

The agentic rescue auto-falls back to patch-emit for these families
(`TOOL_CALLING_DENY_FAMILIES`):

- Phi-3 / Phi-2
- Gemma 1 / Gemma 2 (Gemma 3+ supports tool calls)
- TinyLlama, Orca, older Llama (pre-3.1)
- CodeLlama

If you want to use one of these, pass `--emit-patch` to opt into the legacy
patch-emit flow explicitly.

### Qwen 3.6 27B variants drift on structured review

Both `qwen3.6:27b-coding-nvfp4` (nvfp4) and `batiai/qwen3.6-27b:q6` (Q6_K
gguf) failed structured review and adversarial-review against this fixture
— the JSON came back without a usable verdict. The earlier mlx-runner
crash on the nvfp4 variant intermittently surfaces too. Both succeeded at
rescue (tool calls bracket the format). Use them only for rescue, or
prefer `gpt-oss:20b`/`gemma4:26b` for local review.

### kimi-k2.6:cloud — review only flaky, adversarial fine

`kimi-k2.6:cloud` failed structured review (verdict missing) but produced
3 findings on adversarial-review. The harsher adversarial prompt seems to
anchor the schema better than the gentler review prompt. Use `--scope` /
`/ollama:adversarial-review` for cloud-Kimi-style workloads.

### Reasoning-heavy models

DeepSeek-R1 distills emit thinking tokens that interfere with structured output.
Avoid them for `/ollama:review` and `/ollama:adversarial-review`. They can be
used for `/ollama:rescue` (tool calls bracket the thinking) but expect higher
iteration counts.

### Context window

The companion auto-resolves each model's context window via Ollama's `/api/show`
and reserves 2k tokens for the system prompt + response. When the input
(diff + file content) exceeds the budget, the inline file content is dropped
first; the diff itself is preserved.

For local 8 GB VRAM rigs, prefer 7B–9B models and keep diffs under ~4k tokens.
For 16 GB+, `qwen3.6:27b-coding-nvfp4` and `gemma4:26b` are practical for both
review and rescue.

## Reproducing the battle test

```bash
# 1. Set up fixture (one-time)
mkdir -p /tmp/rescue-smoke && cd /tmp/rescue-smoke
cat > buggy.js << 'EOF'
function findUser(db, userId) {
  const query = "SELECT * FROM users WHERE id = '" + userId + "'";
  return db.query(query);
}
function deleteUser(db, userId) {
  const query = "DELETE FROM users WHERE id = '" + userId + "'";
  return db.query(query);
}
module.exports = { findUser, deleteUser };
EOF
git init -q && git add buggy.js && git commit -qm "init"

# 2. Run the suite
cd /path/to/ollama-plugin-cc
node scripts/battle-test.mjs --models qwen3.5:9b,gemma4:26b,gpt-oss:20b,qwen3.6:27b-coding-nvfp4,glm-5.1:cloud
```

Outputs a markdown table to stdout; progress to stderr.
