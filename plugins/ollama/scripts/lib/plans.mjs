/**
 * plans.mjs — persistent plan state for the orchestrator pipeline.
 *
 * Each plan lives at .ollama/plans/<id>.json under the workspace root.
 * The on-disk shape extends the model-emitted plan (see schemas/plan.schema.json)
 * with bookkeeping fields: id, createdAt, updatedAt, status, model, revisions,
 * executionLog, stepStatuses.
 */
import fs from "node:fs";
import path from "node:path";

import { resolveWorkspaceRoot } from "./workspace.mjs";

const PLAN_DIR_NAME = path.join(".ollama", "plans");

const PLAN_STATUSES = new Set(["draft", "approved", "executing", "complete", "failed", "rejected"]);
const STEP_STATUSES = new Set(["pending", "running", "complete", "failed", "skipped"]);

function plansDir(workspaceRoot) {
  return path.join(workspaceRoot, PLAN_DIR_NAME);
}

function ensurePlansDir(workspaceRoot) {
  const dir = plansDir(workspaceRoot);
  fs.mkdirSync(dir, { recursive: true });
  // Auto-gitignore the entire .ollama/ directory so plan files don't appear
  // as dirty working-tree state. We write a marker `.gitignore` inside the
  // .ollama/ root only — never above it, so we never touch the user's repo.
  const ollamaRoot = path.dirname(dir);
  const ignoreFile = path.join(ollamaRoot, ".gitignore");
  if (!fs.existsSync(ignoreFile)) {
    try {
      fs.writeFileSync(ignoreFile, "*\n", "utf8");
    } catch {
      // best-effort; don't fail plan creation if we can't write the gitignore
    }
  }
  return dir;
}

function planPath(workspaceRoot, id) {
  return path.join(plansDir(workspaceRoot), `${id}.json`);
}

function newPlanId() {
  const ts = Date.now().toString(36);
  const rand = Math.random().toString(36).slice(2, 8);
  return `pln_${ts}_${rand}`;
}

function nowIso() {
  return new Date().toISOString();
}

/**
 * Validate a model-emitted plan body against the public schema fields.
 * Returns an array of error strings; empty array means valid.
 *
 * @param {unknown} value
 * @returns {string[]}
 */
export function validatePlanBody(value) {
  const errors = [];
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return ["plan must be a JSON object"];
  }
  const v = /** @type {Record<string, unknown>} */ (value);
  if (typeof v.task !== "string" || !v.task.trim()) errors.push("task: must be a non-empty string");
  if (typeof v.rationale !== "string" || !v.rationale.trim()) errors.push("rationale: must be a non-empty string");
  if (typeof v.confidence !== "number" || v.confidence < 0 || v.confidence > 1) {
    errors.push("confidence: must be a number 0-1");
  }
  if (!Array.isArray(v.steps) || v.steps.length === 0) {
    errors.push("steps: must be a non-empty array");
  } else {
    v.steps.forEach((step, idx) => {
      if (!step || typeof step !== "object") {
        errors.push(`steps[${idx}]: must be an object`);
        return;
      }
      const s = /** @type {Record<string, unknown>} */ (step);
      if (typeof s.id !== "number" || !Number.isInteger(s.id) || s.id < 1) {
        errors.push(`steps[${idx}].id: must be a positive integer`);
      }
      if (typeof s.description !== "string" || !s.description.trim()) {
        errors.push(`steps[${idx}].description: must be a non-empty string`);
      }
      if (!Array.isArray(s.successCriteria) || s.successCriteria.length === 0) {
        errors.push(`steps[${idx}].successCriteria: must be a non-empty array`);
      }
    });
  }
  return errors;
}

/**
 * Create a new plan record from a validated planner output.
 *
 * @param {object} planBody       result emitted by the planner (already validated)
 * @param {object} meta           { model, scope?: string[] }
 * @returns {object}              full plan record ready to persist
 */
export function buildPlanRecord(planBody, meta = {}) {
  const now = nowIso();
  const stepStatuses = {};
  for (const step of planBody.steps) {
    stepStatuses[String(step.id)] = { status: "pending", attempts: 0 };
  }
  return {
    id: newPlanId(),
    createdAt: now,
    updatedAt: now,
    model: meta.model ?? null,
    status: "draft",
    revision: 1,
    revisions: [],
    executionLog: [],
    stepStatuses,
    ...planBody,
    scope: planBody.scope ?? meta.scope ?? []
  };
}

/**
 * Persist a plan to disk.
 *
 * @param {string} cwd
 * @param {object} plan
 */
export function writePlan(cwd, plan) {
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  ensurePlansDir(workspaceRoot);
  const file = planPath(workspaceRoot, plan.id);
  const body = { ...plan, updatedAt: nowIso() };
  fs.writeFileSync(file, JSON.stringify(body, null, 2), "utf8");
  return body;
}

