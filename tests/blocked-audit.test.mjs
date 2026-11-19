import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { handlePermissionRequest, handlePostToolUse, handlePostToolUseFailure, handlePreToolUse } from "../plugins/armorcodex/scripts/lib/engine.mjs";
import { signIn } from "./helpers/login.mjs";
import { recordBackendOutcome } from "../plugins/armorcodex/scripts/lib/backend-posture.mjs";
import { auditRows } from "./helpers/audit-rows.mjs";

const PLAN_ID = randomUUID();
const SESSION = "sess-blocked";
const PROMPT_ID = randomUUID();
const TOKEN_PLAN_ID = randomUUID();
const PLAN = { steps: [{ action: "Bash" }, { action: "Read" }], metadata: { goal: "inspect" } };

async function setup({ mode = "enforce", withPlan = true, rules = [] } = {}) {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "armorcodex-blocked-"));
  const config = {
    mode,
    dataDir,
    policyFile: path.join(dataDir, "policy.json"),
    runtimeFile: path.join(dataDir, "runtime.json"),
    apiKey: "ak_test_blockedrow000000000000000000",
    backendEndpoint: "https://audit.invalid",
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
  const sessions = { [SESSION]: {
    promptId: PROMPT_ID,
    ...(withPlan ? { intentTokenRaw: JSON.stringify(token), plan: PLAN, countedPlanId: PLAN_ID, tokenPlanId: TOKEN_PLAN_ID } : {})
  } };
  await writeFile(config.runtimeFile, JSON.stringify({ sessions }));
  if (rules.length) {
    await writeFile(config.policyFile, JSON.stringify({ version: 1, policy: { rules }, history: [] }));
  }
  await recordBackendOutcome(config, "ok");
  return config;
}

async function walRows(config) {
  return auditRows(config.dataDir);
}

const preToolUse = (config, toolName, toolInput = {}) =>
  handlePreToolUse({ hook_event_name: "PreToolUse", session_id: SESSION, tool_name: toolName, tool_input: toolInput }, config);

async function patchSession(config, patch) {
  const state = JSON.parse(await readFile(config.runtimeFile, "utf8"));
  Object.assign(state.sessions[SESSION], patch);
  await writeFile(config.runtimeFile, JSON.stringify(state));
}

