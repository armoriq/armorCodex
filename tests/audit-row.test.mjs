import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import fs, { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import os from "node:os";
import path from "node:path";
import { handlePostToolUse, handlePostToolUseFailure, handlePreToolUse } from "../plugins/armorcodex/scripts/lib/engine.mjs";
import { createAuditWal } from "../plugins/armorcodex/scripts/lib/audit-wal.mjs";
import { recordBackendOutcome } from "../plugins/armorcodex/scripts/lib/backend-posture.mjs";
import { auditRows } from "./helpers/audit-rows.mjs";

const { sizeLimits } = JSON.parse(await readFile(new URL("../plugins/armorcodex/tests/fixtures/block-capture-v1.json", import.meta.url), "utf8"));
const WAL_LINE_CAP = 4000;
const PLAN_ID = randomUUID();
const SESSION = "sess-audit";
const PLAN = { steps: [{ action: "Bash" }, { action: "Read" }], metadata: { goal: "inspect" } };

function sdkIntentToken() {
  return {
    planId: PLAN_ID,
    planHash: "plan-hash",
    expiresAt: Math.floor(Date.now() / 1000) + 600,
    rawToken: { plan: PLAN, plan_id: PLAN_ID },
    jwtToken: `eyJhbGciOiJFUzI1NiJ9.${"a".repeat(16_200)}.sig`
  };
}

async function setup() {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "armorcodex-audit-row-"));
  const config = {
    mode: "enforce",
    dataDir,
    policyFile: path.join(dataDir, "policy.json"),
    runtimeFile: path.join(dataDir, "runtime.json"),
    apiKey: "ak_test_auditrow0000000000000000000",
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
  await writeFile(
    config.runtimeFile,
    JSON.stringify({ sessions: { [SESSION]: { intentTokenRaw: JSON.stringify(sdkIntentToken()), plan: PLAN, countedPlanId: PLAN_ID, tokenPlanId: PLAN_ID } } })
  );
  await recordBackendOutcome(config, "ok");
  return config;
}

async function walRows(config) {
  return auditRows(config.dataDir);
}

const post = (config, extra) =>
  handlePostToolUse(
    { hook_event_name: "PostToolUse", session_id: SESSION, tool_name: "Bash", tool_input: { command: "ls" }, tool_response: { ok: true }, ...extra },
    config
  );

// regression: #0007
test("audit rows reference the plan by id and carry no token, so a 16 KB token still ships", async (t) => {
  const config = await setup();
  assert.ok(JSON.stringify(sdkIntentToken()).length > 16_000);
  await post(config);
  await handlePostToolUseFailure(
    { hook_event_name: "PostToolUseFailure", session_id: SESSION, tool_name: "Read", tool_input: { file_path: "x" }, error: "missing" },
    config
  );
  const rows = await walRows(config);
  assert.deepEqual(rows.map((row) => [row.tool, row.status, row.step_index]), [["Bash", "success", 0], ["Read", "failed", 1]]);
  for (const row of rows) {
    assert.equal(row.token, undefined);
    assert.equal(row.plan_id, PLAN_ID);
    assert.equal(row.session_id, SESSION);
    assert.equal(row.user_id, "user-login");
    assert.equal(row.agent_id, "codex");
    assert.equal(row.client_id, "codex");
    assert.ok(Buffer.byteLength(JSON.stringify(row)) <= WAL_LINE_CAP);
  }
  const originalOpen = fs.open;
  const originalWrite = fs.writeFile;
  const failLock = (original) => (file, ...args) => {
    if (file === `${config.runtimeFile}.lock`) return Promise.reject(new Error("runtime lock unavailable"));
    return original(file, ...args);
  };
  const opening = t.mock.method(fs, "open", failLock(originalOpen));
  const writing = t.mock.method(fs, "writeFile", failLock(originalWrite));
  syncBuiltinESMExports();
  try {
    await assert.rejects(post(config), /runtime lock unavailable/);
    await assert.rejects(handlePostToolUseFailure(
      { session_id: SESSION, tool_name: "Read", tool_input: {}, error: "missing" }, config
    ), /runtime lock unavailable/);
    assert.deepEqual((await walRows(config)).map((row) => row.status), ["success", "failed", "success", "failed"]);
  } finally {
    opening.mock.restore();
    writing.mock.restore();
    syncBuiltinESMExports();
  }
});

// regression: #0010
test("an oversized tool output is cut to the released content limit and marked truncated", async () => {
  const config = await setup();
  const big = Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`k${i}`, "x".repeat(1500)]));
  await post(config, { tool_response: big });
  const [row] = await walRows(config);
  assert.ok(row, "expected one audit row");
  assert.deepEqual(row.output, sizeLimits.truncationMarker);
  assert.ok(Buffer.byteLength(JSON.stringify(row)) <= WAL_LINE_CAP);
});

// regression: #0010
test("long tool errors use a marker within the released content limit", async () => {
  const config = await setup();
  await handlePostToolUseFailure({ session_id: SESSION, tool_name: "Bash", tool_input: {}, error: "x".repeat(60_000) }, config);
  const [row] = await walRows(config);
  assert.equal(row.error_message, JSON.stringify(sizeLimits.truncationMarker));
  assert.ok(Buffer.byteLength(JSON.stringify(row)) <= WAL_LINE_CAP);
});

test("duration_ms carries the time between PreToolUse and PostToolUse for the same call", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
  const config = await setup();
  const toolUseId = "call_duration_1";
  await handlePreToolUse(
    { hook_event_name: "PreToolUse", session_id: SESSION, tool_name: "Bash", tool_use_id: toolUseId, tool_input: { command: "ls" } },
    config
  );
  t.mock.timers.tick(150);
  await post(config, { tool_use_id: toolUseId });
  const [row] = await walRows(config);
  assert.equal(row.duration_ms, 150);
});

test("metadata that cannot fit is preserved in a counted dead letter", async () => {
  const config = await setup();
  const tool = `tool_${"z".repeat(WAL_LINE_CAP)}`;
  await post(config, { tool_name: tool });
  assert.deepEqual(await walRows(config), []);
  const wal = createAuditWal({ dataDir: config.dataDir, config });
  const [dead] = await wal.readDeadLetters();
  assert.equal(dead.row.tool, tool);
  assert.equal(dead.reason, "oversize");
  assert.equal(dead.attempts, 0);
  assert.equal((await wal.status()).deadLetters, 1);
});

for (const failed of [false, true]) {
  // regression: #0012
  test(`a repeated ${failed ? "failed" : "successful"} result keeps its captured plan while another prompt changes runtime`, async () => {
    const config = await setup();
    const input = { session_id: SESSION, tool_name: "Bash", tool_use_id: "concurrent-result", tool_input: { command: "ls" } };
    await handlePreToolUse(input, config);
    const result = () => failed ? handlePostToolUseFailure({ ...input, error: "missing" }, config) : post(config, input);
    await result();
    const { withRuntimeState } = await import("../plugins/armorcodex/scripts/lib/runtime-state.mjs");
    await withRuntimeState(config.runtimeFile, (state) => {
      Object.assign(state.sessions[SESSION], { countedPlanId: "later-plan", tokenPlanId: "later-token", promptId: "later-prompt", plan: null });
    });
    await result();
    const rows = await walRows(config);
    assert.equal(rows.length, 2);
    assert.equal(new Set(rows.map(({ client_row_id }) => client_row_id)).size, 1);
    assert.deepEqual(rows.map(({ plan_id, step_index }) => [plan_id, step_index]), [[PLAN_ID, 0], [PLAN_ID, 0]]);
  });
}