/**
 * Load a plan by id. Returns null if not found.
 * @param {string} cwd
 * @param {string} id
 */
export function readPlan(cwd, id) {
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const file = planPath(workspaceRoot, id);
  if (!fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

/**
 * List all plans in the workspace, newest first.
 * @param {string} cwd
 */
export function listPlans(cwd) {
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const dir = plansDir(workspaceRoot);
  if (!fs.existsSync(dir)) return [];
  const files = fs.readdirSync(dir).filter((n) => n.endsWith(".json"));
  const plans = [];
  for (const name of files) {
    try {
      const body = JSON.parse(fs.readFileSync(path.join(dir, name), "utf8"));
      plans.push(body);
    } catch {
      // skip corrupt files
    }
  }
  return plans.sort((a, b) => (b.createdAt ?? "").localeCompare(a.createdAt ?? ""));
}

/**
 * Apply a partial update to a stored plan. Refuses status transitions that
 * are not in the allowed set.
 *
 * @param {string} cwd
 * @param {string} id
 * @param {Partial<object>} patch
 */
export function updatePlan(cwd, id, patch) {
  const existing = readPlan(cwd, id);
  if (!existing) throw new Error(`Plan ${id} not found.`);
  if (patch.status && !PLAN_STATUSES.has(patch.status)) {
    throw new Error(`Invalid plan status: ${patch.status}`);
  }
  const next = { ...existing, ...patch, updatedAt: nowIso() };
  return writePlan(cwd, next);
}

/**
 * Append a new revision (e.g. after replan).
 *
 * @param {string} cwd
 * @param {string} id
 * @param {object} newPlanBody     replacement steps/rationale/confidence/scope
 * @param {string} feedback         the refinement instruction that produced this revision
 */
export function appendRevision(cwd, id, newPlanBody, feedback) {
  const existing = readPlan(cwd, id);
  if (!existing) throw new Error(`Plan ${id} not found.`);
  const previous = {
    revision: existing.revision,
    rationale: existing.rationale,
    confidence: existing.confidence,
    steps: existing.steps,
    scope: existing.scope,
    feedback: feedback ?? null,
    archivedAt: nowIso()
  };
  const stepStatuses = {};
  for (const step of newPlanBody.steps) {
    const prior = existing.stepStatuses?.[String(step.id)];
    stepStatuses[String(step.id)] = prior?.status === "complete"
      ? prior
      : { status: "pending", attempts: 0 };
  }
  const next = {
    ...existing,
    rationale: newPlanBody.rationale,
    confidence: newPlanBody.confidence,
    steps: newPlanBody.steps,
    scope: newPlanBody.scope ?? existing.scope ?? [],
    stepStatuses,
    revision: existing.revision + 1,
    revisions: [...(existing.revisions ?? []), previous],
    status: "draft",
    updatedAt: nowIso()
  };
  return writePlan(cwd, next);
}

/**
 * Mark a step's status and bump attempts.
 *
 * @param {string} cwd
 * @param {string} planId
 * @param {number} stepId
 * @param {{ status: string, attempts?: number, lastError?: string, lastDiff?: string, verifierNotes?: string }} update
 */
export function updateStepStatus(cwd, planId, stepId, update) {
  if (update.status && !STEP_STATUSES.has(update.status)) {
    throw new Error(`Invalid step status: ${update.status}`);
  }
  const plan = readPlan(cwd, planId);
  if (!plan) throw new Error(`Plan ${planId} not found.`);
  const key = String(stepId);
  const prior = plan.stepStatuses?.[key] ?? { status: "pending", attempts: 0 };
  const next = {
    ...prior,
    ...update,
    attempts: update.attempts ?? prior.attempts
  };
  const stepStatuses = { ...(plan.stepStatuses ?? {}), [key]: next };
  return writePlan(cwd, { ...plan, stepStatuses });
}

/**
 * Append a line to a plan's executionLog. Used for human-readable progress
 * (separate from step statuses which are structured).
 */
export function appendExecutionLog(cwd, planId, message) {
  const plan = readPlan(cwd, planId);
  if (!plan) throw new Error(`Plan ${planId} not found.`);
  const log = [...(plan.executionLog ?? []), `[${nowIso()}] ${String(message ?? "").trim()}`];
  return writePlan(cwd, { ...plan, executionLog: log });
}

/**
 * Delete a plan from disk. Used by `/ollama:result --json` cleanup or
 * future commands. No-op if the plan doesn't exist.
 */
export function deletePlan(cwd, id) {
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const file = planPath(workspaceRoot, id);
  if (fs.existsSync(file)) fs.unlinkSync(file);
}
