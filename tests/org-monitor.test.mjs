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

const BUNDLE = JSON.parse(fs.readFileSync(new URL("./fixtures/policy-bundle-armorcodex.json", import.meta.url), "utf8"));
const FLOOR_HOLD = JSON.parse(fs.readFileSync(new URL("./fixtures/policy-v2-floor-bash-hold.json", import.meta.url), "utf8"));
const HOLD_BASH_BUNDLE = { ...BUNDLE, agents: [{ ...BUNDLE.agents[0], policies: [FLOOR_HOLD] }] };

function startBackend(answer, { keyStatus = 200, profileStatus = 200, bundle = null } = {}) {
  const state = { profileHeaders: [], paths: [] };
  const server = http.createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      const route = req.url.split("?")[0];
      state.paths.push(route);
      if (route === "/policies/profiles/active") state.profileHeaders.push(req.headers);
      const [status, body] =
        route === "/policies/profiles/active"
          ? [profileStatus, { version: 1, policy: null, ...answer }]
          : route === "/iap/validate-key"
            ? [keyStatus, { userId: "user-login" }]
            : route === "/policy/bundles/current"
              ? bundle ? [200, bundle] : [404, {}]
              : [200, { written: 1, failures: [] }];
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    });
  });
  return new Promise((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve({ server, state, url: `http://127.0.0.1:${server.address().port}` }))
  );
}

async function setup(t, answer, extraEnv = {}, { localRule = true, cachedMode = null, ...backendOptions } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "armorcodex-orgmonitor-"));
  const dataDir = path.join(home, "data");
  const backend = await startBackend(answer, backendOptions);
  t.after(() => {
    backend.server.closeAllConnections();
    backend.server.close();
    fs.rmSync(home, { recursive: true, force: true });
  });
  signIn(home, { backend: backend.url, apiKey: KEY });
  fs.mkdirSync(dataDir, { recursive: true });
  const rules = localRule ? [{ id: "no-bash", action: "deny", tool: "Bash" }] : [];
  fs.writeFileSync(path.join(dataDir, "policy.json"), JSON.stringify({ version: 1, policy: { rules }, history: [] }));
  if (cachedMode) fs.writeFileSync(path.join(dataDir, "org-mode.json"), JSON.stringify({ mode: cachedMode, notices: false }));
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

async function run(env, stdin) {
  const child = spawn(process.execPath, [HOOK_ROUTER], { env });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (c) => (stdout += c));
  child.stderr.on("data", (c) => (stderr += c));
  child.stdin.end(stdin);
  const code = await new Promise((resolve) => child.once("close", resolve));
  assert.equal(code, 0, stderr);
  return { output: stdout.trim() ? JSON.parse(stdout) : null, stderr };
}

const hook = async (env, payload) => (await run(env, JSON.stringify({ session_id: "s-monitor", ...payload }))).output;

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
  assert.equal(await hook(env, { hook_event_name: "PermissionRequest", ...bash }), null);
  await hook(env, { hook_event_name: "PostToolUse", ...bash, tool_response: { stdout: "a.txt" } });

  const rows = walRows(dataDir);
  assert.deepEqual(
    rows.map((r) => [r.tool, r.status, r.would_be]),
    [["Bash", "success", "block"]]
  );
  // regression: #327
  assert.equal(typeof rows[0].duration_ms, "number");
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
    const { start, pre } = await session(env);
    // regression: #327
    assert.equal(start?.hookSpecificOutput?.additionalContext, "ArmorCodex active (ENFORCING, intent=required)");
    assert.equal(pre?.hookSpecificOutput?.permissionDecision, "deny");
    assert.deepEqual(
      walRows(dataDir).map((r) => [r.tool, r.status, r.would_be]),
      [["Bash", "blocked", undefined]]
    );
  });
}

test("a key the backend rejects is signed out, so a Quiet workspace no longer turns off the local policy", async (t) => {
  const { env } = await setup(t, { enforcementMode: "shadow", monitorNotices: false }, {}, { keyStatus: 401 });
  const { pre } = await session(env);
  assert.equal(pre?.hookSpecificOutput?.permissionDecision, "deny");
});

