import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createRequire } from "node:module";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "../plugins/armorcodex/scripts/lib/config.mjs";
import { withHome, signIn } from "./helpers/login.mjs";

const requirePlugin = createRequire(new URL("../plugins/armorcodex/package.json", import.meta.url));
const { Client } = requirePlugin("@modelcontextprotocol/sdk/client/index.js");
const { StdioClientTransport } = requirePlugin("@modelcontextprotocol/sdk/client/stdio.js");
const SERVER = fileURLToPath(new URL("../plugins/armorcodex/scripts/policy-mcp.mjs", import.meta.url));
const ROUTER = fileURLToPath(new URL("../plugins/armorcodex/scripts/hook-router.mjs", import.meta.url));
const SANDBOX = fileURLToPath(new URL("./helpers/mcp-sandbox.mjs", import.meta.url));
const contract = JSON.parse(await readFile(new URL("./fixtures/plan-capture-v1.json", import.meta.url), "utf8"));
const identity = contract.identity.find((entry) => entry.plugin === "ArmorCodex");
const NOW = Math.floor(Date.now() / 1000) * 1000;

async function setup(t, options = {}) {
  const home = await mkdtemp(path.join(os.tmpdir(), "armorcodex-capture-"));
  let client;
  t.after(async () => {
    await client?.close();
    await rm(home, { recursive: true, force: true });
  });
  const clock = path.join(home, "clock.mjs");
  await writeFile(clock, "Date.now = () => Number(process.env.ARMORCODEX_TEST_NOW);\n");
  const deferred = path.join(home, "deferred.mjs");
  await writeFile(deferred, `
const fetchOriginal = globalThis.fetch;
let releaseToken;
const released = new Promise((resolve) => { releaseToken = resolve; });
globalThis.fetch = async (url, init) => {
  if (String(url) === "https://lifecycle.test/intent") {
    return new Response(JSON.stringify({ plan_id: "11111111-1111-4111-8111-111111111111", kind: init.headers["X-ArmorIQ-Plan-Kind"], intentTokenRaw: JSON.stringify({
      plan: JSON.parse(init.body).plan, expiresAt: Math.floor(Date.now() / 1000) + 600
    }) }), { status: 200, headers: { "content-type": "application/json" } });
  }
  if (String(url) !== "https://capture.test/intent") return fetchOriginal(url, init);
  const payload = JSON.parse(init.body);
  let incoming = "";
  process.stdin.on("data", (chunk) => {
    incoming += chunk;
    const lines = incoming.split("\\n");
    incoming = lines.pop();
    for (const line of lines) {
      if (JSON.parse(line).params?.name === "policy_read") releaseToken();
    }
  });
  process.stderr.write("capture-request\\n");
  await released;
  return new Response(JSON.stringify({ plan_id: "11111111-1111-4111-8111-111111111111", kind: init.headers["X-ArmorIQ-Plan-Kind"], intentTokenRaw: JSON.stringify({
    plan: payload.plan, expiresAt: Math.floor(Date.now() / 1000) + 600
  }) }), { status: 200, headers: { "content-type": "application/json" } });
};
`);
  const env = {
    HOME: home,
    TMPDIR: os.tmpdir(),
    ARMORCODEX_TEST_HOME: home,
    ARMORCODEX_DATA_DIR: path.join(home, "data"),
    ARMORIQ_ORG_MODE: "enforce",
    ARMORCODEX_MODE: "enforce",
    ARMORCODEX_USE_SDK_INTENT: "false",
    ARMORCODEX_INTENT_URL: "https://lifecycle.test/intent",
    ARMORCODEX_OBSERVABILITY_DISABLED: "true",
    ARMORCODEX_USAGE_SYNC_DISABLED: "true",
    ...options
  };
  const config = () => withHome(home, () => loadConfig(env));
  const state = async () => JSON.parse(await readFile(config().runtimeFile, "utf8"));
  const hook = (event, sessionId = "session-A", fields = {}, now = NOW) => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", SANDBOX, "--import", clock, ROUTER], {
      env: { ...env, ARMORCODEX_TEST_NOW: String(now) },
      stdio: ["pipe", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) return reject(new Error(`hook exited ${code}: ${stderr}`));
      try { resolve(stdout.trim() ? JSON.parse(stdout) : null); } catch (error) { reject(error); }
    });
    child.stdin.end(JSON.stringify({ hook_event_name: event, session_id: sessionId, ...fields }));
  });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["--import", SANDBOX, "--import", deferred, SERVER],
    env,
    stderr: "pipe"
  });
  client = new Client({ name: "capture-lifecycle", version: "0.0.0" });
  let requested;
  let serverStderr = "";
  const tokenRequested = new Promise((resolve) => { requested = resolve; });
  transport.stderr.on("data", (chunk) => {
    serverStderr += chunk;
    if (String(chunk).includes("capture-request")) requested();
  });
  await client.connect(transport);
  const registerResult = (sessionId = "session-A", action = "Bash") => client.callTool({
      name: "register_intent_plan",
      arguments: { goal: "inspect the workspace", steps: [{ action }] },
      _meta: { sessionId, threadId: "unrelated-thread" }
  }).catch((error) => { throw new Error(`${error.message}\n${serverStderr}`); });
  const register = async (sessionId, action) => {
    const result = await registerResult(sessionId, action);
    if (config().apiKey) assert.match(result.content[0].text, /^Intent registered: plan /);
    else assert.equal(result.content[0].text, "Plan recorded locally, not registered (logged_out).");
    assert.equal(result.isError ?? false, false);
  };
  const prompt = (text, sessionId = "session-A", now = NOW, fields = {}) =>
    hook("UserPromptSubmit", sessionId, { prompt: text, ...fields }, now);
  const tool = (sessionId = "session-A", fields = {}, now = NOW) =>
    hook("PreToolUse", sessionId, { tool_name: "Bash", tool_input: { command: "ls" }, ...fields }, now);
  const releaseToken = () => client.callTool({ name: "policy_read", arguments: {} });
  return { home, env, config, state, hook, register, registerResult, tokenRequested, releaseToken, prompt, tool, transport };
}

