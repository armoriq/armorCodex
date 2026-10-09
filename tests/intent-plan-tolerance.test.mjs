import test from "node:test";
import assert from "node:assert/strict";
import {
  INTENT_PLAN_ZOD,
  normalizeIntentPlan
} from "../plugins/armorcodex/scripts/lib/intent-schema.mjs";

test("tolerates {tool, rationale} step shape (maps to action/description)", () => {
  const r = INTENT_PLAN_ZOD.safeParse({ goal: "g", steps: [{ tool: "Bash", rationale: "why" }] });
  assert.equal(r.success, true);
  assert.equal(r.data.steps[0].action, "Bash");
  assert.equal(r.data.steps[0].description, "why");
});

test("tolerates top-level inputs (no metadata wrapper)", () => {
  const r = INTENT_PLAN_ZOD.safeParse({
    goal: "g",
    steps: [{ action: "Bash", inputs: { command: "ls" } }]
  });
  assert.equal(r.success, true);
  assert.deepEqual(r.data.steps[0].metadata, { inputs: { command: "ls" } });
});

test("canonical {action, metadata.inputs} still works", () => {
  const r = INTENT_PLAN_ZOD.safeParse({
    goal: "g",
    steps: [{ action: "Read", metadata: { inputs: {} } }]
  });
  assert.equal(r.success, true);
  assert.equal(r.data.steps[0].action, "Read");
});

test("normalizeIntentPlan maps a tool-shaped step to both action and tool", () => {
  const norm = normalizeIntentPlan(
    INTENT_PLAN_ZOD.parse({ goal: "g", steps: [{ tool: "apply_patch", reason: "edit" }] })
  );
  assert.equal(norm.steps[0].action, "apply_patch");
  assert.equal(norm.steps[0].tool, "apply_patch");
  assert.equal(norm.steps[0].description, "edit");
});

test("a step with neither action nor tool is still rejected", () => {
  const r = INTENT_PLAN_ZOD.safeParse({ goal: "g", steps: [{ description: "no tool named" }] });
  assert.equal(r.success, false);
});
