import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { handlePreToolUse, handleUserPromptSubmit } from "../plugins/armorcodex/scripts/lib/engine.mjs";
import { checkToolAgainstPlan } from "../plugins/armorcodex/scripts/lib/intent.mjs";
import { evaluatePolicy } from "../plugins/armorcodex/scripts/lib/policy.mjs";

function buildConfig(tmpDir, overrides = {}) {
  return {
    mode: "enforce",
    dataDir: tmpDir,
    policyFile: path.join(tmpDir, "policy.json"),
    runtimeFile: path.join(tmpDir, "runtime.json"),
    useProduction: false,
    backendEndpoint: "http://127.0.0.1:3000",
    iapEndpoint: "http://127.0.0.1:8000",
    proxyEndpoint: "http://127.0.0.1:3001",
    apiKey: "",
    useSdkIntent: false,
    intentEndpoint: "",
    verifyStepEndpoint: "",
    validitySeconds: 60,
    timeoutMs: 8000,
    maxRetries: 1,
    verifySsl: true,
    llmId: "codex",
    mcpName: "codex",
    userId: "test-user",
    agentId: "test-agent",
    contextId: "default",
    intentRequired: false,
    requireCsrgProofs: true,
    csrgVerifyEnabled: true,
    policyUpdateEnabled: true,
    policyUpdateAllowList: ["*"],
    contextHintsEnabled: true,
    cryptoPolicyEnabled: false,
    auditEnabled: false,
    planningEnabled: false,
    debug: false,
    sanitize: {
      maxChars: 2000,
      maxDepth: 4,
      maxKeys: 50,
      maxItems: 50
    },
    ...overrides
  };
}

test("evaluatePolicy denies matching deny rule", () => {
  const decision = evaluatePolicy({
    policy: {
      rules: [{ id: "policy1", action: "deny", tool: "web_fetch" }]
    },
    toolName: "web_fetch",
    toolParams: { url: "https://example.com" }
  });
  assert.equal(decision.allowed, false);
  assert.match(decision.reason, /policy deny/i);
});

test("checkToolAgainstPlan rejects tool drift", () => {
  const decision = checkToolAgainstPlan({
    plan: { steps: [{ action: "read_file" }] },
    toolName: "web_fetch",
    toolInput: {}
  });
  assert.equal(decision.allowed, false);
  assert.match(decision.reason, /not in plan/i);
});

test("handleUserPromptSubmit applies policy command and blocks prompt", async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "armorcodex-test-"));
  const config = buildConfig(tmp);
  const output = await handleUserPromptSubmit(
    {
      hook_event_name: "UserPromptSubmit",
      session_id: "session-1",
      prompt: "Policy new: block web_fetch for payment data"
    },
    config
  );

  assert.equal(output?.decision, "block");
  assert.match(output?.reason || "", /policy updated/i);
});

test("handlePreToolUse denies when policy blocks tool", async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "armorcodex-test-"));
  const config = buildConfig(tmp);
  await handleUserPromptSubmit(
    {
      hook_event_name: "UserPromptSubmit",
      session_id: "session-2",
      prompt: "Policy new: block write"
    },
    config
  );

  const output = await handlePreToolUse(
    {
      hook_event_name: "PreToolUse",
      session_id: "session-2",
      tool_name: "write",
      tool_input: { file_path: "a.txt" }
    },
    config
  );
  assert.equal(output?.hookSpecificOutput?.permissionDecision, "deny");
});

test("handlePreToolUse denies missing intent when strict", async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "armorcodex-test-"));
  const config = buildConfig(tmp, { intentRequired: true });
  // `Bash` is not in the safe-tools whitelist, so intent enforcement runs.
  const output = await handlePreToolUse(
    {
      hook_event_name: "PreToolUse",
      session_id: "session-3",
      tool_name: "Bash",
      tool_input: { command: "echo hi" }
    },
    config
  );
  assert.equal(output?.hookSpecificOutput?.permissionDecision, "deny");
  assert.match(output?.hookSpecificOutput?.permissionDecisionReason || "", /intent plan missing/i);
});

