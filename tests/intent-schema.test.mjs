import test from "node:test";
import assert from "node:assert/strict";
import {
  INTENT_PLAN_ZOD,
  INTENT_PLAN_FORMAT,
  normalizeIntentPlan
} from "../plugins/armorcodex/scripts/lib/intent-schema.mjs";

test("INTENT_PLAN_ZOD accepts valid plan", () => {
  const result = INTENT_PLAN_ZOD.safeParse({
    goal: "Read and summarize",
    steps: [
      { action: "Read", description: "Read the file" },
      { action: "Edit", description: "Edit it", metadata: { inputs: { file_path: "a.txt" } } }
    ]
  });
  assert.ok(result.success);
});

test("INTENT_PLAN_ZOD rejects empty goal", () => {
  const result = INTENT_PLAN_ZOD.safeParse({
    goal: "",
    steps: [{ action: "Read" }]
  });
  assert.equal(result.success, false);
});

test("INTENT_PLAN_ZOD rejects empty steps", () => {
  const result = INTENT_PLAN_ZOD.safeParse({
    goal: "test",
    steps: []
  });
  assert.equal(result.success, false);
});

test("INTENT_PLAN_ZOD rejects missing action", () => {
  const result = INTENT_PLAN_ZOD.safeParse({
    goal: "test",
    steps: [{ description: "no action" }]
  });
  assert.equal(result.success, false);
});

test("normalizeIntentPlan produces correct shape", () => {
  const plan = normalizeIntentPlan({
    goal: "Deploy",
    steps: [
      { action: "Bash", description: "run deploy" },
      { action: "Read" }
    ]
  });
  assert.equal(plan.metadata.goal, "Deploy");
  assert.equal(plan.steps.length, 2);
  assert.equal(plan.steps[0].action, "Bash");
  assert.equal(plan.steps[0].mcp, "codex");
  assert.equal(plan.steps[1].action, "Read");
  assert.deepEqual(plan.steps[1].metadata, {});
});

test("INTENT_PLAN_FORMAT is a non-empty string", () => {
  assert.ok(INTENT_PLAN_FORMAT.length > 10);
  assert.ok(INTENT_PLAN_FORMAT.includes("goal"));
  assert.ok(INTENT_PLAN_FORMAT.includes("steps"));
  assert.ok(INTENT_PLAN_FORMAT.includes("action"));
});
