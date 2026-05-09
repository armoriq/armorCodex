import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  handleSessionStart,
  handleSessionEnd,
  handleStop,
  handlePostToolUse,
  handlePostToolUseFailure
} from "../scripts/lib/engine.mjs";

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
    csrgEndpoint: "http://127.0.0.1:8000",
    apiKey: "",
    useSdkIntent: false,
    intentEndpoint: "",
    verifyStepEndpoint: "",
    validitySeconds: 60,
    timeoutMs: 5000,
    maxRetries: 1,
    verifySsl: true,
    llmId: "codex",
    mcpName: "codex",
    userId: "test-user",
    agentId: "test-agent",
    contextId: "default",
    intentRequired: true,
    requireCsrgProofs: true,
    csrgVerifyEnabled: true,
    policyUpdateEnabled: true,
    policyUpdateAllowList: ["*"],
    contextHintsEnabled: true,
    cryptoPolicyEnabled: false,
    auditEnabled: false,
    planningEnabled: false,
    planningApiKey: "",
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

test("handleSessionStart creates session and returns context", async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "armorcodex-test-"));
  const config = buildConfig(tmp);
  const output = await handleSessionStart(
    { hook_event_name: "SessionStart", session_id: "sess-1", source: "startup" },
    config
  );
  assert.ok(output?.hookSpecificOutput?.additionalContext);
  assert.match(output.hookSpecificOutput.additionalContext, /ArmorCodex active/i);

  // Verify session was persisted
  const stateRaw = await readFile(config.runtimeFile, "utf8");
  const state = JSON.parse(stateRaw);
  assert.ok(state.sessions["sess-1"]);
  assert.ok(state.sessions["sess-1"].startedAt);
});

test("handleSessionEnd removes session", async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "armorcodex-test-"));
  const config = buildConfig(tmp);
  // Create session first
  await handleSessionStart(
    { hook_event_name: "SessionStart", session_id: "sess-2" },
    config
  );
  // End it
  await handleSessionEnd(
    { hook_event_name: "SessionEnd", session_id: "sess-2" },
    config
  );

  const stateRaw = await readFile(config.runtimeFile, "utf8");
  const state = JSON.parse(stateRaw);
  assert.equal(state.sessions["sess-2"], undefined);
});

test("handleStop returns null", async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "armorcodex-test-"));
  const config = buildConfig(tmp);
  await handleSessionStart(
    { hook_event_name: "SessionStart", session_id: "sess-3" },
    config
  );
  const output = await handleStop(
    { hook_event_name: "Stop", session_id: "sess-3" },
    config
  );
  assert.equal(output, null);
});

test("handlePostToolUse returns null when audit disabled", async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "armorcodex-test-"));
  const config = buildConfig(tmp, { auditEnabled: false });
  const output = await handlePostToolUse(
    {
      hook_event_name: "PostToolUse",
      session_id: "sess-4",
      tool_name: "Read",
      tool_input: { file_path: "test.txt" },
      tool_response: { content: "hello" }
    },
    config
  );
  assert.equal(output, null);
});

test("handlePostToolUse sends audit when enabled", async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "armorcodex-test-"));
  const config = buildConfig(tmp, { auditEnabled: true, apiKey: "test-key" });
  await handleSessionStart(
    { hook_event_name: "SessionStart", session_id: "sess-5" },
    config
  );

  const originalFetch = globalThis.fetch;
  let capturedPayload;
  globalThis.fetch = async (_url, options) => {
    capturedPayload = JSON.parse(options.body);
    return new Response(
      JSON.stringify({ audit_id: "a1", iap_sync_status: "ok" }),
      { status: 200, headers: { "content-type": "application/json" } }
    );
  };

  try {
    const output = await handlePostToolUse(
      {
        hook_event_name: "PostToolUse",
        session_id: "sess-5",
        tool_name: "Read",
        tool_input: { file_path: "test.txt" },
        tool_response: { content: "hello" }
      },
      config
    );
    assert.equal(output, null);
    assert.equal(capturedPayload.action, "Read");
    assert.equal(capturedPayload.status, "success");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("handlePostToolUseFailure logs failed status", async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "armorcodex-test-"));
  const config = buildConfig(tmp, { auditEnabled: true, apiKey: "test-key" });
  await handleSessionStart(
    { hook_event_name: "SessionStart", session_id: "sess-6" },
    config
  );

  const originalFetch = globalThis.fetch;
  let capturedPayload;
  globalThis.fetch = async (_url, options) => {
    capturedPayload = JSON.parse(options.body);
    return new Response(
      JSON.stringify({ audit_id: "a2", iap_sync_status: "ok" }),
      { status: 200, headers: { "content-type": "application/json" } }
    );
  };

  try {
    await handlePostToolUseFailure(
      {
        hook_event_name: "PostToolUseFailure",
        session_id: "sess-6",
        tool_name: "Bash",
        tool_input: { command: "exit 1" },
        error: "Command failed with exit code 1"
      },
      config
    );
    assert.equal(capturedPayload.status, "failed");
    assert.equal(capturedPayload.error_message, "Command failed with exit code 1");
  } finally {
    globalThis.fetch = originalFetch;
  }
});
