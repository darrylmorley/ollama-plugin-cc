/**
 * pipeline.mjs — execute-plan driver. Runs implement → verify → retry per
 * step, entirely outside Claude's context. Returns a structured report.
 */
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

import {
  buildToolSchemas
} from "./agentic-tools.mjs";
import {
  parseStructuredOutput,
  readOutputSchema,
  runAgenticTask,
  runReview
} from "./ollama.mjs";
import {
  appendExecutionLog,
  readPlan,
  updatePlan,
  updateStepStatus
} from "./plans.mjs";

const VERIFY_SCHEMA_PATH = path.join(
  path.dirname(new URL(import.meta.url).pathname),
  "..",
  "..",
  "schemas",
  "verify-output.schema.json"
);

function readVerifySchema() {
  return readOutputSchema(VERIFY_SCHEMA_PATH);
}

function buildImplementerSystemPrompt(plan, step) {
  return [
    "You are an expert coding assistant executing one step of an approved plan.",
    "",
    "Plan rationale (read-only context):",
    plan.rationale,
    "",
    `You are working on STEP ${step.id}: ${step.description}`,
    step.files?.length ? `Files in scope: ${step.files.join(", ")}` : "",
    "",
    "Success criteria for this step:",
    ...step.successCriteria.map((c, i) => `${i + 1}. ${c}`),
    "",
    "Tools available: read_file, list_directory, write_file, apply_patch, run_command (allowlisted), done.",
    "Use read_file to inspect files before changing them.",
    "Use write_file to create new files or rewrite existing ones (most reliable).",
    "Use apply_patch only for small surgical edits.",
    "Use run_command to verify your changes if useful (e.g. running tests).",
    "When all success criteria are satisfied, call done with a concise summary.",
    "Do NOT do work outside this step's scope. Do NOT touch files unrelated to this step."
  ].filter(Boolean).join("\n");
}

function readStepFiles(cwd, step, maxBytes = 16 * 1024) {
  const out = [];
  const seen = new Set();
  for (const ref of step.files ?? []) {
    // ref may be "file" or "file:line-range"; normalize to just the path.
    const filePath = String(ref).split(":")[0].trim();
    if (!filePath || seen.has(filePath)) continue;
    seen.add(filePath);
    try {
      const abs = path.resolve(cwd, filePath);
      if (!fs.existsSync(abs)) continue;
      const stat = fs.statSync(abs);
      if (!stat.isFile() || stat.size > maxBytes) continue;
      const content = fs.readFileSync(abs, "utf8");
      out.push({ path: filePath, content });
    } catch {
      // skip unreadable
    }
  }
  return out;
}

function captureGitDiff(cwd) {
  const result = spawnSync("git", ["diff", "--no-color", "--no-ext-diff", "HEAD"], {
    cwd,
    encoding: "utf8",
    timeout: 10_000
  });
  if (result.status !== 0) {
    return "";
  }
  return result.stdout ?? "";
}

function buildVerifyMessages(plan, step, diff, currentFiles) {
  const system = [
    "You are a strict code-change verifier. Check whether each success criterion is met by either (a) the supplied diff or (b) the current state of the files (when prior steps have already satisfied the criterion).",
    "Be evidence-based: cite file:line references and quote relevant lines as evidence.",
    "If a criterion is satisfied by current state with no diff needed (e.g. 'no string concatenation remains'), that COUNTS AS MET — set met=true and explain in evidence.",
    "Empty diff is NOT automatic failure; only fail when an actual criterion is unmet by both the diff and current state.",
    "If even one criterion is unmet, set passed=false. Do not give partial credit.",
    "",
    "Respond ONLY with a single JSON object matching this schema:",
    JSON.stringify(readVerifySchema(), null, 2)
  ].join("\n");

  const userParts = [
    `Plan rationale: ${plan.rationale}`,
    "",
    `STEP ${step.id}: ${step.description}`,
    "",
    "Success criteria:",
    ...step.successCriteria.map((c, i) => `${i + 1}. ${c}`),
    ""
  ];
  if (diff) {
    userParts.push("Diff produced by this step:", "```diff", diff, "```", "");
  } else {
    userParts.push(
      "No diff was produced for this step (the implementer believed the file already satisfies the criteria — likely because prior steps did the work).",
      ""
    );
  }
  if (currentFiles && currentFiles.length > 0) {
    userParts.push("Current state of files in scope:");
    for (const f of currentFiles) {
      userParts.push(`### ${f.path}`, "```", f.content, "```");
    }
    userParts.push("");
  }
  userParts.push("Return JSON only.");
  const user = userParts.join("\n");

  return [
    { role: "system", content: system },
    { role: "user", content: user }
  ];
}