for (const scenario of [
  { name: "policy deny", code: "policy_denied", decisionCode: "policy_deny", rules: [{ id: "no-bash", action: "deny", tool: "Bash" }] },
  { name: "missing plan", code: "intent_plan_missing", decisionCode: "missing_plan", withPlan: false, step: null, message: /register_intent_plan/ },
  { name: "tool outside plan", code: "intent_drift", decisionCode: "out_of_scope", tool: "mcp__serena__get_current_config", step: null, message: /not in plan/ },
  { name: "parameters outside plan", code: "intent_parameter_mismatch", decisionCode: "out_of_scope", plan: { steps: [{ action: "Bash", metadata: { inputs: { command: "pwd" } } }] } },
  { name: "empty local plan", code: "intent_plan_empty", decisionCode: "out_of_scope", patch: { intentTokenRaw: "", plan: { steps: [] } }, step: null },
  { name: "expired token", code: "intent_token_expired", decisionCode: "token_expired", expiresAt: 1 },
  { name: "expired local plan", code: "intent_token_expired", decisionCode: "token_expired", patch: { intentTokenRaw: "", expiresAt: 1 } },
  { name: "slow issuance", code: "intent_token_not_issued", decisionCode: "plan_request_failed", pending: true },
  { name: "plan check deny", code: "plan_check_denied", decisionCode: "policy_deny", patch: { planCheck: { deniedTools: ["Bash"], deniedReasons: ["Bash: forbidden"] } } },
  { name: "invalid proof", code: "csrg_proof_invalid", decisionCode: "integrity", input: { csrg_proof: "[invalid" } },
  { name: "missing proof", code: "csrg_proof_missing", decisionCode: "integrity", config: { requireCsrgProofs: true, csrgVerifyEnabled: true, verifyStepEndpoint: "https://verify.test" } },
  { name: "crypto policy mismatch", code: "crypto_policy_mismatch", decisionCode: "integrity", crypto: true, config: { cryptoPolicyEnabled: true } },
  { name: "remote verify failure", code: "remote_verify_failed", decisionCode: "internal_error", verifyFailure: true, config: { csrgVerifyEnabled: true, verifyStepEndpoint: "https://verify.test", maxRetries: 0 } },
  { name: "backend outage", code: "backend_unreachable", decisionCode: "outage", outage: true, config: { backendEndpoint: "https://offline.test", maxRetries: 0 } },
  { name: "approval on PreToolUse", code: "require_approval", decisionCode: "approval_required", status: "held", rules: [{ id: "review", action: "require_approval", tool: "Bash" }] },
  { name: "approval on PermissionRequest", event: "PermissionRequest", code: "require_approval", decisionCode: "approval_required", status: "held", rules: [{ id: "review", action: "require_approval", tool: "Bash" }] },
  { name: "PermissionRequest deny", event: "PermissionRequest", code: "policy_denied", decisionCode: "policy_deny", rules: [{ id: "no-bash", action: "deny", tool: "Bash" }] },
  { name: "missing tool name", code: "missing_tool_name", decisionCode: "internal_error", tool: "", step: null }
]) {
  test(`${scenario.name} writes one coded decision with the plan and prompt in force`, async (t) => {
    const config = await setup(scenario);
    t.after(() => rm(config.dataDir, { recursive: true, force: true }));
    Object.assign(config, scenario.config);
    if (scenario.patch) await patchSession(config, scenario.patch);
    if (scenario.plan || scenario.expiresAt) await patchSession(config, { intentTokenRaw: JSON.stringify({ plan: scenario.plan || PLAN, expiresAt: scenario.expiresAt || Date.now() / 1000 + 600 }) });
    if (scenario.pending) await writeFile(path.join(config.dataDir, `pending-plan.${SESSION}.json`), JSON.stringify({ status: "issuing", deadlineAt: 0 }));
    if (scenario.crypto) await writeFile(path.join(config.dataDir, "crypto-policy-state.json"), JSON.stringify({ policyDigest: "wrong" }));
    if (scenario.verifyFailure) t.mock.method(globalThis, "fetch", async () => { throw new Error("verification unavailable"); });
    if (scenario.outage) t.mock.method(globalThis, "fetch", async () => {
      await patchSession(config, { countedPlanId: "later-plan", tokenPlanId: "later-token", promptId: "later-prompt" });
      return new Response("unavailable", { status: 503 });
    });
    const input = { hook_event_name: scenario.event || "PreToolUse", session_id: SESSION, tool_use_id: "stop-1", tool_name: scenario.tool ?? "Bash", tool_input: { command: "ls" }, ...scenario.input };
    const decision = await (scenario.event === "PermissionRequest" ? handlePermissionRequest : handlePreToolUse)(input, config);
    assert.equal(scenario.event === "PermissionRequest" ? decision?.hookSpecificOutput?.decision?.behavior : decision?.hookSpecificOutput?.permissionDecision, "deny");
    const rows = await walRows(config);
    assert.equal(rows.length, 1);
    const [row] = rows;
    assert.equal(row.status, scenario.status || "blocked");
    assert.equal(row.decision_code, scenario.decisionCode);
    if (scenario.tool === "") {
      assert.deepEqual(Object.keys(row).sort(), ["client_row_id", "session_id", "tool", "action", "input", "executed_at", "decision_code", "status"].sort());
      assert.deepEqual([row.tool, row.action, row.input, row.session_id], ["unknown", "unknown", {}, SESSION]);
      return;
    }
    assert.ok(row.error_message.startsWith(`${scenario.code}: `), row.error_message);
    if (scenario.message) assert.match(row.error_message, scenario.message);
    assert.equal(row.tool, input.tool_name || "unknown");
    assert.equal(row.action, input.tool_name || "unknown");
    assert.equal(row.plan_id, scenario.withPlan === false ? undefined : PLAN_ID);
    assert.equal(row.context_plan_id, scenario.withPlan === false ? undefined : TOKEN_PLAN_ID);
    assert.equal(row.prompt_id, PROMPT_ID);
    assert.equal(row.session_id, SESSION);
    assert.equal(row.step_index, scenario.step === null ? null : 0);
    assert.equal(row.token, undefined);
  });
}

