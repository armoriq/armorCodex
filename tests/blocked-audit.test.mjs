import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { handlePreToolUse } from "../plugins/armorcodex/scripts/lib/engine.mjs";

const PLAN_ID = randomUUID();
const SESSION = "sess-blocked";
const PLAN = { steps: [{ action: "Bash" }, { action: "Read" }], metadata: { goal: "inspect" } };

async function setup({ mode = "enforce", withPlan = true, rules = [] } = {}) {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "armorcodex-blocked-"));
  const config = {
    mode,
    dataDir,
    policyFile: path.join(dataDir, "policy.json"),
    runtimeFile: path.join(dataDir, "runtime.json"),
    apiKey: "ak_test_blockedrow000000000000000000",
    auditEnabled: true,
    useSdkIntent: false,
    intentEndpoint: "",
    verifyStepEndpoint: "",
    intentRequired: true,
    requireCsrgProofs: false,
    csrgVerifyEnabled: false,
    cryptoPolicyEnabled: false,
    llmId: "openai-codex",
    mcpName: "codex",
    userId: "user-login",
    agentId: "codex",
    debug: false,
    sanitize: { maxChars: 2000, maxDepth: 4, maxKeys: 50, maxItems: 50 }
  };
  const token = { planId: PLAN_ID, expiresAt: Math.floor(Date.now() / 1000) + 600, plan: PLAN };
  const sessions = withPlan ? { [SESSION]: { intentTokenRaw: JSON.stringify(token), plan: PLAN } } : {};
  await writeFile(config.runtimeFile, JSON.stringify({ sessions }));
  if (rules.length) {
    await writeFile(config.policyFile, JSON.stringify({ version: 1, policy: { rules }, history: [] }));
  }
  return config;
}

async function walRows(config) {
  try {
    const raw = await readFile(path.join(config.dataDir, "audit", "current.jsonl"), "utf8");
    return raw.split("\n").filter(Boolean).map((line) => JSON.parse(line));
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
}

const preToolUse = (config, toolName, toolInput = {}) =>
  handlePreToolUse({ hook_event_name: "PreToolUse", session_id: SESSION, tool_name: toolName, tool_input: toolInput }, config);

test("a tool outside the plan is denied and leaves one blocked row linked to the plan", async () => {
  const config = await setup();
  const decision = await preToolUse(config, "mcp__serena__get_current_config");
  assert.equal(decision?.hookSpecificOutput?.permissionDecision, "deny");
  const rows = await walRows(config);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].status, "blocked");
  assert.equal(rows[0].tool, "mcp__serena__get_current_config");
  assert.equal(rows[0].plan_id, PLAN_ID);
  assert.equal(rows[0].session_id, SESSION);
  assert.equal(rows[0].step_index, null);
  assert.match(rows[0].error_message, /not in plan/);
  assert.equal(rows[0].token, undefined);
});

test("a policy deny leaves a blocked row at the planned step", async () => {
  const config = await setup({ rules: [{ id: "no-bash", action: "deny", tool: "Bash" }] });
  const decision = await preToolUse(config, "Bash", { command: "ls" });
  assert.equal(decision?.hookSpecificOutput?.permissionDecision, "deny");
  const rows = await walRows(config);
  assert.deepEqual(rows.map((row) => [row.status, row.step_index]), [["blocked", 0]]);
});

test("a deny with no plan registered leaves a blocked row without a plan id", async () => {
  const config = await setup({ withPlan: false });
  await preToolUse(config, "Bash", { command: "ls" });
  const rows = await walRows(config);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].status, "blocked");
  assert.equal(rows[0].plan_id, undefined);
  assert.match(rows[0].error_message, /register_intent_plan/);
});

test("monitor mode denies nothing and writes no blocked row", async () => {
  const config = await setup({ mode: "monitor" });
  assert.equal(await preToolUse(config, "mcp__serena__get_current_config"), null);
  assert.deepEqual(await walRows(config), []);
});