async function runVerifier({ model, messages, onProgress, signal }) {
  const schema = readVerifySchema();
  const result = await runReview({ model, messages, schema, onProgress, signal });
  const parsed = parseStructuredOutput(result.finalMessage);
  if (!parsed.parsed) {
    return {
      verdict: { passed: false, summary: `Verifier output unparseable: ${parsed.parseError ?? "unknown"}`, criteriaResults: [], remediation: "Re-run verifier or escalate." },
      raw: result.finalMessage
    };
  }
  return { verdict: parsed.parsed, raw: result.finalMessage };
}

function commitStepCheckpoint(cwd, plan, step) {
  const result = spawnSync("git", [
    "add", "-A"
  ], { cwd, encoding: "utf8" });
  if (result.status !== 0) return null;
  const commit = spawnSync("git", [
    "commit",
    "--no-verify",
    "-m",
    `[ollama-plan ${plan.id}] step ${step.id}: ${step.description.slice(0, 60)}`
  ], { cwd, encoding: "utf8" });
  if (commit.status !== 0) return null;
  const sha = spawnSync("git", ["rev-parse", "HEAD"], { cwd, encoding: "utf8" });
  return sha.stdout?.trim() ?? null;
}

function rollbackToHead(cwd) {
  spawnSync("git", ["reset", "--hard", "HEAD"], { cwd, encoding: "utf8" });
  spawnSync("git", ["clean", "-fd"], { cwd, encoding: "utf8" });
}

function dependenciesSatisfied(plan, step) {
  if (!Array.isArray(step.dependencies) || step.dependencies.length === 0) return true;
  for (const depId of step.dependencies) {
    const status = plan.stepStatuses?.[String(depId)]?.status;
    if (status !== "complete") return false;
  }
  return true;
}

/**
 * Execute one step: implement → verify → retry up to maxRetries times.
 * Returns the final status for the step.
 */
export async function executeStep({
  plan,
  step,
  cwd,
  implementerModel,
  verifierModel,
  maxRetries,
  dryRun,
  allowCommands,
  onProgress,
  signal
}) {
  const phaseLabel = `step ${step.id}/${plan.steps.length}`;
  appendExecutionLog(cwd, plan.id, `${phaseLabel}: starting (${step.description})`);
  onProgress?.({ phase: phaseLabel, message: `starting: ${step.description}` });

  let lastVerdict = null;
  let lastDiff = "";

  for (let attempt = 1; attempt <= maxRetries; attempt += 1) {
    onProgress?.({ phase: phaseLabel, message: `attempt ${attempt}/${maxRetries}: implementing` });
    appendExecutionLog(cwd, plan.id, `${phaseLabel}: implement attempt ${attempt}`);

    const implementerSystem = buildImplementerSystemPrompt(plan, step);
    const messages = [
      { role: "system", content: implementerSystem }
    ];
    if (lastVerdict && !lastVerdict.passed) {
      messages.push({
        role: "user",
        content: [
          "Your previous attempt did not pass verification.",
          "",
          "Verifier summary:",
          lastVerdict.summary,
          "",
          "Specifically not met:",
          ...(lastVerdict.criteriaResults?.filter((c) => !c.met).map((c) => `- ${c.criterion} — ${c.evidence}`) ?? []),
          "",
          lastVerdict.remediation ? `Suggested fix: ${lastVerdict.remediation}` : "",
          "",
          "Address these concerns now. Read the current state of the files first; the codebase may already contain partial changes from your previous attempt."
        ].filter(Boolean).join("\n")
      });
    } else {
      messages.push({ role: "user", content: `Implement step ${step.id} now.` });
    }

    if (dryRun) {
      onProgress?.({ phase: phaseLabel, message: "dry-run: skipping implementation" });
      lastVerdict = { passed: false, summary: "Dry run: not executed.", criteriaResults: [], remediation: "" };
      lastDiff = "";
      break;
    }

    const implResult = await runAgenticTask({
      model: implementerModel,
      messages,
      onProgress: (event) => {
        const m = typeof event === "string" ? event : event?.message;
        if (m) onProgress?.({ phase: phaseLabel, message: `implement: ${m}` });
      },
      signal,
      cwd,
      tools: buildToolSchemas(),
      maxIterations: 20,
      allowCommands
    });
    if (implResult.error) {
      lastVerdict = { passed: false, summary: `Implementer error: ${String(implResult.error)}`, criteriaResults: [], remediation: "" };
      break;
    }

    lastDiff = captureGitDiff(cwd);

    onProgress?.({ phase: phaseLabel, message: `attempt ${attempt}/${maxRetries}: verifying` });
    appendExecutionLog(cwd, plan.id, `${phaseLabel}: verify attempt ${attempt}`);

    const currentFiles = readStepFiles(cwd, step);
    const verifyMessages = buildVerifyMessages(plan, step, lastDiff, currentFiles);
    const { verdict } = await runVerifier({
      model: verifierModel,
      messages: verifyMessages,
      onProgress: (event) => {
        const m = typeof event === "string" ? event : event?.message;
        if (m) onProgress?.({ phase: phaseLabel, message: `verify: ${m}` });
      },
      signal
    });
    lastVerdict = verdict;
    appendExecutionLog(cwd, plan.id, `${phaseLabel}: verifier passed=${verdict.passed} — ${verdict.summary?.slice(0, 200)}`);

    if (verdict.passed) {
      const sha = commitStepCheckpoint(cwd, plan, step);
      updateStepStatus(cwd, plan.id, step.id, {
        status: "complete",
        attempts: attempt,
        verifierNotes: verdict.summary,
        commitSha: sha,
        lastDiff
      });
      onProgress?.({ phase: phaseLabel, message: `complete after ${attempt} attempt(s)` });
      return { status: "complete", attempts: attempt, verdict, diff: lastDiff };
    }

    onProgress?.({ phase: phaseLabel, message: `verify failed: ${verdict.summary?.slice(0, 120) ?? "(no summary)"}` });
    if (attempt < maxRetries) {
      // Roll back this attempt's changes so the next attempt starts from a clean
      // tree and the implementer doesn't compound mistakes on top of mistakes.
      rollbackToHead(cwd);
    }
  }

  updateStepStatus(cwd, plan.id, step.id, {
    status: "failed",
    attempts: maxRetries,
    verifierNotes: lastVerdict?.summary ?? "",
    lastDiff
  });
  appendExecutionLog(cwd, plan.id, `step ${step.id}: failed after ${maxRetries} attempt(s)`);
  return { status: "failed", attempts: maxRetries, verdict: lastVerdict, diff: lastDiff };
}

