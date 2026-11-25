import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { createAuditWal } from "../plugins/armorcodex/scripts/lib/audit-wal.mjs";
import { auditRows } from "./helpers/audit-rows.mjs";
import { signIn } from "./helpers/login.mjs";

const requirePlugin = createRequire(new URL("../plugins/armorcodex/package.json", import.meta.url));
const { Client } = requirePlugin("@modelcontextprotocol/sdk/client/index.js");
const { StdioClientTransport } = requirePlugin("@modelcontextprotocol/sdk/client/stdio.js");
const HOOK_ROUTER = fileURLToPath(new URL("../plugins/armorcodex/scripts/hook-router.mjs", import.meta.url));
const POLICY_MCP = fileURLToPath(new URL("../plugins/armorcodex/scripts/policy-mcp.mjs", import.meta.url));
const KEY = "ak_test_orgmonitor000000000000000000";
const PLAN_ID = "11111111-1111-4111-8111-111111111111";

function reply(req, raw, answer, keyStatus, state) {
  if (req.url === "/policies/profiles/active") return [200, { version: 1, policy: null, ...answer }];
  if (req.url === "/iap/validate-key") return [keyStatus, { userId: "user-login" }];
  if (req.url !== "/intent") return [200, { written: 1, failures: [] }];
  const { plan } = JSON.parse(raw);
  state.intents.push(req.headers);
  return state.planStatus === 200
    ? [200, { plan_id: PLAN_ID, kind: req.headers["x-armoriq-plan-kind"], intentTokenRaw: JSON.stringify({ plan, expiresAt: Math.floor(Date.now() / 1000) + 600 }) }]
    : [state.planStatus, { message: "plan refused" }];
}

function startBackend(answer, keyStatus = 200) {
  const state = { profileHeaders: [], intents: [], planStatus: 200 };
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      if (req.url === "/policies/profiles/active") state.profileHeaders.push(req.headers);
      const [status, body] = reply(req, raw, answer, keyStatus, state);
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    });
  });
  return new Promise((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve({ server, state, url: `http://127.0.0.1:${server.address().port}` }))
  );
}

async function setup(t, answer, extraEnv = {}, keyStatus = 200) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "armorcodex-orgmonitor-"));
  const dataDir = path.join(home, "data");
  const backend = await startBackend(answer, keyStatus);
  const clients = [];
  t.after(async () => {
    await Promise.all(clients.map((client) => client.close()));
    backend.server.closeAllConnections();
    backend.server.close();
    fs.rmSync(home, { recursive: true, force: true });
  });
  signIn(home, { backend: backend.url, apiKey: KEY });
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(
    path.join(dataDir, "policy.json"),
    JSON.stringify({ version: 1, policy: { rules: [{ id: "no-bash", action: "deny", tool: "Bash" }] }, history: [] })
  );
  const env = {
    PATH: process.env.PATH,
    HOME: home,
    ARMORCODEX_TEST_HOME: home,
    TMPDIR: os.tmpdir(),
    ARMORCODEX_DATA_DIR: dataDir,
    BACKEND_ENDPOINT: backend.url,
    IAP_ENDPOINT: backend.url,
    PROXY_ENDPOINT: backend.url,
    ARMORCODEX_INTENT_URL: `${backend.url}/intent`,
    ARMORCODEX_NO_AUTO_UPDATE: "1",
    ...extraEnv
  };
  const register = async () => {
    const client = new Client({ name: "org-monitor", version: "0.0.0" });
    clients.push(client);
    await client.connect(new StdioClientTransport({ command: process.execPath, args: [POLICY_MCP], env, stderr: "pipe" }));
    return client.callTool({ name: "register_intent_plan", arguments: { goal: "list the files", steps: [{ action: "Bash" }] }, _meta: { sessionId: "s-monitor" } });
  };
  return { dataDir, backend, env, register };
}

async function hook(env, payload) {
  const child = spawn(process.execPath, [HOOK_ROUTER], { env });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (c) => (stdout += c));
  child.stderr.on("data", (c) => (stderr += c));
  child.stdin.end(JSON.stringify({ session_id: "s-monitor", ...payload }));
  const code = await new Promise((resolve) => child.once("close", resolve));
  assert.equal(code, 0, stderr);
  return stdout.trim() ? JSON.parse(stdout) : null;
}

function walRows(dataDir) {
  return auditRows(dataDir);
}

const bash = { tool_name: "Bash", tool_input: { command: "ls" }, tool_use_id: "call_bash_1" };

async function session(env) {
  const start = await hook(env, { hook_event_name: "SessionStart", source: "startup" });
  const prompt = await hook(env, { hook_event_name: "UserPromptSubmit", prompt: "list the files" });
  const pre = await hook(env, { hook_event_name: "PreToolUse", ...bash });
  return { start, prompt, pre };
}

