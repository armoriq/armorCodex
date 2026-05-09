import test from "node:test";
import assert from "node:assert/strict";
import { createIapService } from "../scripts/lib/iap-service.mjs";

function buildConfig(overrides = {}) {
  return {
    backendEndpoint: "http://127.0.0.1:3000",
    csrgEndpoint: "http://127.0.0.1:8000",
    verifyStepEndpoint: "http://127.0.0.1:3000/iap/verify-step",
    csrgVerifyEnabled: true,
    requireCsrgProofs: true,
    apiKey: "test-key",
    timeoutMs: 5000,
    ...overrides
  };
}

test("verifyStep skips when no endpoint configured", async () => {
  const svc = createIapService(buildConfig({ verifyStepEndpoint: "" }));
  const result = await svc.verifyStep("token", null, "Read");
  assert.equal(result.skipped, true);
});

test("verifyStep skips when csrg verification disabled", async () => {
  const svc = createIapService(buildConfig({ csrgVerifyEnabled: false }));
  const result = await svc.verifyStep("token", null, "Read");
  assert.equal(result.skipped, true);
});

test("verifyStep returns not-allowed when token missing", async () => {
  const svc = createIapService(buildConfig());
  const result = await svc.verifyStep("", null, "Read");
  assert.equal(result.allowed, false);
  assert.match(result.reason, /token missing/i);
});

test("verifyStep sends correct payload", async () => {
  const originalFetch = globalThis.fetch;
  let capturedUrl, capturedPayload;
  globalThis.fetch = async (url, options) => {
    capturedUrl = url;
    capturedPayload = JSON.parse(options.body);
    return new Response(
      JSON.stringify({ allowed: true, reason: "ok", step: { step_index: 0 } }),
      { status: 200, headers: { "content-type": "application/json" } }
    );
  };

  try {
    const svc = createIapService(buildConfig());
    const result = await svc.verifyStep(
      JSON.stringify({ jwtToken: "jwt-abc" }),
      { path: "/steps/[1]/action", proof: [{ position: "left", sibling_hash: "x" }] },
      "Write"
    );
    assert.equal(capturedUrl, "http://127.0.0.1:3000/iap/verify-step");
    assert.equal(capturedPayload.token, "jwt-abc");
    assert.equal(capturedPayload.tool_name, "Write");
    assert.equal(capturedPayload.path, "/steps/[1]/action");
    assert.equal(result.allowed, true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("createAuditLog sends correct payload", async () => {
  const originalFetch = globalThis.fetch;
  let capturedUrl, capturedPayload;
  globalThis.fetch = async (url, options) => {
    capturedUrl = url;
    capturedPayload = JSON.parse(options.body);
    return new Response(
      JSON.stringify({ audit_id: "audit-123", iap_sync_status: "synced" }),
      { status: 200, headers: { "content-type": "application/json" } }
    );
  };

  try {
    const svc = createIapService(buildConfig());
    const result = await svc.createAuditLog({
      token: "jwt-abc",
      step_index: 0,
      action: "Read",
      tool: "Read",
      input: { file_path: "test.txt" },
      output: { content: "hello" },
      status: "success",
      executed_at: "2026-04-10T00:00:00Z",
      duration_ms: 100
    });
    assert.equal(capturedUrl, "http://127.0.0.1:3000/iap/audit");
    assert.equal(capturedPayload.token, "jwt-abc");
    assert.equal(capturedPayload.action, "Read");
    assert.equal(result.audit_id, "audit-123");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("verifyWithCsrg sends Merkle proof payload", async () => {
  const originalFetch = globalThis.fetch;
  let capturedPayload;
  globalThis.fetch = async (_url, options) => {
    capturedPayload = JSON.parse(options.body);
    return new Response(
      JSON.stringify({ allowed: true, reason: "verified" }),
      { status: 200, headers: { "content-type": "application/json" } }
    );
  };

  try {
    const svc = createIapService(buildConfig());
    const result = await svc.verifyWithCsrg(
      "/steps/[0]/action",
      { tool: "Read" },
      [{ position: "left", sibling_hash: "abc" }],
      { plan_hash: "xyz" },
      { source: "test" }
    );
    assert.equal(capturedPayload.path, "/steps/[0]/action");
    assert.deepEqual(capturedPayload.value, { tool: "Read" });
    assert.equal(result.allowed, true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("csrgProofsRequired reflects config", () => {
  assert.equal(createIapService(buildConfig({ requireCsrgProofs: true })).csrgProofsRequired(), true);
  assert.equal(createIapService(buildConfig({ requireCsrgProofs: false })).csrgProofsRequired(), false);
});