test("the contract pins decision and result ids and the exact ArmorCodex producer mappings", async () => {
  const fixture = JSON.parse(await readFile(new URL("../plugins/armorcodex/tests/fixtures/block-capture-v1.json", import.meta.url), "utf8"));
  const { auditRowId, createAuditEnvelope } = await import("../plugins/armorcodex/scripts/lib/audit-wal.mjs");
  const { DECISION_CODES } = await import("../plugins/armorcodex/scripts/lib/decision-codes.mjs");
  const { SIZE_LIMITS } = await import("../plugins/armorcodex/scripts/lib/audit-contract.mjs");
  assert.deepEqual(SIZE_LIMITS, fixture.sizeLimits);
  for (const vector of fixture.clientRowId.vectors) assert.equal(auditRowId(vector.rootSessionId, vector.toolCallId, vector.phase), vector.clientRowId);
  assert.deepEqual(DECISION_CODES, Object.fromEntries(fixture.reasonCodes.flatMap(({ decisionCode, producers }) => producers.armorcodex.map((code) => [code, decisionCode]))));
  const envelope = createAuditEnvelope({ session_id: SESSION });
  assert.ok(envelope.toolCallId);
  assert.equal(auditRowId(SESSION, envelope.toolCallId, "decision"), envelope.decisionId);
  const continued = createAuditEnvelope({ session_id: SESSION }, envelope.toolCallId);
  assert.equal(continued.decisionId, envelope.decisionId);
});

test("a hold and later deny retain one decision identity and execution has a separate result identity", async (t) => {
  const config = await setup({ rules: [{ id: "review", action: "require_approval", tool: "Bash" }] });
  t.after(() => rm(config.dataDir, { recursive: true, force: true }));
  const input = { session_id: SESSION, root_session_id: "root", tool_use_id: "held-action", tool_name: "Bash", tool_input: {} };
  await handlePreToolUse(input, config);
  await writeFile(config.policyFile, JSON.stringify({ policy: { rules: [{ id: "deny", action: "deny", tool: "Bash" }] } }));
  await handlePermissionRequest(input, config);
  const rows = await walRows(config);
  assert.deepEqual(rows.map((row) => row.status), ["held", "blocked"]);
  assert.equal(new Set(rows.map((row) => row.client_row_id)).size, 1);
  const { auditRowId } = await import("../plugins/armorcodex/scripts/lib/audit-wal.mjs");
  assert.equal(rows[0].client_row_id, auditRowId("root", "held-action", "decision"));
  await handlePostToolUse({ ...input, tool_response: {} }, config);
  const result = (await walRows(config)).at(-1);
  assert.equal(result.client_row_id, auditRowId("root", "held-action", "result"));
  assert.notEqual(result.client_row_id, rows[0].client_row_id);
  assert.equal(result.prompt_id, PROMPT_ID);
  await handlePostToolUseFailure({ ...input, error: "tool failed" }, config);
  const failed = (await walRows(config)).at(-1);
  assert.equal(failed.client_row_id, result.client_row_id);
  assert.equal(failed.plan_id, PLAN_ID);
  assert.equal(failed.context_plan_id, TOKEN_PLAN_ID);
  assert.equal(failed.prompt_id, PROMPT_ID);
});

