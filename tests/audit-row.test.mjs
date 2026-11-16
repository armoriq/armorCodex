import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { handlePostToolUse, handlePostToolUseFailure, handlePreToolUse } from "../plugins/armorcodex/scripts/lib/engine.mjs";

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
    JSON.stringify({ sessions: { [SESSION]: { intentTokenRaw: JSON.stringify(sdkIntentToken()), plan: PLAN } } })
  );
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

const post = (config, extra) =>
  handlePostToolUse(
    { hook_event_name: "PostToolUse", session_id: SESSION, tool_name: "Bash", tool_input: { command: "ls" }, tool_response: { ok: true }, ...extra },
    config
  );

test("audit rows reference the plan by id and carry no token, so a 16 KB token still ships", async () => {
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
});

test("an oversized tool output is cut to fit and marked truncated", async () => {
  const config = await setup();
  const big = Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`k${i}`, "x".repeat(1500)]));
  await post(config, { tool_response: big });
  const [row] = await walRows(config);
  assert.ok(row, "expected one audit row");
  assert.equal(row.output.truncated, true);
  assert.ok(row.output.originalBytes > 50_000);
  assert.ok(Buffer.byteLength(JSON.stringify(row)) <= WAL_LINE_CAP);
});

test("duration_ms carries the time between PreToolUse and PostToolUse for the same call", async () => {
  const config = await setup();
  const toolUseId = "call_duration_1";
  await handlePreToolUse(
    { hook_event_name: "PreToolUse", session_id: SESSION, tool_name: "Bash", tool_use_id: toolUseId, tool_input: { command: "ls" } },
    config
  );
  await new Promise((resolve) => setTimeout(resolve, 150));
  await post(config, { tool_use_id: toolUseId });
  const [row] = await walRows(config);
  assert.ok(row.duration_ms >= 140 && row.duration_ms < 5000, `duration_ms ${row.duration_ms}`);
});

test("a row that cannot fit even after cutting is reported on stderr, not dropped silently", async () => {
  const config = await setup();
  const written = [];
  const original = process.stderr.write;
  process.stderr.write = (chunk, ...rest) => {
    written.push(String(chunk));
    return original.call(process.stderr, chunk, ...rest);
  };
  try {
    await post(config, { tool_name: `tool_${"z".repeat(5000)}` });
  } finally {
    process.stderr.write = original;
  }
  assert.deepEqual(await walRows(config), []);
  assert.ok(written.some((line) => /audit row rejected/.test(line)), written.join(""));
});
