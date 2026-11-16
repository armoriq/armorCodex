import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { mkdtemp, writeFile } from "node:fs/promises";
import { handlePreToolUse } from "../plugins/armorcodex/scripts/lib/engine.mjs";
import { normalizeIntentPlan } from "../plugins/armorcodex/scripts/lib/intent-schema.mjs";

function startTokenRecorder() {
  const bodies = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      if (req.url === "/iap/sdk/token") bodies.push(JSON.parse(body));
      res.writeHead(403, { "content-type": "application/json" });
      res.end('{"message":"recorder"}');
    });
  });
  return new Promise((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve({ server, bodies, url: `http://127.0.0.1:${server.address().port}` }))
  );
}

async function setup() {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "armorcodex-hook-plan-"));
  const recorder = await startTokenRecorder();
  const config = {
    mode: "enforce",
    dataDir,
    policyFile: path.join(dataDir, "policy.json"),
    runtimeFile: path.join(dataDir, "runtime.json"),
    backendEndpoint: recorder.url,
    iapEndpoint: recorder.url,
    proxyEndpoint: recorder.url,
    csrgEndpoint: recorder.url,
    apiKey: "ak_test_hookplan000000000000000000",
    useSdkIntent: true,
    intentEndpoint: "",
    verifyStepEndpoint: "",
    validitySeconds: 60,
    timeoutMs: 2000,
    maxRetries: 0,
    verifySsl: true,
    llmId: "codex",
    mcpName: "codex",
    userId: "test-user",
    agentId: "test-agent",
    contextId: "default",
    intentRequired: true,
    requireCsrgProofs: false,
    csrgVerifyEnabled: false,
    cryptoPolicyEnabled: false,
    auditEnabled: false,
    debug: false,
    sanitize: { maxChars: 2000, maxDepth: 4, maxKeys: 50, maxItems: 50 }
  };
  return { config, recorder };
}

const preToolUse = (config, sessionId) =>
  handlePreToolUse(
    { hook_event_name: "PreToolUse", session_id: sessionId, tool_name: "Bash", tool_input: { command: "ls" } },
    config
  );

test("PreToolUse enforces a registered plan without a token and never asks for one", async () => {
  const { config, recorder } = await setup();
  try {
    const plan = normalizeIntentPlan({
      goal: "edit a file and track progress",
      steps: [{ action: "Bash" }, { action: "apply_patch" }, { action: "update_plan" }]
    });
    await writeFile(
      path.join(config.dataDir, "pending-plan.s1.json"),
      JSON.stringify({ plan, tokenRaw: "", allowedActions: [], registeredAt: Date.now() })
    );
    assert.equal(await preToolUse(config, "s1"), null);
    assert.equal(recorder.bodies.length, 0);
  } finally {
    recorder.server.close();
  }
});

test("PreToolUse with no registered plan denies without asking for a token", async () => {
  const { config, recorder } = await setup();
  try {
    const output = await preToolUse(config, "s2");
    assert.equal(recorder.bodies.length, 0);
    assert.equal(output?.hookSpecificOutput?.permissionDecision, "deny");
    assert.match(output.hookSpecificOutput.permissionDecisionReason, /register_intent_plan/);
  } finally {
    recorder.server.close();
  }
});