function assertMissing(output) {
  assert.equal(output?.hookSpecificOutput?.permissionDecision, "deny");
  assert.match(output.hookSpecificOutput.permissionDecisionReason, /intent plan missing/);
}

for (const entry of ["hook", "registration"]) {
  // regression: #0007
  test(`the next ${entry} recovers a lock left by a killed holder`, async (t) => {
    const h = await setup(t);
    await h.prompt("first");
    await h.register();
    const module = entry === "hook" ? "runtime-state.mjs" : "plan-request.mjs";
    const operation = entry === "hook" ? "withRuntimeState" : "withPlanRequest";
    const moduleUrl = new URL(`../plugins/armorcodex/scripts/lib/${module}`, import.meta.url).href;
    const holder = spawn(process.execPath, ["--input-type=module", "-e", `
      import { ${operation} } from ${JSON.stringify(moduleUrl)};
      process.stdin.resume();
      await ${operation}(${JSON.stringify(h.config().runtimeFile)}, ${entry === "registration" ? '"session-A",' : ""} async () => {
        process.stdout.write("locked");
        await new Promise(() => {});
      });
    `], { stdio: ["pipe", "pipe", "pipe"] });
    t.after(() => { holder.kill("SIGKILL"); });
    await once(holder.stdout, "data");
    const exited = once(holder, "exit");
    holder.kill("SIGKILL");
    await exited;
    if (entry === "hook") assert.equal(await h.tool(), null);
    else await h.register();
  });
}

for (const command of ["/armor status", "/armor", "Policy list"]) {
  // regression: #0007
  test(`${command} preserves the current prompt and plan`, async (t) => {
    const h = await setup(t);
    await h.prompt("first");
    await h.register();
    const before = (await h.state()).sessions["session-A"];
    await h.prompt(command, "session-A", NOW + 1000);
    const after = (await h.state()).sessions["session-A"];
    assert.equal(after.promptId, before.promptId);
    assert.deepEqual(after.plan, before.plan);
    assert.equal(await h.tool(), null);
  });
}

// regression: #0007
test("hook mode survives repeated MCP registration with a different environment", async (t) => {
  const h = await setup(t);
  signIn(h.home, { backend: h.config().backendEndpoint, apiKey: "test-capture-key" });
  h.env.ARMORCODEX_MODE = "monitor";
  await h.prompt("first");
  const before = (await h.state()).sessions["session-A"];
  const result = await h.registerResult();
  assert.match(result.content[0].text, /^Intent registered: plan 11111111-1111-4111-8111-111111111111 \(new\)/);
  for (let i = 0; i < 3; i++) {
    assert.equal(await h.tool(), null);
    assert.equal((await h.registerResult()).content[0].text, result.content[0].text);
    const after = (await h.state()).sessions["session-A"];
    assert.equal(after.authGeneration, before.authGeneration);
    assert.equal(after.countedPlanId, "11111111-1111-4111-8111-111111111111");
    assert.equal(after.unregisteredLocalPlan, null);
  }
});

