# Model recommendations

Empirical results from `scripts/battle-test.mjs` against a known-vulnerable fixture
(SQL injection in `buggy.js`, "fix by parameterizing" task). Each model was asked
to:

1. **Review** the working-tree change — must produce structured JSON with verdict + findings.
2. **Adversarial-review** — same input, harsher prompt.
3. **Rescue** — agentic loop must read the file, edit it, and exit cleanly.

> Run `node scripts/battle-test.mjs` against your own fixture to reproduce.

## Battle-test results (v0.8.0, 2026-04-30)

| Model | Review | Adv. review | Rescue | Notes |
|---|---|---|---|---|
| `qwen3.5:9b` | ✓ 2 findings / 270s | ✓ 3 findings / 74s | ✓ | VRAM-friendly baseline; slow but reliable |
| `gemma4:26b` | ✓ 2 findings / 68s | ✗ schema drift | ✓ | Most resourceful for rescue; adversarial path is flaky |
| `gpt-oss:20b` | ✓ 1 finding / 26s | ✓ 2 findings / 20s | ✓ | Best balance of size, speed, and quality |
| `qwen3.6:27b-coding-nvfp4` | ✗ runner fault | ✗ runner fault | ✓ | Long prompts crashed the Ollama mlx runner; rescue worked |
| `glm-5.1:cloud` | ✓ 2 findings / 12s | ✓ 2 findings / 11s | ✓ | Fastest, cleanest structured output |

All five models successfully fixed the SQL injection in the rescue task. The
"agentic vs patch-emit" mode count was unreliable in this run due to a stdout/
stderr split in the driver — Phase 1.5 testing already established that the
strong code models use `write_file` once `apply_patch` rejects, while smaller
models hit the auto-fallback to patch-emit.

## Recommendations by use case

| Use case | First choice | Why |
|---|---|---|
| **Local rescue** | `gemma4:26b` | Most resourceful when `apply_patch` fails — falls back to `write_file` cleanly. |
| **Local review** | `qwen3.6:27b-coding-nvfp4` or `gpt-oss:20b` | Strong code understanding, reliable JSON output. |
| **Cloud rescue & review** | `glm-5.1:cloud` | Fast, strong tool calling, reliable JSON. |
| **Small / VRAM-constrained** | `qwen3.5:9b` | 6.6 GB; works but slower on review (~5 min). |

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

### Ollama mlx runner can crash on long prompts (Apple Silicon)

During battle testing, `qwen3.6:27b-coding-nvfp4` consistently returned
`Ollama /api/chat error 500: mlx runner failed` on the review and
adversarial-review tasks (~1700-token prompts). Rescue worked fine. The
fault is in the Ollama Metal accelerator pipeline, not the plugin. If you
hit this:

- Try a quantization in `gguf` format instead of `nvfp4` for review work.
- Or use the model only for rescue (which streams shorter messages via
  tool calls).

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
