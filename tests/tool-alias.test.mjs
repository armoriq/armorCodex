import test from "node:test";
import assert from "node:assert/strict";
import { normalizeToolName } from "../plugins/armorcodex/scripts/lib/common.mjs";
import {
  checkIntentTokenPlan,
  checkToolAgainstPlan,
  findPlanStepIndices
} from "../plugins/armorcodex/scripts/lib/intent.mjs";

test("normalizeToolName aliases Codex shell tool names to bash", () => {
  for (const name of ["exec_command", "shell", "local_shell", "unified_exec", "container.exec", "Bash", "BASH"]) {
    assert.equal(normalizeToolName(name), "bash", `${name} should normalize to bash`);
  }
  // Non-shell tools are unaffected (still lowercased).
  assert.equal(normalizeToolName("apply_patch"), "apply_patch");
  assert.equal(normalizeToolName("WebFetch"), "webfetch");
});

test("intent plan declared as exec_command matches a Bash tool call (no drift)", () => {
  const plan = { steps: [{ action: "exec_command", metadata: { inputs: {} } }] };
  const r = checkToolAgainstPlan({ plan, toolName: "Bash", toolInput: { command: "ls" } });
  assert.equal(r.allowed, true);
});

test("intent plan declared as Bash matches a Codex shell tool call", () => {
  const plan = { steps: [{ action: "Bash", metadata: { inputs: {} } }] };
  const r = checkToolAgainstPlan({ plan, toolName: "exec_command", toolInput: { command: "ls" } });
  assert.equal(r.allowed, true);
});

test("a genuinely unplanned tool still drifts", () => {
  const plan = { steps: [{ action: "Bash", metadata: { inputs: {} } }] };
  const r = checkToolAgainstPlan({ plan, toolName: "apply_patch", toolInput: {} });
  assert.equal(r.allowed, false);
  assert.match(r.reason, /not in plan/);
});

test("a namespaced Codex tool declared as clock__curr_time matches the hook name clockcurr_time", () => {
  const plan = { steps: [{ action: "Bash" }, { action: "clock__curr_time" }, { action: "web__run" }] };
  assert.equal(checkToolAgainstPlan({ plan, toolName: "clockcurr_time", toolInput: {} }).allowed, true);
  assert.equal(checkToolAgainstPlan({ plan, toolName: "webrun", toolInput: {} }).allowed, true);
  assert.equal(checkToolAgainstPlan({ plan, toolName: "clock__curr_time", toolInput: {} }).allowed, true);
  assert.deepEqual(findPlanStepIndices(plan, "clockcurr_time", {}).matches, [1]);
});

test("a near miss of the hook name still drifts", () => {
  const plan = { steps: [{ action: "clock__curr_time" }] };
  const r = checkToolAgainstPlan({ plan, toolName: "clockcurr_timeX", toolInput: {} });
  assert.equal(r.allowed, false);
  assert.match(r.reason, /not in plan/);
});

test("MCP tool names keep their delimiters", () => {
  const plan = { steps: [{ action: "mcp__a__bc" }] };
  assert.equal(checkToolAgainstPlan({ plan, toolName: "mcp__a__bc", toolInput: {} }).allowed, true);
  assert.equal(checkToolAgainstPlan({ plan, toolName: "mcp__abc", toolInput: {} }).allowed, false);
  assert.equal(checkToolAgainstPlan({ plan, toolName: "abc", toolInput: {} }).allowed, false);
});

test("a signed plan with clock__curr_time allows the hook name clockcurr_time", () => {
  const token = {
    plan: { steps: [{ action: "clock__curr_time" }] },
    expiresAt: Math.floor(Date.now() / 1000) + 600
  };
  const result = checkIntentTokenPlan({ intentTokenRaw: JSON.stringify(token), toolName: "clockcurr_time", toolParams: {} });
  assert.equal(result.matched, true);
  assert.equal(result.blockReason, undefined);
});
