import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { loadConfig } from "../plugins/armorcodex/scripts/lib/config.mjs";
import { handlePreToolUse } from "../plugins/armorcodex/scripts/lib/engine.mjs";
import { beginPrompt, syncSessionAuth, withRuntimeState } from "../plugins/armorcodex/scripts/lib/runtime-state.mjs";
import { recordBackendOutcome } from "../plugins/armorcodex/scripts/lib/backend-posture.mjs";
import { signIn, withHome } from "./helpers/login.mjs";

const requirePlugin = createRequire(new URL("../plugins/armorcodex/package.json", import.meta.url));
const { Client } = requirePlugin("@modelcontextprotocol/sdk/client/index.js");
const { StdioClientTransport } = requirePlugin("@modelcontextprotocol/sdk/client/stdio.js");
const SERVER = fileURLToPath(new URL("../plugins/armorcodex/scripts/policy-mcp.mjs", import.meta.url));
const SANDBOX = fileURLToPath(new URL("./helpers/mcp-sandbox.mjs", import.meta.url));
const SESSION = "sess-sync";

async function withServer(replies, fn) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "armorcodex-sync-reg-"));
  const dataDir = path.join(home, "data");
  const requestsPath = path.join(home, "intents.json");
  const preload = path.join(home, "intent.mjs");
  fs.writeFileSync(preload, `
import fs from "node:fs";
const originalFetch = globalThis.fetch;
const requests = [];
const replies = ${JSON.stringify(replies)};
globalThis.fetch = async (url, init) => {
  if (String(url) !== "https://sync.test/intent") return originalFetch(url, init);
  const payload = JSON.parse(init.body);
  requests.push(payload);
  fs.writeFileSync(${JSON.stringify(requestsPath)}, JSON.stringify(requests));
  const row = replies[Math.min(requests.length - 1, replies.length - 1)];
  if (row.defer) {
    const released = new Promise((resolve) => {
      let incoming = "";
      process.stdin.on("data", (chunk) => {
        incoming += chunk;
        const lines = incoming.split("\\n");
        incoming = lines.pop();
        for (const line of lines) if (JSON.parse(line).params?.name === "policy_read") resolve();
      });
    });
    process.stderr.write("sync-request\\n");
    await released;
  }
  const token = JSON.stringify({ plan: payload.plan, expiresAt: Math.floor(Date.now() / 1000) + 600 });
  return new Response(JSON.stringify(row.status ? { message: "request refused" } : {
    plan_id: "11111111-1111-4111-8111-" + String(requests.length).padStart(12, "0"),
    kind: init.headers["X-ArmorIQ-Plan-Kind"], intentTokenRaw: token
  }), { status: row.status || 200, headers: { "content-type": "application/json" } });
};
`);
  const env = {
    ARMORCODEX_DATA_DIR: dataDir, ARMORCODEX_INTENT_URL: "https://sync.test/intent", ARMORCODEX_MODE: "enforce", ARMORIQ_ORG_MODE: "enforce",
    ARMORCODEX_OBSERVABILITY_DISABLED: "true", ARMORCODEX_USAGE_SYNC_DISABLED: "true"
  };
  signIn(home, { backend: withHome(home, () => loadConfig(env)).backendEndpoint, apiKey: "ak_test_sync0000000000000000000000" });
  const config = withHome(home, () => loadConfig(env));
  await recordBackendOutcome(config, "ok");
  await withRuntimeState(config.runtimeFile, (state) => beginPrompt(syncSessionAuth(state, SESSION, config), "inspect files"));
  const transport = new StdioClientTransport({
    command: process.execPath, args: ["--import", SANDBOX, "--import", preload, SERVER],
    env: { HOME: home, ARMORCODEX_TEST_HOME: home, TMPDIR: os.tmpdir(), ...env }, stderr: "pipe"
  });
  let requested;
  const tokenRequested = new Promise((resolve) => { requested = resolve; });
  transport.stderr.on("data", (chunk) => { if (String(chunk).includes("sync-request")) requested(); });
  const client = new Client({ name: "sync-registration-test", version: "0.0.0" });
  await client.connect(transport);
  const registerArgs = async (args) => {
    const result = await client.callTool({ name: "register_intent_plan", arguments: args, _meta: { sessionId: SESSION } });
    return result.content[0].text;
  };
  const register = (goal, action = "Bash") => registerArgs({ goal, steps: [{ action }] });
  const preToolUse = (toolName = "Bash") => handlePreToolUse(
    { hook_event_name: "PreToolUse", session_id: SESSION, tool_name: toolName, tool_input: { command: "ls" } }, config
  );
  const pendingPath = path.join(dataDir, `pending-plan.${SESSION}.json`);
  const pending = () => (fs.existsSync(pendingPath) ? JSON.parse(fs.readFileSync(pendingPath, "utf8")) : null);
  const backend = { get requests() { return fs.existsSync(requestsPath) ? JSON.parse(fs.readFileSync(requestsPath, "utf8")) : []; } };
  try {
    await fn({ register, registerArgs, preToolUse, pending, backend, config, tokenRequested, release: () => client.callTool({ name: "policy_read", arguments: {} }) });
  } finally {
    await client.close();
    fs.rmSync(home, { recursive: true, force: true });
  }
}