test("handlePreToolUse allows tool when local plan matches (no backend)", async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "armorcodex-test-"));
  const config = buildConfig(tmp, { intentRequired: true });
  // Seed a local plan as if register_intent_plan had been called
  const { writeFile } = await import("node:fs/promises");
  await writeFile(
    config.runtimeFile,
    JSON.stringify({
      sessions: {
        "local-1": {
          plan: { steps: [{ action: "Read" }], metadata: { goal: "read x" } },
          allowedActions: ["read"],
          updatedAt: Math.floor(Date.now() / 1000)
        }
      }
    }),
    "utf8"
  );
  const output = await handlePreToolUse(
    {
      hook_event_name: "PreToolUse",
      session_id: "local-1",
      tool_name: "Read",
      tool_input: { file_path: "x.txt" }
    },
    config
  );
  assert.equal(output, null);
});

test("handlePreToolUse denies drift when local plan exists (no backend)", async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "armorcodex-test-"));
  const config = buildConfig(tmp, { intentRequired: true });
  const { writeFile } = await import("node:fs/promises");
  await writeFile(
    config.runtimeFile,
    JSON.stringify({
      sessions: {
        "local-2": {
          plan: { steps: [{ action: "Read" }], metadata: { goal: "read x" } },
          allowedActions: ["read"],
          updatedAt: Math.floor(Date.now() / 1000)
        }
      }
    }),
    "utf8"
  );
  const output = await handlePreToolUse(
    {
      hook_event_name: "PreToolUse",
      session_id: "local-2",
      tool_name: "Bash",
      tool_input: { command: "ls" }
    },
    config
  );
  assert.equal(output?.hookSpecificOutput?.permissionDecision, "deny");
  assert.match(output?.hookSpecificOutput?.permissionDecisionReason || "", /intent drift|not in plan/i);
});

test("handlePreToolUse replaces stale local plan with fresh pending-plan.json", async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "armorcodex-test-"));
  const config = buildConfig(tmp, { intentRequired: true });
  const { writeFile } = await import("node:fs/promises");
  // Seed an old "Read"-only plan in the session
  await writeFile(
    config.runtimeFile,
    JSON.stringify({
      sessions: {
        "multi-1": {
          plan: { steps: [{ action: "Read" }], metadata: { goal: "old read" } },
          allowedActions: ["read"],
          updatedAt: Math.floor(Date.now() / 1000)
        }
      }
    }),
    "utf8"
  );
  // Drop a NEW pending plan that allows Bash (simulates register_intent_plan)
  await writeFile(
    path.join(tmp, "pending-plan.json"),
    JSON.stringify({
      plan: { steps: [{ action: "Bash" }], metadata: { goal: "list etc" } },
      tokenRaw: "",
      allowedActions: ["bash"],
      registeredAt: Date.now()
    }),
    "utf8"
  );
  const output = await handlePreToolUse(
    {
      hook_event_name: "PreToolUse",
      session_id: "multi-1",
      tool_name: "Bash",
      tool_input: { command: "ls /etc" }
    },
    config
  );
  assert.equal(output, null, "Bash should be allowed under the freshly registered plan");
});

test("handleUserPromptSubmit adds context hints for normal prompts", async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "armorcodex-test-"));
  const config = buildConfig(tmp, { contextHintsEnabled: true, policyUpdateEnabled: true });
  const output = await handleUserPromptSubmit(
    {
      hook_event_name: "UserPromptSubmit",
      session_id: "session-4",
      prompt: "summarize this file"
    },
    config
  );
  assert.equal(output?.hookSpecificOutput?.hookEventName, "UserPromptSubmit");
  assert.match(output?.hookSpecificOutput?.additionalContext || "", /policy_update/i);
});

test("evaluatePolicy: trailing-* glob scopes a tool family; exact match unchanged", () => {
  const policy = {
    rules: [
      { id: "p1", action: "deny", tool: "mcp__github__*" },
      { id: "p2", action: "deny", tool: "bash" }
    ]
  };
  const ev = (tool) => evaluatePolicy({ policy, toolName: tool, toolParams: {} }).allowed;
  assert.equal(ev("mcp__github__search"), false); // glob prefix
  assert.equal(ev("mcp__github__create_pr"), false); // glob prefix
  assert.equal(ev("mcp__gitlab__search"), true); // different server, not matched
  assert.equal(ev("bash"), false); // exact match, unchanged
  assert.equal(ev("apply_patch"), true); // no rule -> default allow
});