test("Quiet: the model is asked for a plan that is sent, and a denied call runs with a row saying Enforce would have blocked it under that plan", async (t) => {
  const { dataDir, backend, env, register } = await setup(t, { enforcementMode: "shadow", monitorNotices: false });
  const start = await hook(env, { hook_event_name: "SessionStart", source: "startup" });
  const prompt = await hook(env, { hook_event_name: "UserPromptSubmit", prompt: "list the files" });
  assert.equal(start, null);
  assert.equal(prompt.systemMessage, undefined);
  assert.match(prompt.hookSpecificOutput.additionalContext, /call `register_intent_plan` before the first tool/);
  const registered = await register();
  assert.match(registered.content[0].text, new RegExp(`^Intent registered: plan ${PLAN_ID} \\(new\\)`));
  const { promptId } = JSON.parse(fs.readFileSync(path.join(dataDir, "runtime.json"), "utf8")).sessions["s-monitor"];
  assert.deepEqual(
    backend.state.intents.map((headers) => [headers["x-armoriq-plan-kind"], headers["x-armoriq-prompt-id"], /^pcc1:/.test(headers["idempotency-key"])]),
    [["new", promptId, true]]
  );
  assert.equal(await hook(env, { hook_event_name: "PreToolUse", ...bash }), null);
  await hook(env, { hook_event_name: "PostToolUse", ...bash, tool_response: { stdout: "a.txt" } });

  const rows = walRows(dataDir);
  assert.deepEqual(
    rows.map((r) => [r.tool, r.status, r.would_be, r.plan_id, r.prompt_id]),
    [["Bash", "success", "block", PLAN_ID, promptId]]
  );
  assert.match(rows[0].would_be_reason, /no-bash|denied|Bash/i);
  assert.equal(backend.state.profileHeaders[0]["x-armoriq-monitor-aware"], "1");
});

for (const [name, answer, extraEnv] of [
  ["Quiet", { enforcementMode: "shadow" }, {}],
  ["ARMORCODEX_MODE=monitor", { enforcementMode: "enforce" }, { ARMORCODEX_MODE: "monitor" }]
]) {
  test(`${name}: a failed plan request is recorded and the call still runs`, async (t) => {
    const { dataDir, backend, env, register } = await setup(t, answer, extraEnv);
    fs.writeFileSync(path.join(dataDir, "policy.json"), JSON.stringify({ version: 1, policy: { rules: [] }, history: [] }));
    backend.state.planStatus = 422;
    await hook(env, { hook_event_name: "SessionStart", source: "startup" });
    await hook(env, { hook_event_name: "UserPromptSubmit", prompt: "list the files" });
    const result = await register();
    assert.equal(result.isError, true);
    assert.equal(result.content[0].text, "Plan not registered: plan refused.");
    assert.equal(backend.state.intents.length, 1);
    const events = await createAuditWal({ dataDir, stream: "health", login: null }).readPending();
    assert.deepEqual(events.map(({ row }) => [row.type, row.reason_code]), [["plan_request_failed", "rejected"]]);
    assert.equal(await hook(env, { hook_event_name: "PreToolUse", ...bash }), null);
  });
}

test("Show in chat: the denied call runs with one line for the user and no permission decision", async (t) => {
  const { env } = await setup(t, { enforcementMode: "shadow", monitorNotices: true });
  const { pre } = await session(env);
  assert.equal(pre?.hookSpecificOutput, undefined);
  assert.match(pre?.systemMessage ?? "", /^ArmorIQ would block this call in Enforce \(.+\)\. Monitor let it run\.$/);
});

for (const [name, answer, extraEnv] of [
  ["Block", { enforcementMode: "enforce" }, {}],
  ["ARMORIQ_ORG_MODE=enforce over a Quiet workspace", { enforcementMode: "shadow" }, { ARMORIQ_ORG_MODE: "enforce" }]
]) {
  test(`${name}: the denied call is blocked and recorded as blocked`, async (t) => {
    const { dataDir, env } = await setup(t, answer, extraEnv);
    const { pre } = await session(env);
    assert.equal(pre?.hookSpecificOutput?.permissionDecision, "deny");
    assert.deepEqual(
      walRows(dataDir).map((r) => [r.tool, r.status, r.would_be]),
      [["Bash", "blocked", undefined]]
    );
  });
}

test("a key the backend rejects is signed out, so a Quiet workspace no longer turns off the local policy", async (t) => {
  const { env } = await setup(t, { enforcementMode: "shadow", monitorNotices: false }, {}, 401);
  const { pre } = await session(env);
  assert.equal(pre?.hookSpecificOutput?.permissionDecision, "deny");
});
