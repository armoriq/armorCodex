import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { signIn } from "./helpers/login.mjs";

const HOOK_ROUTER = fileURLToPath(new URL("../plugins/armorcodex/scripts/hook-router.mjs", import.meta.url));
const KEY = "ak_test_orgmonitor000000000000000000";

function startBackend(answer, keyStatus = 200) {
  const state = { profileHeaders: [], profileStatus: 200 };
  const server = http.createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      if (req.url === "/policies/profiles/active") state.profileHeaders.push(req.headers);
      const body =
        req.url === "/policies/profiles/active"
          ? { version: 1, policy: null, ...answer }
          : req.url === "/iap/validate-key"
            ? { userId: "user-login" }
            : { written: 1, failures: [] };
      const status =
        req.url === "/iap/validate-key" ? keyStatus : req.url === "/policies/profiles/active" ? state.profileStatus : 200;
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    });
  });
  return new Promise((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve({ server, state, url: `http://127.0.0.1:${server.address().port}` }))
  );
}

async function setup(t, answer, extraEnv = {}, keyStatus = 200, profileStatus = 200) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "armorcodex-orgmonitor-"));
  const dataDir = path.join(home, "data");
  const backend = await startBackend(answer, keyStatus);
  backend.state.profileStatus = profileStatus;
  t.after(() => {
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
    ARMORCODEX_NO_AUTO_UPDATE: "1",
    ...extraEnv
  };
  return { dataDir, backend, env };
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
  const file = path.join(dataDir, "audit", "current.jsonl");
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

const bash = { tool_name: "Bash", tool_input: { command: "ls" }, tool_use_id: "call_bash_1" };

async function session(env) {
  const start = await hook(env, { hook_event_name: "SessionStart", source: "startup" });
  const prompt = await hook(env, { hook_event_name: "UserPromptSubmit", prompt: "list the files" });
  const pre = await hook(env, { hook_event_name: "PreToolUse", ...bash });
  return { start, prompt, pre };
}

test("Quiet: the session shows nothing, a denied call runs, and its row says Enforce would have blocked it", async (t) => {
  const { dataDir, backend, env } = await setup(t, { enforcementMode: "shadow", monitorNotices: false });
  const { start, prompt, pre } = await session(env);
  assert.equal(start, null);
  assert.equal(prompt, null);
  assert.equal(pre, null);
  await hook(env, { hook_event_name: "PostToolUse", ...bash, tool_response: { stdout: "a.txt" } });

  const rows = walRows(dataDir);
  assert.deepEqual(
    rows.map((r) => [r.tool, r.status, r.would_be]),
    [["Bash", "success", "block"]]
  );
  assert.match(rows[0].would_be_reason, /no-bash|denied|Bash/i);
  assert.equal(backend.state.profileHeaders[0]["x-armoriq-monitor-aware"], "1");
});

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

test("a key the backend rejects blocks the call and names the login command, even in a Quiet workspace", async (t) => {
  const { env } = await setup(t, { enforcementMode: "shadow", monitorNotices: false }, {}, 401);
  const { pre } = await session(env);
  assert.equal(pre?.hookSpecificOutput?.permissionDecision, "deny");
  assert.match(pre.hookSpecificOutput.permissionDecisionReason, /rejected the stored key.* login --product armorcodex --backend /);
});

const modeFile = (dataDir) => path.join(dataDir, "org-mode.json");

for (const [name, saved] of [
  ["never confirmed", null],
  ["a corrupt mode file", "{not json"],
  ["an unknown mode value", JSON.stringify({ mode: "relaxed" })]
]) {
  test(`a workspace mode the server cannot confirm, with ${name}, enforces the policy`, async (t) => {
    const { dataDir, env } = await setup(t, { enforcementMode: "shadow" }, {}, 200, 500);
    if (saved !== null) fs.writeFileSync(modeFile(dataDir), saved);
    const { start, pre } = await session(env);
    assert.equal(pre?.hookSpecificOutput?.permissionDecision, "deny");
    assert.match(start?.hookSpecificOutput?.additionalContext ?? "", /has not confirmed this workspace's mode, so ArmorCodex enforces the policy/);
  });
}

test("when the server cannot answer, the last mode it confirmed still applies", async (t) => {
  const { dataDir, backend, env } = await setup(t, { enforcementMode: "shadow", monitorNotices: false });
  await hook(env, { hook_event_name: "SessionStart", source: "startup" });
  backend.state.profileStatus = 500;
  const { start, pre } = await session(env);
  assert.equal(start, null);
  assert.equal(pre, null);
  assert.equal(JSON.parse(fs.readFileSync(modeFile(dataDir), "utf8")).mode, "shadow");
});

test("a deleted mode file is read again from the server on the next call", async (t) => {
  const { dataDir, env } = await setup(t, { enforcementMode: "shadow", monitorNotices: false });
  await hook(env, { hook_event_name: "SessionStart", source: "startup" });
  fs.rmSync(modeFile(dataDir));
  assert.equal(await hook(env, { hook_event_name: "PreToolUse", ...bash }), null);
  assert.equal(JSON.parse(fs.readFileSync(modeFile(dataDir), "utf8")).mode, "shadow");
});

test("in a Quiet workspace the guard still stops a shell command that deletes ArmorCodex's policy file", async (t) => {
  const { dataDir, env } = await setup(t, { enforcementMode: "shadow", monitorNotices: false });
  await hook(env, { hook_event_name: "SessionStart", source: "startup" });
  const pre = await hook(env, {
    hook_event_name: "PreToolUse",
    tool_name: "Bash",
    tool_input: { command: `rm ${path.join(dataDir, "policy.json")}` },
    tool_use_id: "call_rm_1"
  });
  assert.equal(pre?.hookSpecificOutput?.permissionDecision, "deny");
  assert.ok(fs.existsSync(path.join(dataDir, "policy.json")));
});

test("each local switch that turns enforcement down is reported on the call's audit row", async (t) => {
  const { dataDir, env } = await setup(
    t,
    { enforcementMode: "enforce" },
    {
      ARMORCODEX_MODE: "monitor",
      ARMORCODEX_POLICY_V2: "false",
      ARMORCODEX_MCP_DENY_BY_DEFAULT: "false",
      ARMORCODEX_INTENT_REQUIRED: "false",
      ARMORCODEX_VERIFY_SSL: "false"
    }
  );
  fs.rmSync(path.join(dataDir, "policy.json"));
  await hook(env, { hook_event_name: "SessionStart", source: "startup" });
  assert.equal(await hook(env, { hook_event_name: "PreToolUse", ...bash }), null);
  await hook(env, { hook_event_name: "PostToolUse", ...bash, tool_response: { stdout: "a.txt" } });
  const [row] = walRows(dataDir);
  assert.deepEqual(row.input.armoriq_policy.local_overrides, [
    "ARMORCODEX_MODE=monitor",
    "ARMORCODEX_POLICY_V2=false",
    "ARMORCODEX_MCP_DENY_BY_DEFAULT=false",
    "ARMORCODEX_INTENT_REQUIRED=false",
    "ARMORCODEX_VERIFY_SSL=false",
    "BACKEND_ENDPOINT"
  ]);
});