for (const enabled of ["true", "false"]) {
  // regression: #0007
  test(`shutdown waits for an in flight registration with run reporting ${enabled}`, async (t) => {
    const h = await setup(t, { ARMORCODEX_INTENT_URL: "https://capture.test/intent", ARMORCODEX_RUN_REPORTING_ENABLED: enabled });
    signIn(h.home, { backend: h.config().backendEndpoint, apiKey: "test-capture-key" });
    await h.prompt("first");
    const registering = h.registerResult();
    const outcome = registering.catch((error) => error);
    await h.tokenRequested;
    const closed = new Promise((resolve) => {
      const original = h.transport.onclose;
      h.transport.onclose = () => { original?.(); resolve(); };
    });
    process.kill(h.transport.pid, "SIGTERM");
    await h.releaseToken().catch(() => {});
    const result = await outcome;
    assert.equal(result.isError ?? false, false);
    assert.match(result.content?.[0]?.text ?? String(result), /^Intent registered: plan /);
    await closed;
    assert.deepEqual((await readdir(h.config().dataDir)).filter((name) => name.endsWith(".lock")), []);
  });
}

test("root prompts get UUIDs, deduplicate for five seconds, and close at Stop", async (t) => {
  const h = await setup(t);
  await h.prompt("first");
  const first = (await h.state()).sessions["session-A"];
  assert.match(first.promptId ?? "", /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
  await h.register();
  await h.prompt("first", "session-A", NOW + 4999);
  const duplicate = (await h.state()).sessions["session-A"];
  assert.equal(duplicate.promptId, first.promptId);
  assert.equal(duplicate.promptGeneration, first.promptGeneration);
  assert.equal(await h.tool(), null);
  await h.prompt("first", "session-A", NOW + 5001);
  const repeated = (await h.state()).sessions["session-A"];
  assert.notEqual(repeated.promptId, first.promptId);
  assert.equal(repeated.promptGeneration, first.promptGeneration + 1);
  await h.prompt("second", "session-A", NOW + 5002);
  const second = (await h.state()).sessions["session-A"];
  assert.notEqual(second.promptId, repeated.promptId);
  assert.equal(second.promptOpenSince, (NOW + 5002) / 1000);
  await h.hook(identity.turnEndEvent, "session-A", {}, NOW + 6000);
  const closed = (await h.state()).sessions["session-A"];
  assert.equal(closed.promptOpenSince, null);
  assert.equal(closed.lastActivityAt, (NOW + 6000) / 1000);
});

test("a new prompt retires a consumed plan and rejects the old token in hook input", async (t) => {
  const h = await setup(t);
  await h.prompt("first");
  await h.register();
  assert.equal(await h.tool(), null);
  await h.prompt("second", "session-A", NOW + 1000);
  assertMissing(await h.tool());
  assertMissing(await h.tool("session-A", {
    intentTokenRaw: JSON.stringify({ plan: { steps: [{ action: "Bash" }] }, expiresAt: NOW / 1000 + 600 })
  }));
});

test("a pending plan from a previous prompt is never consumed by the next prompt", async (t) => {
  const h = await setup(t);
  await h.prompt("first");
  await h.register();
  await h.prompt("second", "session-A", NOW + 1000);
  assertMissing(await h.tool());
  await h.register();
  assert.equal(await h.tool(), null);
});

test("MCP session identity isolates both plans and prompts across sessions", async (t) => {
  const h = await setup(t);
  await h.prompt("same text", "session-A");
  await h.prompt("same text", "session-B");
  await h.register("session-A");
  assertMissing(await h.tool("session-B"));
  assert.equal(await h.tool("session-A"), null);
  const sessions = (await h.state()).sessions;
  assert.notEqual(sessions["session-A"].promptId, sessions["session-B"].promptId);
  await h.prompt("next", "session-B", NOW + 1000);
  assert.equal(await h.tool("session-A"), null);
});

test("logout retires the plan and bumps the auth generation", async (t) => {
  const h = await setup(t);
  signIn(h.home, { backend: h.config().backendEndpoint, apiKey: "test-capture-key" });
  await h.prompt("first");
  await h.register();
  assert.equal(await h.tool(), null);
  const before = (await h.state()).sessions["session-A"];
  await rm(path.join(h.home, ".armoriq", "credentials.json"));
  assertMissing(await h.tool());
  const after = (await h.state()).sessions["session-A"];
  assert.equal(after.authGeneration, before.authGeneration + 1);
  assert.equal(after.pendingRequest, null);
});

test("login, key, org and mode changes each retire the current plan", async (t) => {
  const h = await setup(t);
  await h.prompt("first");
  for (const change of [
    async () => signIn(h.home, { backend: h.config().backendEndpoint, apiKey: "test-capture-key" }),
    async () => signIn(h.home, { backend: h.config().backendEndpoint, apiKey: "test-capture-key-2" }),
    async () => {
      const file = path.join(h.home, ".armoriq", "credentials.json");
      const credentials = JSON.parse(await readFile(file, "utf8"));
      credentials.profiles[credentials.active].orgId = "org-2";
      await writeFile(file, JSON.stringify(credentials));
    },
    async () => { h.env.ARMORCODEX_MODE = "monitor"; }
  ]) {
    await h.register();
    await h.tool();
    const before = (await h.state()).sessions["session-A"];
    await change();
    await h.hook("PreToolUse", "session-A", { tool_name: "Read", tool_input: {} });
    const after = (await h.state()).sessions["session-A"];
    assert.equal(after.authGeneration, before.authGeneration + 1);
    assert.equal(after.plan, null);
    assert.equal(after.pendingRequest, null);
  }
});

// regression: #0007
test("concurrent hook processes preserve other sessions and same session activity", async (t) => {
  const h = await setup(t);
  await Promise.all(Array.from({ length: 12 }, (_, i) => h.prompt(`prompt ${i}`, `session-${i}`)));
  const sessions = (await h.state()).sessions;
  assert.equal(Object.keys(sessions).length, 12);
  assert.equal(new Set(Object.values(sessions).map((session) => session.promptId)).size, 12);
  await Promise.all(Array.from({ length: 8 }, () => h.prompt("duplicate", "shared-session")));
  assert.equal((await h.state()).sessions["shared-session"].promptGeneration, 1);
});

test("every hook records activity, including tools exempt from intent checks", async (t) => {
  const h = await setup(t);
  await h.prompt("first");
  for (const [i, event] of ["PreToolUse", "PermissionRequest", "PostToolUse", "PostToolUseFailure"].entries()) {
    const now = NOW + (i + 1) * 1000;
    await h.hook(event, "session-A", { tool_name: "Read", tool_input: {} }, now);
    assert.equal((await h.state()).sessions["session-A"].lastActivityAt, now / 1000);
  }
});

test("the directive requests a plan before the first tool that needs one and chat creates no plan", async (t) => {
  const h = await setup(t);
  const output = await h.prompt("hello");
  assert.match(output.hookSpecificOutput.additionalContext, /before the first tool that needs (?:one|a plan)/i);
  assert.doesNotMatch(output.hookSpecificOutput.additionalContext, /\bonce\b|before using any tool/i);
  const session = (await h.state()).sessions["session-A"];
  assert.equal(session.countedPlanId, null);
  assert.equal(session.pendingRequest, null);
});

test("a subagent wake up does not open a root prompt or retire its plan", async (t) => {
  const h = await setup(t);
  await h.prompt("first");
  await h.register();
  await h.tool();
  const before = (await h.state()).sessions["session-A"];
  await h.prompt("wake up", "session-A", NOW + 1000, { parent_session_id: "root" });
  const after = (await h.state()).sessions["session-A"];
  assert.equal(after.promptId, before.promptId);
  assert.equal(after.promptGeneration, before.promptGeneration);
  assert.equal(await h.tool(), null);
});

for (const change of ["prompt", "logout"]) {
  test(`a token response arriving after ${change} cannot restore the retired plan`, async (t) => {
    const h = await setup(t, { ARMORCODEX_INTENT_URL: "https://capture.test/intent" });
    signIn(h.home, { backend: h.config().backendEndpoint, apiKey: "test-capture-key" });
    await h.prompt("first");
    const registering = h.registerResult();
    await h.tokenRequested;
    if (change === "prompt") await h.prompt("second", "session-A", NOW + 1000);
    else await rm(path.join(h.home, ".armoriq", "credentials.json"));
    await h.releaseToken();
    const result = await registering;
    assert.match(result.content[0].text, /prompt or login changed/);
    assertMissing(await h.tool());
    assert.equal((await h.state()).sessions["session-A"].plan, null);
  });
}
