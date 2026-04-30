#!/usr/bin/env node
/**
 * battle-test.mjs — run review, adversarial-review, and rescue against
 * a fixture for each model in the matrix. Prints a markdown results
 * table to stdout.
 *
 * Usage:
 *   node scripts/battle-test.mjs [--models a,b,c] [--fixture path]
 *
 * The fixture must be a git repo with at least one tracked changed file.
 * Defaults to /tmp/rescue-smoke (created by hand).
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");
const COMPANION = path.join(REPO_ROOT, "plugins/ollama/scripts/ollama-companion.mjs");

const DEFAULT_MODELS = [
  "qwen3.5:9b",
  "gemma4:26b",
  "gpt-oss:20b",
  "qwen3.6:27b-coding-nvfp4",
  "glm-5.1:cloud"
];

const args = process.argv.slice(2);
let models = DEFAULT_MODELS;
let fixture = "/tmp/rescue-smoke";
for (let i = 0; i < args.length; i += 1) {
  if (args[i] === "--models" && args[i + 1]) {
    models = args[i + 1].split(",").map((s) => s.trim()).filter(Boolean);
    i += 1;
  } else if (args[i] === "--fixture" && args[i + 1]) {
    fixture = path.resolve(args[i + 1]);
    i += 1;
  }
}

if (!fs.existsSync(path.join(fixture, ".git"))) {
  console.error(`Fixture ${fixture} is not a git repo. Run the rescue setup first.`);
  process.exit(1);
}

function run(command, cmdArgs, opts = {}) {
  const t0 = Date.now();
  const result = spawnSync(command, cmdArgs, {
    cwd: opts.cwd ?? fixture,
    encoding: "utf8",
    timeout: opts.timeout ?? 5 * 60 * 1000
  });
  const ms = Date.now() - t0;
  // Merge stdout + stderr so the classifier can see progress lines (which
  // the companion writes to stderr) alongside the rendered result.
  const combined = (result.stdout ?? "") + "\n" + (result.stderr ?? "");
  return {
    stdout: combined,
    stderr: result.stderr ?? "",
    exitCode: result.status,
    ms
  };
}

function classifyReview(out) {
  if (!out.stdout) return { ok: false, verdict: "error", findings: 0 };
  const verdictMatch = out.stdout.match(/Verdict:\s*([\w-]+)/i);
  const findingsCount = (out.stdout.match(/^- \[/gm) || []).length;
  const ok = !!verdictMatch && /critical|injection|sql/i.test(out.stdout);
  return {
    ok,
    verdict: verdictMatch?.[1] ?? "missing",
    findings: findingsCount,
    error: out.stdout.includes("did not return valid structured JSON")
  };
}

function classifyRescue(out, fixturePath) {
  // Check if buggy.js was actually fixed (no more string concatenation).
  const buggy = fs.readFileSync(path.join(fixturePath, "buggy.js"), "utf8");
  const fixed = !buggy.includes("' + userId + '") && !buggy.includes("' + userInput + '");
  const completed = out.stdout.includes("[ollama] Agent called done.") ||
                   (fixed && out.stdout.includes("Agent completed"));
  const capped = out.stdout.includes("Max iterations") || out.stdout.includes("max iterations");
  const iterMatches = [...out.stdout.matchAll(/Iteration (\d+) of/g)];
  const iterations = iterMatches.length ? Number(iterMatches[iterMatches.length - 1][1]) : 0;
  return {
    fixed,
    completed,
    capped,
    iterations
  };
}

function resetFixture() {
  spawnSync("git", ["checkout", "--", "."], { cwd: fixture });
  spawnSync("rm", ["-f", "_fix.js", "_fix.py"], { cwd: fixture });
}

const REVIEW_PROMPT = "There is a SQL injection vulnerability in buggy.js. Read the file, fix all instances by using parameterized queries with ? placeholders. Then call done.";

const results = [];

for (const model of models) {
  console.error(`\n→ ${model}`);

  resetFixture();
  // Make working tree dirty so review has something to look at.
  fs.writeFileSync(
    path.join(fixture, "buggy.js"),
    fs.readFileSync(path.join(fixture, "buggy.js"), "utf8").replace("userId", "userInput")
  );

  console.error(`  review…`);
  const reviewOut = run("node", [COMPANION, "review", "--model", model]);
  const review = classifyReview(reviewOut);

  console.error(`  adversarial-review…`);
  const advOut = run("node", [COMPANION, "adversarial-review", "--model", model]);
  const adversarial = classifyReview(advOut);

  resetFixture();
  console.error(`  rescue (agentic)…`);
  const rescueOut = run("node", [COMPANION, "task", "--write", "--model", model, REVIEW_PROMPT]);
  const rescue = classifyRescue(rescueOut, fixture);

  results.push({ model, review, adversarial, rescue, reviewMs: reviewOut.ms, advMs: advOut.ms, rescueMs: rescueOut.ms });
}

resetFixture();

// Print markdown table to stdout.
console.log("\n# Battle test results\n");
console.log("Fixture: SQL injection in `buggy.js` (rename + parameterize task).\n");
console.log("| Model | Review | Adv. review | Rescue | Notes |");
console.log("|---|---|---|---|---|");
for (const r of results) {
  const reviewCell = r.review.error
    ? "✗ JSON drift"
    : r.review.ok
      ? `✓ ${r.review.findings}f / ${(r.reviewMs / 1000).toFixed(0)}s`
      : `~ verdict=${r.review.verdict}`;
  const advCell = r.adversarial.error
    ? "✗ JSON drift"
    : r.adversarial.ok
      ? `✓ ${r.adversarial.findings}f / ${(r.advMs / 1000).toFixed(0)}s`
      : `~ verdict=${r.adversarial.verdict}`;
  const mode = r.rescue.iterations > 0 ? "agentic" : "patch-emit";
  const rescueCell = r.rescue.fixed
    ? `✓ ${mode} ${r.rescue.iterations || ""} / ${(r.rescueMs / 1000).toFixed(0)}s`
    : r.rescue.capped
      ? `✗ cap (${r.rescue.iterations} iter)`
      : `✗ stalled (${r.rescue.iterations} iter)`;
  console.log(`| \`${r.model}\` | ${reviewCell} | ${advCell} | ${rescueCell} | |`);
}

console.error("\nDone.");