test("a key the backend rejects gets the local intent setting back, not the Monitor override", async (t) => {
  const { env } = await setup(t, { enforcementMode: "shadow", monitorNotices: false }, {}, { keyStatus: 401 });
  await hook(env, { hook_event_name: "SessionStart", source: "startup" });
  const pre = await hook(env, {
    hook_event_name: "PreToolUse",
    tool_name: "apply_patch",
    tool_input: { input: "*** Begin Patch\n*** Add File: a.txt\n+hi\n*** End Patch" },
    tool_use_id: "call_patch_1"
  });
  assert.equal(pre?.hookSpecificOutput?.permissionDecision, "deny");
  assert.match(pre.hookSpecificOutput.permissionDecisionReason, /plan|intent/i);
});

// regression: #327
test("SessionEnd removes the would-be verdicts of calls Codex's own prompt refused", async (t) => {
  const { dataDir, env } = await setup(t, { enforcementMode: "shadow", monitorNotices: false });
  await session(env);
  await hook(env, { hook_event_name: "SessionEnd" });
  const left = fs.existsSync(path.join(dataDir, "would-be"))
    ? fs.readdirSync(path.join(dataDir, "would-be"), { recursive: true, withFileTypes: true }).filter((e) => e.isFile())
    : [];
  assert.deepEqual(left, []);
});

// regression: #327
for (const [name, call, broken, logged] of [
  ["a call with no tool_use_id", { ...bash, tool_use_id: undefined }, false, /would-be verdict not recorded: no tool_use_id/],
  ["a verdict that cannot be written", bash, true, /would-be verdict not recorded: /]
]) {
  test(`Quiet: ${name} still runs and the lost verdict is logged`, async (t) => {
    const { dataDir, env } = await setup(t, { enforcementMode: "shadow", monitorNotices: false });
    if (broken) fs.writeFileSync(path.join(dataDir, "would-be"), "");
    await hook(env, { hook_event_name: "SessionStart", source: "startup" });
    const { output, stderr } = await run(env, JSON.stringify({ session_id: "s-monitor", hook_event_name: "PreToolUse", ...call }));
    assert.equal(output, null);
    assert.match(stderr, logged);
  });
}

for (const [name, answer, cachedMode, profileStatus, decision] of [
  ["a failed fetch keeps a cached Block", { enforcementMode: "shadow" }, "enforce", 500, "deny"],
  ["no cache and a failed fetch is Quiet", { enforcementMode: "enforce" }, null, 500, undefined]
]) {
  test(`the workspace mode: ${name}`, async (t) => {
    const { env } = await setup(t, answer, {}, { cachedMode, profileStatus });
    const { pre } = await session(env);
    assert.equal(pre?.hookSpecificOutput?.permissionDecision, decision);
  });
}

for (const [name, answer, expected] of [
  ["Quiet lets it through", { enforcementMode: "shadow" }, null],
  ["Block denies it", { enforcementMode: "enforce" }, "deny"]
]) {
  test(`a PreToolUse payload that is not JSON: ${name}`, async (t) => {
    const { env } = await setup(t, answer);
    await hook(env, { hook_event_name: "SessionStart", source: "startup" });
    const { output } = await run(env, "{not json");
    assert.equal(output?.hookSpecificOutput?.permissionDecision ?? null, expected);
  });
}

test("Quiet: a v2 hold runs, is recorded as a would-be hold, and files no approval request", async (t) => {
  const { dataDir, backend, env } = await setup(t, { enforcementMode: "shadow", monitorNotices: false }, {}, { localRule: false, bundle: HOLD_BASH_BUNDLE });
  const { pre } = await session(env);
  assert.equal(pre, null);
  await hook(env, { hook_event_name: "PostToolUse", ...bash, tool_response: { stdout: "a.txt" } });

  assert.deepEqual(walRows(dataDir).map((r) => [r.tool, r.status, r.would_be]), [["Bash", "success", "hold"]]);
  assert.equal(backend.state.paths.includes("/iap/sdk/enforce"), false);
});