test("a decision snapshots session ids before an asynchronous verification changes them", async (t) => {
  const config = await setup();
  t.after(() => rm(config.dataDir, { recursive: true, force: true }));
  config.csrgVerifyEnabled = true;
  config.verifyStepEndpoint = "https://verify.test";
  t.mock.method(globalThis, "fetch", async () => {
    await patchSession(config, { countedPlanId: "new-plan", tokenPlanId: "new-token", promptId: "new-prompt" });
    return new Response(JSON.stringify({ allowed: false, reason: "denied" }), { status: 200 });
  });
  await preToolUse(config, "Bash");
  const [row] = await walRows(config);
  assert.deepEqual([row.plan_id, row.context_plan_id, row.prompt_id, row.decision_code], [PLAN_ID, TOKEN_PLAN_ID, PROMPT_ID, "integrity"]);
  assert.match(row.error_message, /^remote_verify_denied: /);
});

test("result rows retain the plan and prompt that authorized the tool", async (t) => {
  const config = await setup();
  t.after(() => rm(config.dataDir, { recursive: true, force: true }));
  const input = { session_id: SESSION, root_session_id: "root", tool_use_id: "call:with:colons", tool_name: "Bash", tool_input: {} };
  assert.equal(await handlePreToolUse(input, config), null);
  const state = JSON.parse(await readFile(config.runtimeFile, "utf8"));
  state.sessions["other-session"] = { ...state.sessions[SESSION], countedPlanId: "other-plan" };
  await writeFile(config.runtimeFile, JSON.stringify(state));
  const other = { ...input, session_id: "other-session", root_session_id: "other-root" };
  assert.equal(await handlePreToolUse(other, config), null);
  await patchSession(config, { countedPlanId: "next-plan", tokenPlanId: "next-token", promptId: "next-prompt" });
  await handlePostToolUse({ ...input, root_session_id: undefined, tool_response: {} }, config);
  const [row] = await walRows(config);
  assert.deepEqual([row.plan_id, row.context_plan_id, row.prompt_id], [PLAN_ID, TOKEN_PLAN_ID, PROMPT_ID]);
  const { auditRowId } = await import("../plugins/armorcodex/scripts/lib/audit-wal.mjs");
  assert.equal(row.client_row_id, auditRowId("root", "call:with:colons", "result"));
  await handlePostToolUseFailure({ ...other, error: "failed" }, config);
  const failed = (await walRows(config)).at(-1);
  assert.equal(failed.plan_id, "other-plan");
  assert.equal(failed.client_row_id, auditRowId("other-root", "call:with:colons", "result"));
});

test("a withheld counted plan keeps its token context without parsing an old token plan id", async (t) => {
  const config = await setup();
  t.after(() => rm(config.dataDir, { recursive: true, force: true }));
  await patchSession(config, { countedPlanId: null });
  await preToolUse(config, "mcp__serena__get_current_config");
  const [row] = await walRows(config);
  assert.equal(row.plan_id, undefined);
  assert.equal(row.context_plan_id, TOKEN_PLAN_ID);
  await patchSession(config, { countedPlanId: TOKEN_PLAN_ID });
  await preToolUse(config, "mcp__serena__get_current_config");
  const matching = (await walRows(config)).at(-1);
  assert.equal(matching.plan_id, TOKEN_PLAN_ID);
  assert.equal(matching.context_plan_id, undefined);
});

test("omitted plan and prompt links stay omitted after a tool runs", async (t) => {
  const config = await setup();
  t.after(() => rm(config.dataDir, { recursive: true, force: true }));
  await patchSession(config, { countedPlanId: null, tokenPlanId: null, promptId: null });
  const input = { session_id: SESSION, tool_use_id: "unlinked-tool", tool_name: "Bash", tool_input: {} };
  assert.equal(await handlePreToolUse(input, config), null);
  await patchSession(config, { countedPlanId: PLAN_ID, tokenPlanId: TOKEN_PLAN_ID, promptId: PROMPT_ID });
  await handlePostToolUse(input, config);
  const [row] = await walRows(config);
  assert.deepEqual([row.plan_id, row.context_plan_id, row.prompt_id], [undefined, undefined, undefined]);
});