/**
 * Top-level driver. Iterates plan steps, honoring dependencies and resume.
 */
export async function executePlan({
  plan,
  cwd,
  implementerModel,
  verifierModel,
  maxRetries = 3,
  singleStep = null,
  resumeFrom = 1,
  dryRun = false,
  allowCommands,
  onProgress,
  signal
}) {
  if (!plan || !Array.isArray(plan.steps)) {
    throw new Error("executePlan: invalid plan.");
  }

  // Refuse to run on a dirty tree — we use git checkpoints, can't checkpoint over uncommitted state.
  if (!dryRun) {
    const status = spawnSync("git", ["status", "--porcelain"], { cwd, encoding: "utf8" });
    if (status.stdout?.trim()) {
      throw new Error("Working tree is dirty. Commit or stash before running execute-plan.");
    }
  }

  updatePlan(cwd, plan.id, { status: "executing" });
  onProgress?.({ phase: "executing", message: `starting plan with ${plan.steps.length} step(s)` });

  const stepReports = [];

  for (const step of plan.steps) {
    if (singleStep != null && step.id !== singleStep) {
      stepReports.push({ stepId: step.id, status: "skipped", reason: "not in --step" });
      continue;
    }
    if (step.id < resumeFrom) {
      stepReports.push({ stepId: step.id, status: "skipped", reason: "before --resume-from" });
      continue;
    }
    const existing = plan.stepStatuses?.[String(step.id)];
    if (existing?.status === "complete") {
      stepReports.push({ stepId: step.id, status: "complete", reason: "already complete" });
      continue;
    }
    // Reload the plan so dependency checks see the latest stepStatuses.
    const fresh = readPlan(cwd, plan.id) ?? plan;
    if (!dependenciesSatisfied(fresh, step)) {
      const report = { stepId: step.id, status: "blocked", reason: `depends on incomplete steps: ${(step.dependencies || []).join(", ")}` };
      stepReports.push(report);
      updateStepStatus(cwd, plan.id, step.id, { status: "skipped" });
      continue;
    }

    updateStepStatus(cwd, plan.id, step.id, { status: "running" });
    const stepResult = await executeStep({
      plan: fresh,
      step,
      cwd,
      implementerModel,
      verifierModel,
      maxRetries,
      dryRun,
      allowCommands,
      onProgress,
      signal
    });
    stepReports.push({
      stepId: step.id,
      status: stepResult.status,
      attempts: stepResult.attempts,
      verifier: stepResult.verdict,
      diffSizeBytes: stepResult.diff ? Buffer.byteLength(stepResult.diff, "utf8") : 0
    });

    if (stepResult.status === "failed") {
      updatePlan(cwd, plan.id, { status: "failed" });
      return { status: "stuck", stuckAt: step.id, stepReports };
    }
  }

  // All steps either complete or skipped.
  const allComplete = plan.steps.every((s) => {
    if (singleStep != null && s.id !== singleStep) return true;
    if (s.id < resumeFrom) return true;
    const fresh = readPlan(cwd, plan.id);
    return fresh?.stepStatuses?.[String(s.id)]?.status === "complete";
  });
  if (allComplete) {
    updatePlan(cwd, plan.id, { status: "complete" });
    return { status: "complete", stepReports };
  }
  return { status: "partial", stepReports };
}
