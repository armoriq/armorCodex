import test from "node:test";
import assert from "node:assert/strict";
import { normalizeToolName } from "../plugins/armorcodex/scripts/lib/common.mjs";
import { checkToolAgainstPlan } from "../plugins/armorcodex/scripts/lib/intent.mjs";

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