// regression: #0010
test("a session from the released version retains its token plan as context", async (t) => {
  const config = await setup();
  t.after(() => rm(config.dataDir, { recursive: true, force: true }));
  const state = JSON.parse(await readFile(config.runtimeFile, "utf8"));
  delete state.sessions[SESSION].countedPlanId;
  delete state.sessions[SESSION].tokenPlanId;
  await writeFile(config.runtimeFile, JSON.stringify(state));
  await handlePostToolUse({ session_id: SESSION, tool_name: "Bash", tool_input: {} }, config);
  const [row] = await walRows(config);
  assert.equal(row.plan_id, undefined);
  assert.equal(row.context_plan_id, PLAN_ID);
});

// regression: #0010
test("a failed result append retains its start snapshot and a damaged start does not break capture", async (t) => {
  const config = await setup();
  t.after(() => rm(config.dataDir, { recursive: true, force: true }));
  const input = { session_id: SESSION, tool_use_id: "retry-result", tool_name: "Bash", tool_input: {} };
  await handlePreToolUse(input, config);
  await writeFile(path.join(config.dataDir, "audit"), "not a directory");
  await assert.rejects(() => handlePostToolUse(input, config), /EEXIST|ENOTDIR/);
  await rm(path.join(config.dataDir, "audit"));
  await patchSession(config, { countedPlanId: "later-plan" });
  await handlePostToolUse(input, config);
  assert.equal((await walRows(config))[0].plan_id, PLAN_ID);
  const { auditRowId } = await import("../plugins/armorcodex/scripts/lib/audit-wal.mjs");
  await writeFile(path.join(config.dataDir, "tool-starts-v1", auditRowId(SESSION, input.tool_use_id, "result")), "{broken");
  await handlePostToolUse({ ...input, tool_use_id: input.tool_use_id, tool_response: {} }, config);
});

// regression: #0010
test("released tool start times are read without changing the released file", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
  const config = await setup();
  t.after(() => rm(config.dataDir, { recursive: true, force: true }));
  const old = path.join(config.dataDir, "tool-starts", "legacy-call");
  await mkdir(path.dirname(old));
  const started = String(Date.now());
  await writeFile(old, started);
  t.mock.timers.tick(150);
  await handlePostToolUse({ session_id: SESSION, tool_use_id: "legacy-call", tool_name: "Bash", tool_input: {} }, config);
  assert.equal((await walRows(config))[0].duration_ms, 150);
  assert.equal(await readFile(old, "utf8"), started);
});

