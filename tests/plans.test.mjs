import test from "node:test";
import assert from "node:assert/strict";

import {
  appendExecutionLog,
  appendRevision,
  buildPlanRecord,
  deletePlan,
  listPlans,
  readPlan,
  updatePlan,
  updateStepStatus,
  validatePlanBody,
  writePlan
} from "../plugins/ollama/scripts/lib/plans.mjs";
import { makeTempDir } from "./helpers.mjs";

const sampleBody = {
  task: "audit error handling",
  rationale: "Inspected lib/db/*.js and noticed bare db.query calls.",
  confidence: 0.85,
  steps: [
    {
      id: 1,
      description: "Wrap db calls in lib/db/users.js with try/catch",
      files: ["lib/db/users.js"],
      successCriteria: ["Every db.query call is wrapped"]
    },
    {
      id: 2,
      description: "Wrap db calls in lib/db/orders.js",
      files: ["lib/db/orders.js"],
      successCriteria: ["Every db.query call is wrapped"],
      dependencies: [1]
    }
  ]
};

test("validatePlanBody accepts a well-formed plan", () => {
  const errors = validatePlanBody(sampleBody);
  assert.deepEqual(errors, []);
});

test("validatePlanBody rejects missing task", () => {
  const bad = { ...sampleBody, task: "" };
  const errors = validatePlanBody(bad);
  assert.match(errors[0], /task/);
});

test("validatePlanBody rejects out-of-range confidence", () => {
  const bad = { ...sampleBody, confidence: 1.5 };
  const errors = validatePlanBody(bad);
  assert.match(errors[0], /confidence/);
});

test("validatePlanBody rejects empty steps array", () => {
  const bad = { ...sampleBody, steps: [] };
  const errors = validatePlanBody(bad);
  assert.match(errors[0], /steps/);
});

test("validatePlanBody rejects step missing successCriteria", () => {
  const bad = {
    ...sampleBody,
    steps: [{ id: 1, description: "x", successCriteria: [] }]
  };
  const errors = validatePlanBody(bad);
  assert.ok(errors.some((e) => /successCriteria/.test(e)));
});

test("buildPlanRecord adds id, timestamps, status, stepStatuses", () => {
  const record = buildPlanRecord(sampleBody, { model: "test:cloud" });
  assert.match(record.id, /^pln_/);
  assert.equal(record.status, "draft");
  assert.equal(record.revision, 1);
  assert.equal(record.model, "test:cloud");
  assert.deepEqual(record.stepStatuses, {
    "1": { status: "pending", attempts: 0 },
    "2": { status: "pending", attempts: 0 }
  });
  assert.ok(record.createdAt);
});

test("writePlan + readPlan round-trips", () => {
  const cwd = makeTempDir();
  const record = buildPlanRecord(sampleBody, { model: "test" });
  writePlan(cwd, record);
  const loaded = readPlan(cwd, record.id);
  assert.equal(loaded.id, record.id);
  assert.equal(loaded.task, sampleBody.task);
  assert.equal(loaded.steps.length, 2);
});

test("readPlan returns null for missing id", () => {
  const cwd = makeTempDir();
  assert.equal(readPlan(cwd, "pln_does_not_exist"), null);
});

test("listPlans returns plans newest first", async () => {
  const cwd = makeTempDir();
  const a = buildPlanRecord(sampleBody);
  writePlan(cwd, a);
  await new Promise((r) => setTimeout(r, 10));
  const b = buildPlanRecord(sampleBody);
  writePlan(cwd, b);
  const list = listPlans(cwd);
  assert.equal(list.length, 2);
  assert.equal(list[0].id, b.id);
});

test("updatePlan changes status", () => {
  const cwd = makeTempDir();
  const record = buildPlanRecord(sampleBody);
  writePlan(cwd, record);
  const updated = updatePlan(cwd, record.id, { status: "approved" });
  assert.equal(updated.status, "approved");
  assert.equal(readPlan(cwd, record.id).status, "approved");
});

test("updatePlan rejects invalid status", () => {
  const cwd = makeTempDir();
  const record = buildPlanRecord(sampleBody);
  writePlan(cwd, record);
  assert.throws(() => updatePlan(cwd, record.id, { status: "bogus" }), /Invalid plan status/);
});

test("appendRevision archives prior plan body", () => {
  const cwd = makeTempDir();
  const record = buildPlanRecord(sampleBody);
  writePlan(cwd, record);
  const newBody = {
    ...sampleBody,
    rationale: "New rationale",
    confidence: 0.9,
    steps: [
      { id: 1, description: "Updated step", successCriteria: ["something"] }
    ]
  };
  const revised = appendRevision(cwd, record.id, newBody, "tighten the scope");
  assert.equal(revised.revision, 2);
  assert.equal(revised.revisions.length, 1);
  assert.equal(revised.revisions[0].feedback, "tighten the scope");
  assert.equal(revised.rationale, "New rationale");
});

test("appendRevision preserves complete step statuses across revisions", () => {
  const cwd = makeTempDir();
  const record = buildPlanRecord(sampleBody);
  writePlan(cwd, record);
  updateStepStatus(cwd, record.id, 1, { status: "complete" });
  const revised = appendRevision(cwd, record.id, sampleBody, "redo step 2");
  assert.equal(revised.stepStatuses["1"].status, "complete");
  assert.equal(revised.stepStatuses["2"].status, "pending");
});

test("updateStepStatus tracks attempts and notes", () => {
  const cwd = makeTempDir();
  const record = buildPlanRecord(sampleBody);
  writePlan(cwd, record);
  const u1 = updateStepStatus(cwd, record.id, 1, { status: "running", attempts: 1 });
  assert.equal(u1.stepStatuses["1"].status, "running");
  assert.equal(u1.stepStatuses["1"].attempts, 1);
  const u2 = updateStepStatus(cwd, record.id, 1, { status: "complete", verifierNotes: "OK" });
  assert.equal(u2.stepStatuses["1"].status, "complete");
  assert.equal(u2.stepStatuses["1"].verifierNotes, "OK");
});

test("appendExecutionLog adds timestamped entries", () => {
  const cwd = makeTempDir();
  const record = buildPlanRecord(sampleBody);
  writePlan(cwd, record);
  appendExecutionLog(cwd, record.id, "started step 1");
  appendExecutionLog(cwd, record.id, "step 1 verified");
  const updated = readPlan(cwd, record.id);
  assert.equal(updated.executionLog.length, 2);
  assert.match(updated.executionLog[0], /started step 1/);
});

test("deletePlan removes the on-disk file", () => {
  const cwd = makeTempDir();
  const record = buildPlanRecord(sampleBody);
  writePlan(cwd, record);
  deletePlan(cwd, record.id);
  assert.equal(readPlan(cwd, record.id), null);
});