test("register_intent_plan returns only after the token and never leaves a plan without its token", async () => {
  await withServer([{ defer: true }], async ({ register, pending, tokenRequested, release }) => {
    let returned = false;
    const registering = register("list files").then((reply) => { returned = true; return reply; });
    await tokenRequested;
    assert.equal(returned, false);
    assert.equal(pending().status, "issuing");
    assert.equal(pending().plan, undefined);
    await release();
    assert.match(await registering, /Intent registered: plan .* \(new\), 1 steps\. Token valid until /);
    assert.ok(pending().tokenRaw);
    assert.ok(pending().plan);
  });
});

test("a PreToolUse fired while the token is issuing waits, then allows the planned tool", async () => {
  await withServer([{ defer: true }], async ({ register, preToolUse, backend, tokenRequested, release }) => {
    const registering = register("list files");
    await tokenRequested;
    const checking = preToolUse();
    await release();
    assert.equal(await checking, null);
    await registering;
    assert.equal(backend.requests.length, 1);
  });
});

test("when issuance is refused, nothing is stored and PreToolUse denies without asking for a token", async () => {
  await withServer([{ status: 422 }], async ({ register, preToolUse, pending, backend }) => {
    assert.equal(await register("list files"), "Plan not registered: request refused.");
    assert.equal(pending(), null);
    const decision = await preToolUse();
    assert.equal(decision?.hookSpecificOutput?.permissionDecision, "deny");
    assert.equal(backend.requests.length, 1);
  });
});

test("two registrations in one session end with the newer plan on disk", async () => {
  await withServer([{}], async ({ register, pending }) => {
    const [first, second] = await Promise.all([register("first", "Read"), register("second", "Bash")]);
    assert.match(first, /\(new\), 1 steps/);
    assert.match(second, /\(revision\), 1 steps/);
    assert.deepEqual(pending().plan.steps.map((step) => step.action), ["Bash"]);
  });
});

test("PreToolUse never asks the backend for a token, even close to expiry", async () => {
  await withServer([{}], async ({ register, preToolUse, backend, config }) => {
    await register("list files");
    await preToolUse();
    const runtime = JSON.parse(fs.readFileSync(config.runtimeFile, "utf8"));
    runtime.sessions[SESSION].expiresAt = Math.floor(Date.now() / 1000) + 5;
    fs.writeFileSync(config.runtimeFile, JSON.stringify(runtime));
    await preToolUse();
    assert.equal(backend.requests.length, 1);
  });
});

test("a PreToolUse after the issuing deadline denies and asks for a new registration", async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "armorcodex-sync-deadline-"));
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
  try {
    const config = withHome(dataDir, () => loadConfig({ ARMORCODEX_DATA_DIR: dataDir, ARMORCODEX_MODE: "enforce" }));
    fs.writeFileSync(path.join(dataDir, `pending-plan.${SESSION}.json`), JSON.stringify({ status: "issuing", startedAt: Date.now(), deadlineAt: Date.now() + 300 }));
    t.mock.timers.tick(300);
    const decision = await handlePreToolUse({ hook_event_name: "PreToolUse", session_id: SESSION, tool_name: "Bash", tool_input: {} }, config);
    assert.equal(decision?.hookSpecificOutput?.permissionDecision, "deny");
    assert.match(decision.hookSpecificOutput.permissionDecisionReason, /not issued in time: call register_intent_plan again/);
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("a plan with steps and no goal registers, with the goal derived from the steps", async () => {
  await withServer([{}], async ({ registerArgs, backend }) => {
    const reply = await registerArgs({ steps: [{ action: "Write", description: "write notes.txt" }, { action: "Bash", description: " " }] });
    assert.match(reply, /\(new\), 2 steps\. Token valid until /);
    assert.equal(backend.requests.length, 1);
    assert.equal(backend.requests[0].plan.metadata.goal, "write notes.txt; Bash");
  });
});

test("a plan with steps as a JSON string and no goal registers", async () => {
  await withServer([{}], async ({ registerArgs, backend, pending }) => {
    const reply = await registerArgs({ steps: JSON.stringify([{ tool: "Bash", rationale: "list files" }]) });
    assert.match(reply, /\(new\), 1 steps\. Token valid until /);
    assert.equal(backend.requests[0].plan.metadata.goal, "list files");
    assert.deepEqual(pending().plan.steps.map((step) => step.action), ["Bash"]);
  });
});