for (const scenario of [
  { name: "invalid JSON", raw: "{invalid", code: "invalid_payload" },
  { name: "empty input", raw: "", code: "invalid_payload" },
  { name: "non object input", raw: "null", code: "invalid_payload" },
  { name: "internal error", internal: true, code: "internal_error" },
  { name: "PermissionRequest internal error", internal: true, event: "PermissionRequest", noRow: true, code: "internal_error" },
  { name: "PostToolUse internal error", internal: true, event: "PostToolUse", noRow: true },
  { name: "PostToolUseFailure internal error", internal: true, event: "PostToolUseFailure", noRow: true },
  { name: "Stop internal error", internal: true, event: "Stop", noRow: true },
  { name: "UserPromptSubmit internal error", internal: true, event: "UserPromptSubmit", noRow: true },
  { name: "unknown login", unknownLogin: true, code: "internal_error" },
  { name: "PermissionRequest unknown login", unknownLogin: true, event: "PermissionRequest", noRow: true, code: "internal_error" },
  { name: "logged out", raw: "{invalid", loggedOut: true, code: "invalid_payload" }
]) {
  // regression: #0010
  test(`router ${scenario.name} captures only a stopped PreToolUse`, async (t) => {
    const home = await mkdtemp(path.join(os.tmpdir(), "armorcodex-fallback-"));
    t.after(() => rm(home, { recursive: true, force: true }));
    const backend = "https://fallback.test";
    if (!scenario.loggedOut) signIn(home, { backend, apiKey: "ak_test_fallback" });
    const dataDir = path.join(home, "data");
    await mkdir(dataDir);
    if (scenario.internal) await mkdir(path.join(dataDir, "runtime.json"));
    const router = new URL("../plugins/armorcodex/scripts/hook-router.mjs", import.meta.url);
    const result = spawnSync(process.execPath, [router.pathname], {
      encoding: "utf8",
      input: scenario.raw ?? JSON.stringify({ hook_event_name: scenario.event || "PreToolUse", session_id: SESSION, tool_name: "Bash", tool_use_id: "broken-call", tool_input: { apiKey: "never-capture-this" } }),
      env: { PATH: process.env.PATH, HOME: home, ARMORCODEX_DATA_DIR: dataDir, BACKEND_ENDPOINT: backend, IAP_ENDPOINT: backend, PROXY_ENDPOINT: backend, ARMORCODEX_OBSERVABILITY_DISABLED: "true", ARMORIQ_ORG_MODE: "enforce", ARMORCODEX_USAGE_SYNC_DISABLED: "true", ...(scenario.unknownLogin ? { ARMORIQ_ENV: "invalid" } : {}) }
    });
    assert.equal(result.status, 0, result.stderr);
    const decision = result.stdout.trim() ? JSON.parse(result.stdout) : null;
    if (!["PostToolUse", "PostToolUseFailure", "Stop", "UserPromptSubmit"].includes(scenario.event)) {
      assert.equal(scenario.event === "PermissionRequest" ? decision.hookSpecificOutput.decision.behavior : decision.hookSpecificOutput.permissionDecision, "deny");
    } else assert.equal(decision, null);
    const rows = await walRows({ dataDir });
    if (scenario.loggedOut || scenario.unknownLogin || scenario.noRow) {
      assert.deepEqual(rows, []);
      if (scenario.unknownLogin && !scenario.noRow) {
        const failures = (await readFile(path.join(dataDir, "audit", "outbox-v1", "capture-failures.jsonl"), "utf8")).trim().split("\n").map(JSON.parse);
        assert.equal(failures.length, 1);
        assert.equal(failures[0].code, scenario.code);
        assert.equal(failures[0].session_id, SESSION);
      }
    } else {
      assert.equal(rows.length, 1);
      assert.deepEqual([rows[0].tool, rows[0].action, rows[0].input, rows[0].status, rows[0].decision_code], ["unknown", "unknown", {}, "blocked", "internal_error"]);
      assert.equal(rows[0].error_message, undefined);
      assert.equal(rows[0].output, undefined);
      assert.equal(rows[0].plan_id, undefined);
      assert.equal(rows[0].prompt_id, undefined);
      assert.ok(!JSON.stringify(rows).includes("never-capture-this"));
    }
  });
}

test("monitor mode denies nothing and writes no blocked row", async () => {
  const config = await setup({ mode: "monitor" });
  assert.equal(await preToolUse(config, "mcp__serena__get_current_config"), null);
  assert.deepEqual(await walRows(config), []);
});

test("a PermissionRequest the policy denies leaves one blocked row, like a PreToolUse deny", async () => {
  const config = await setup({ rules: [{ id: "no-bash", action: "deny", tool: "Bash" }] });
  const decision = await handlePermissionRequest(
    {
      hook_event_name: "PermissionRequest",
      session_id: SESSION,
      tool_name: "Bash",
      tool_input: { command: "touch /etc/outside", description: "May I run touch outside the workspace?" }
    },
    config
  );
  assert.equal(decision?.hookSpecificOutput?.decision?.behavior, "deny");
  const rows = await walRows(config);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].status, "blocked");
  assert.equal(rows[0].tool, "Bash");
  assert.equal(rows[0].plan_id, PLAN_ID);
  assert.equal(rows[0].step_index, 0);
  assert.equal(rows[0].error_message, `policy_denied: ${decision.hookSpecificOutput.decision.message}`);
  assert.equal(rows[0].input.command, "touch /etc/outside");
  assert.equal(rows[0].input.armoriq_policy.source, "local");
  assert.equal(rows[0].input.armoriq_policy.rule_id, "no-bash");
});

test("a PermissionRequest the policy allows writes no row", async () => {
  const config = await setup();
  const decision = await handlePermissionRequest(
    { hook_event_name: "PermissionRequest", session_id: SESSION, tool_name: "Bash", tool_input: { command: "ls" } },
    config
  );
  assert.equal(decision, null);
  assert.deepEqual(await walRows(config), []);
});

// regression: #0010
test("a PermissionRequest without a tool keeps the released allow decision", async (t) => {
  const config = await setup();
  t.after(() => rm(config.dataDir, { recursive: true, force: true }));
  assert.equal(await handlePermissionRequest({ session_id: SESSION }, config), null);
  assert.deepEqual(await walRows(config), []);
});

// regression: #0010
test("monitor mode preserves a policy deny when its audit capture fails", async (t) => {
  const config = await setup({ mode: "monitor", rules: [{ id: "no-bash", action: "deny", tool: "Bash" }] });
  t.after(() => rm(config.dataDir, { recursive: true, force: true }));
  await writeFile(path.join(config.dataDir, "audit"), "not a directory");
  const decision = await preToolUse(config, "Bash");
  assert.equal(decision.hookSpecificOutput.permissionDecision, "deny");
});

// regression: #0010
test("a marketplace copy runs bootstrap router without tests and captures a normal deny", async (t) => {
  const home = await mkdtemp(path.join(os.tmpdir(), "armorcodex-packaged-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const source = new URL("../plugins/armorcodex/", import.meta.url).pathname;
  const plugin = path.join(home, "plugin");
  await cp(source, plugin, { recursive: true, filter: (file) => !["tests", "node_modules", ".git"].includes(path.basename(file)) && !/\.(test|spec)\.(mjs|js)$/.test(file) });
  await mkdir(path.join(plugin, "node_modules"));
  for (const name of ["@armoriq", "@modelcontextprotocol", "zod"]) {
    await symlink(path.join(source, "node_modules", name), path.join(plugin, "node_modules", name));
  }
  const { version } = JSON.parse(await readFile(path.join(plugin, "package.json"), "utf8"));
  await writeFile(path.join(plugin, "node_modules", ".armorcodex-installed"), version);
  const backend = "https://packaging.invalid";
  const dataDir = path.join(home, "data");
  signIn(home, { backend, apiKey: "ak_test_packaging" });
  await mkdir(dataDir);
  await writeFile(path.join(dataDir, "policy.json"), JSON.stringify({ version: 1, policy: { rules: [{ id: "no-shell", action: "deny", tool: "Bash" }] }, history: [] }));
  await recordBackendOutcome({ dataDir, backendEndpoint: backend, apiKey: "ak_test_packaging" }, "ok");
  const result = spawnSync(process.execPath, [path.join(plugin, "scripts", "bootstrap.mjs"), "router"], {
    encoding: "utf8",
    input: JSON.stringify({ hook_event_name: "PreToolUse", session_id: SESSION, tool_use_id: "packaged-call", tool_name: "Bash", tool_input: {} }),
    env: { PATH: process.env.PATH, HOME: home, ARMORCODEX_DATA_DIR: dataDir, BACKEND_ENDPOINT: backend, IAP_ENDPOINT: backend, PROXY_ENDPOINT: backend, ARMORCODEX_OBSERVABILITY_DISABLED: "true", ARMORIQ_ORG_MODE: "enforce", ARMORCODEX_USAGE_SYNC_DISABLED: "true" }
  });
  assert.equal(result.status, 0, result.stderr);
  const decision = JSON.parse(result.stdout).hookSpecificOutput;
  assert.equal(decision.permissionDecision, "deny");
  assert.doesNotMatch(decision.permissionDecisionReason, /internal error|ENOENT/);
  assert.equal((await walRows({ dataDir }))[0]?.decision_code, "policy_deny");
});
