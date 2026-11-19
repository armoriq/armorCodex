import test from "node:test";
import assert from "node:assert/strict";
import { createHook } from "node:async_hooks";
import { execFileSync, spawn } from "node:child_process";
import { createRequire, syncBuiltinESMExports } from "node:module";
import fsPromises, { access, mkdir, mkdtemp, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadSettings } from "../plugins/armorcodex/scripts/lib/config.mjs";
import { createAuditWal } from "../plugins/armorcodex/scripts/lib/audit-wal.mjs";
import { handleUserPromptSubmit } from "../plugins/armorcodex/scripts/lib/engine.mjs";
import { publishRunReports, withRunState } from "../plugins/armorcodex/scripts/lib/runs.mjs";
import { signIn } from "./helpers/login.mjs";

const requirePlugin = createRequire(new URL("../plugins/armorcodex/package.json", import.meta.url));
const { Client } = requirePlugin("@modelcontextprotocol/sdk/client/index.js");
const { StdioClientTransport } = requirePlugin("@modelcontextprotocol/sdk/client/stdio.js");
const ROUTER = fileURLToPath(new URL("../plugins/armorcodex/scripts/hook-router.mjs", import.meta.url));
const SERVER = fileURLToPath(new URL("../plugins/armorcodex/scripts/policy-mcp.mjs", import.meta.url));
const SANDBOX = fileURLToPath(new URL("./helpers/mcp-sandbox.mjs", import.meta.url));
const CONTRACT = JSON.parse(await readFile(new URL("../plugins/armorcodex/tests/fixtures/runs-v1.json", import.meta.url), "utf8"));
const PLAN_ID = "11111111-1111-4111-8111-111111111111";
const START = Date.parse("2026-11-15T12:00:00Z");

async function setup(t, overrides = {}, loggedIn = true) {
  const home = await mkdtemp(path.join(os.tmpdir(), "armorcodex-runs-"));
  const dataDir = path.join(home, "data");
  const preload = path.join(home, "backend.mjs");
  await writeFile(preload, `
import { appendFileSync } from "node:fs";
import path from "node:path";
let clockCalls = 0;
Date.now = () => Number(process.env.RUN_TEST_NOW) + (process.env.RUN_TEST_TICK ? ++clockCalls * 6000 : 0);
let release;
const held = new Promise((resolve) => { release = resolve; });
globalThis.fetch = async (url, init = {}) => {
  const body = init.body ? JSON.parse(init.body) : {};
  appendFileSync(path.join(process.env.HOME, "sent.jsonl"), JSON.stringify({ url: String(url), body }) + "\\n");
  let status = 200;
  let response = {};
  if (String(url).endsWith("/intent")) {
    if (process.env.RUN_TEST_DEFER === "true") {
      let incoming = "";
      process.stdin.on("data", (chunk) => {
        incoming += chunk;
        const lines = incoming.split("\\n");
        incoming = lines.pop();
        for (const line of lines) {
          try { if (JSON.parse(line).params?.name === "policy_read") release(); } catch {}
        }
      });
      process.stderr.write("run-request\\n");
      await held;
    }
    status = Number(process.env.RUN_TEST_PLAN_STATUS || 200);
    response = status === 200 ? {
      plan_id: "${PLAN_ID}", kind: init.headers["X-ArmorIQ-Plan-Kind"],
      intentTokenRaw: JSON.stringify({ plan: body.plan, expiresAt: Date.now() / 1000 + 600 })
    } : { message: "registration refused" };
  } else if (String(url).endsWith("/iap/validate-key")) {
    status = Number(process.env.RUN_TEST_POSTURE || 200);
  } else if (String(url).endsWith("/iap/runs/batch")) {
    status = Number(process.env.RUN_TEST_RUN_STATUS || 200);
    response = { results: (body.reports || []).map(({ run_id, report_seq }) => ({ run_id, report_seq, outcome: "accepted" })) };
  } else if (body.events) {
    response = { results: body.events.map(({ event_id }) => ({ event_id, outcome: "accepted" })) };
  } else response = { written: 0, failures: [] };
  return new Response(JSON.stringify(response), { status, headers: { "content-type": "application/json" } });
};
`);
  const env = {
    HOME: home, TMPDIR: os.tmpdir(), ARMORCODEX_TEST_HOME: home,
    ARMORCODEX_DATA_DIR: dataDir, ARMORCODEX_MODE: "enforce", ARMORIQ_ORG_MODE: "enforce", ARMORCODEX_POLICY_V2: "false",
    ARMORCODEX_BACKEND_ENDPOINT: "https://runs.test", ARMORCODEX_INTENT_URL: "https://runs.test/intent",
    ARMORCODEX_OBSERVABILITY_DISABLED: "true", ARMORCODEX_USAGE_SYNC_DISABLED: "true",
    ARMORCODEX_RUN_REPORTING_ENABLED: "true", RUN_TEST_RUN_STATUS: "404", RUN_TEST_NOW: String(START), ...overrides
  };
  const login = (key = "ak_test_runs_a") => signIn(home, { backend: "https://runs.test", apiKey: key });
  if (loggedIn) login();
  const clients = [];
  t.after(async () => {
    await Promise.all(clients.map((client) => client.close()));
    await rm(home, { recursive: true, force: true });
  });
  const hook = (event, fields = {}, timeout = 0) => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", SANDBOX, "--import", preload, ROUTER], {
      env, stdio: ["pipe", "pipe", "pipe"], timeout, killSignal: "SIGKILL"
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
    child.stdin.end(JSON.stringify({ session_id: "root", hook_event_name: event, ...fields }));
  });
  const wal = () => createAuditWal({ dataDir, stream: "runs", login: null });
  const reports = async () => (await wal().readPending()).map(({ row }) => row);
  const runtime = async () => JSON.parse(await readFile(path.join(dataDir, "runtime.json"), "utf8"));
  const runState = () => withRunState({ dataDir }, (state) => structuredClone(state));
  const state = async () => ({ ...await runtime(), ...await runState() });
  const requests = async () => {
    const raw = await readFile(path.join(home, "sent.jsonl"), "utf8").catch((error) => {
      if (error.code === "ENOENT") return "";
      throw error;
    });
    return raw.trim().split("\n").filter(Boolean).map(JSON.parse);
  };
  const connect = async () => {
    let requested;
    const tokenRequested = new Promise((resolve) => { requested = resolve; });
    const transport = new StdioClientTransport({ command: process.execPath, args: ["--import", SANDBOX, "--import", preload, SERVER], env, stderr: "pipe" });
    transport.stderr.on("data", (chunk) => { if (String(chunk).includes("run-request")) requested(); });
    const client = new Client({ name: "runs-test", version: "0.0.0" });
    const pending = new AbortController();
    // MCP rejects requests on close but leaves their timers alive unless the requests are aborted.
    client.onclose = () => pending.abort();
    clients.push(client);
    await client.connect(transport);
    return {
      tokenRequested,
      listTools: () => client.listTools(),
      register: (args = { goal: "inspect", steps: [{ action: "Bash" }] }) => client.callTool({ name: "register_intent_plan", arguments: args, _meta: { sessionId: "root" } }, undefined, { signal: pending.signal }),
      release: () => client.callTool({ name: "policy_read", arguments: {} }, undefined, { signal: pending.signal }),
      close: () => client.close(),
      crash: () => process.kill(transport.pid, "SIGKILL")
    };
  };
  return {
    home, env, dataDir, state, runtime, runState, hook, connect, reports, wal, login, requests,
    prompt: (prompt = "hello", fields) => hook("UserPromptSubmit", { prompt, ...fields }),
    tool: (tool_name, tool_use_id, fields) => hook("PreToolUse", { tool_name, tool_use_id, tool_input: {}, ...fields }),
    advance: (ms) => { env.RUN_TEST_NOW = String(Number(env.RUN_TEST_NOW) + ms); }
  };
}

// regression: #0013
test("prompt and tool hooks exit on their own after persisting the run start and attempt", async (t) => {
  const h = await setup(t);
  await h.hook("UserPromptSubmit", { prompt: "hello" }, 5000);
  const session = (await h.state()).sessions.root;
  const [report] = await h.reports();
  assert.deepEqual(report, {
    run_id: session.promptId, report_seq: 1, session_id: "root", started_at: new Date(START).toISOString(),
    tool_calls: 0, gated_tool_calls: 0, plan_ids: []
  });
  await h.hook("PreToolUse", { tool_name: "Bash", tool_use_id: "exit-attempt", tool_input: {} }, 5000);
  const run = (await h.state()).runs[session.promptId];
  assert.deepEqual([run.tool_calls, run.gated_tool_calls], [1, 1]);
  await h.prompt();
  assert.equal((await h.reports()).length, 1);
  assert.equal((await h.wal().readPending())[0].login.backend, "https://runs.test");
  assert.doesNotMatch(JSON.stringify(await h.state()), /ak_test_runs_a/);
});

test("root attempts count blocked and held calls once, excluding own tools and subagents", async (t) => {
  const h = await setup(t);
  await h.prompt();
  await h.tool("Bash", "blocked");
  await h.tool("Bash", "blocked");
  await h.hook("PermissionRequest", { tool_name: "Bash", tool_use_id: "blocked" });
  await writeFile(path.join(h.dataDir, "policy.json"), JSON.stringify({ version: 1, policy: { rules: [{ id: "hold", action: "require_approval", tool: "apply_patch" }] } }));
  await h.tool("apply_patch", "held");
  await h.tool("Read", "read");
  for (const [i, name] of ["register_intent_plan", "policy_read", "policy_update", "mcp__armorcodex_policy__register_intent_plan"].entries()) await h.tool(name, `own-${i}`);
  await h.tool("Bash", "child-1", { is_subagent: true });
  await h.tool("Bash", "child-2", { parent_session_id: "root" });
  await h.tool("Bash", "child-3", { session_id: "child", root_session_id: "root" });
  await h.hook("Stop");
  const final = (await h.reports()).at(-1);
  assert.deepEqual([final.tool_calls, final.gated_tool_calls], [3, 2]);
});

test("the shared capability rules govern attempts before monitor and optional intent bypasses", async (t) => {
  const h = await setup(t, { ARMORCODEX_MODE: "monitor", ARMORCODEX_INTENT_REQUIRED: "false" });
  await h.prompt();
  const cases = [
    ["  exec_command  ", true, true], ["container.exec", true, true], ["Read", false, true],
    ["webfetch", false, true], ["ToolSearch", false, true], ["ls", true, true],
    ["mcp__other__register_intent_plan", true, true], ["mcp__other__policy_read", true, true],
    ["mcp__armorcodex-policy__policy_read", false, false], ["policy_update", false, false]
  ];
  for (const [i, [name, gated, counted]] of cases.entries()) {
    await h.tool(name, `call-${i}`);
    const run = Object.values((await h.state()).runs)[0];
    const expected = cases.slice(0, i + 1);
    assert.deepEqual([run.tool_calls, run.gated_tool_calls], [expected.filter((row) => row[2]).length, expected.filter((row) => row[1]).length], name);
  }
  const { RUNS } = await import("../plugins/armorcodex/scripts/lib/runs.mjs");
  assert.deepEqual(RUNS, {
    endReasons: CONTRACT.endReasons, noPlanReasons: CONTRACT.noPlanReasons,
    limits: CONTRACT.limits, capability: CONTRACT.capabilities.armorcodex
  });
});

for (const enabled of ["true", "false"]) {
  // regression: #0013
  test(`tools/list advertises usable plan arguments with run reporting ${enabled}`, async (t) => {
    const h = await setup(t, { ARMORCODEX_RUN_REPORTING_ENABLED: enabled });
    const mcp = await h.connect();
    const tool = (await mcp.listTools()).tools.find(({ name }) => name === "register_intent_plan");
    assert.deepEqual(Object.keys(tool.inputSchema.properties).sort(), ["goal", "plan", "steps"]);
    const steps = tool.inputSchema.properties.steps;
    assert.ok(JSON.stringify(steps).includes('"action"'));
    await h.prompt();
    assert.equal((await mcp.register({ goal: "bad", steps: [] })).isError, true);
    await h.tool("Bash", "schema-deny");
    await h.hook("Stop");
    if (enabled === "true") assert.equal((await h.reports()).at(-1).no_plan_reason, "plan_rejected");
  });
}

for (const [reason, options, tool, registration, detail = ""] of [
  ["monitor_mode", { ARMORCODEX_MODE: "monitor" }, "Bash"],
  ["no_tool_use", {}],
  ["read_only", {}, "Read"],
  ["backend_unreachable", { RUN_TEST_POSTURE: "503" }, "Bash"],
  ["request_failed", { RUN_TEST_PLAN_STATUS: "422" }, "Bash", "remote"],
  ["plan_rejected", {}, "Bash", "local"],
  ["not_registered", {}, "Bash"],
  ["not_registered", { ARMORCODEX_INTENT_REQUIRED: "false" }, "Bash", undefined, " with optional intent in enforce mode"],
  ["monitor_mode", { ARMORCODEX_MODE: "monitor" }, undefined, "local", " before no tool use and a local refusal"],
  ["no_tool_use", { RUN_TEST_PLAN_STATUS: "422" }, undefined, "remote", " before a request failure"],
  ["read_only", { RUN_TEST_PLAN_STATUS: "422" }, "Read", "remote", " before a request failure"],
  ["backend_unreachable", { RUN_TEST_POSTURE: "503", RUN_TEST_PLAN_STATUS: "422" }, "Bash", "remote", " before a request failure"],
  ["plan_rejected", { RUN_TEST_PLAN_STATUS: "422" }, "Bash", "mixed", " when some attempts failed and another was refused locally"]
]) {
  test(`final reports choose ${reason} in contract order${detail}`, async (t) => {
    const h = await setup(t, options);
    await h.prompt();
    if (registration) {
      const mcp = await h.connect();
      if (registration === "mixed") await mcp.register({ goal: "bad plan", steps: [] });
      const result = await mcp.register(registration === "local" ? { goal: "bad plan", steps: [] } : undefined);
      assert.equal(result.isError, true);
    }
    if (tool) await h.tool(tool, "attempt");
    await h.hook("Stop");
    const final = (await h.reports()).at(-1);
    assert.equal(final.no_plan_reason, reason);
    assert.equal(final.end_reason, "stop");
    assert.equal(final.report_seq, 2);
  });
}

for (const event of ["UserPromptSubmit", "SessionEnd", "SessionStart"]) {
  test(`an abandoned run closes durably on ${event}`, async (t) => {
    const h = await setup(t);
    await h.prompt("first");
    const first = (await h.state()).sessions.root.promptId;
    h.advance(10_000);
    await h.hook(event, { prompt: "second" });
    const final = (await h.reports()).find((report) => report.run_id === first && report.ended_at);
    assert.equal(final?.end_reason, { UserPromptSubmit: "next_prompt", SessionEnd: "session_end", SessionStart: "recovered" }[event]);
    assert.equal(final.ended_at, new Date(START + 10_000).toISOString());
    assert.equal(final.no_plan_reason, "no_tool_use");
  });
}

test("recovery closes dead sessions while preserving another live session", async (t) => {
  const h = await setup(t);
  await h.prompt("live");
  await h.prompt("dead", { session_id: "dead" });
  const state = await h.runState();
  const runtime = await h.runtime();
  const deadId = runtime.sessions.dead.promptId;
  state.runs[deadId].owner = { pid: 2147483647, startedAt: "gone" };
  await writeFile(path.join(h.dataDir, "run-state-v1.json"), JSON.stringify(state));
  await h.hook("SessionStart", { session_id: "new" });
  assert.equal((await h.reports()).find((report) => report.run_id === deadId && report.ended_at)?.end_reason, "recovered");
  assert.equal((await h.reports()).some((report) => report.run_id === runtime.sessions.root.promptId && report.ended_at), false);
});

for (const ending of ["Stop", "UserPromptSubmit", "SessionEnd"]) {
  test(`outstanding registration settles after ${ending} without changing the next run`, async (t) => {
    const h = await setup(t, { RUN_TEST_DEFER: "true" });
    await h.prompt("first");
    const firstId = (await h.state()).sessions.root.promptId;
    const mcp = await h.connect();
    const registering = mcp.register();
    await mcp.tokenRequested;
    await h.hook(ending, { prompt: "second" });
    assert.equal((await h.reports()).some((report) => report.run_id === firstId && report.ended_at), false);
    await mcp.release();
    await registering;
    const final = (await h.reports()).find((report) => report.run_id === firstId && report.ended_at);
    assert.deepEqual(final.plan_ids, [PLAN_ID]);
    assert.equal(final.no_plan_reason, undefined);
    if (ending === "UserPromptSubmit") {
      const session = (await h.state()).sessions.root;
      assert.notEqual(session.promptId, firstId);
      assert.equal(session.countedPlanId, null);
      const second = (await h.reports()).filter((report) => report.run_id === session.promptId);
      assert.deepEqual(second.map((report) => report.plan_ids), [[]]);
    }
  });
}

test("authenticated monitor runs deliver from the MCP flusher through the reports endpoint", async (t) => {
  const h = await setup(t, { ARMORCODEX_MODE: "monitor", RUN_TEST_RUN_STATUS: "200" });
  await h.prompt();
  await h.tool("Bash", "monitor-call");
  await h.hook("Stop");
  const mcp = await h.connect();
  await mcp.close();
  const requests = await h.requests();
  const reports = requests.filter(({ url }) => url.endsWith("/iap/runs/batch")).flatMap(({ body }) => body.reports);
  assert.deepEqual(reports.map(({ report_seq }) => report_seq), [1, 2]);
  assert.equal(reports[1].no_plan_reason, "monitor_mode");
  assert.deepEqual(await h.reports(), []);
});

test("registration retries reuse one logical attempt and confirmed plans suppress the reason", async (t) => {
  const h = await setup(t);
  await h.prompt();
  const mcp = await h.connect();
  await mcp.register();
  await mcp.register();
  const run = Object.values((await h.state()).runs)[0];
  assert.equal(Object.keys(run.registrations).length, 1);
  assert.equal((await h.requests()).filter(({ url }) => url.endsWith("/intent")).length, 1);
  await h.hook("Stop");
  const final = (await h.reports()).at(-1);
  assert.deepEqual(final.plan_ids, [PLAN_ID]);
  assert.equal(final.no_plan_reason, undefined);
});

test("a failed outbox handoff retains the final receipt and replays it once", async (t) => {
  const h = await setup(t);
  await h.prompt();
  const runId = (await h.state()).sessions.root.promptId;
  const dir = path.join(h.dataDir, "runs");
  await rename(dir, `${dir}-saved`);
  await writeFile(dir, "unavailable outbox");
  await h.hook("Stop");
  const state = await h.state();
  assert.equal(state.runs[runId], undefined);
  assert.deepEqual(state.runReports.map(({ report }) => [report.run_id, report.report_seq, report.end_reason]), [[runId, 2, "stop"]]);
  await rm(dir);
  await rename(`${dir}-saved`, dir);
  await h.hook("SessionStart");
  await h.hook("SessionStart");
  assert.deepEqual((await h.reports()).map(({ report_seq }) => report_seq), [1, 2]);
  assert.deepEqual((await h.state()).runReports, []);
});

// regression: #0013
test("a crashed registration releases its timers and settles from durable facts at the next prompt", async (t) => {
  const timers = new Map();
  const tracker = createHook({
    init(id, type, trigger, resource) { if (type === "Timeout") timers.set(id, resource); },
    destroy(id) { timers.delete(id); }
  }).enable();
  t.after(() => tracker.disable());
  const h = await setup(t, { RUN_TEST_DEFER: "true" });
  await h.prompt("first");
  await h.tool("Bash", "blocked-before-registration");
  const firstId = (await h.state()).sessions.root.promptId;
  const mcp = await h.connect();
  const registering = mcp.register().catch((error) => error);
  await mcp.tokenRequested;
  mcp.crash();
  await registering;
  await new Promise(setImmediate);
  assert.equal([...timers.values()].filter((timer) => timer.hasRef()).length, 0, "a crashed registration must not keep the process alive");
  await h.prompt("second");
  const final = (await h.reports()).find((report) => report.run_id === firstId && report.ended_at);
  assert.equal(final.end_reason, "next_prompt");
  assert.equal(final.no_plan_reason, "request_failed");
  assert.deepEqual(final.plan_ids, []);
});

test("a login change during a run keeps both reports bound to the original key", async (t) => {
  const h = await setup(t, { RUN_TEST_RUN_STATUS: "200" });
  await h.prompt();
  const originalBinding = (await h.wal().readPending())[0].login;
  await rm(path.join(h.home, ".armoriq", "credentials.json"));
  await h.hook("Stop");
  h.login("ak_test_runs_b");
  const other = await h.connect();
  await other.close();
  assert.equal((await h.requests()).filter(({ url }) => url.endsWith("/iap/runs/batch")).length, 0);
  assert.ok((await h.wal().readPending()).every(({ login }) => login.keyId === originalBinding.keyId));
  h.login();
  const original = await h.connect();
  await original.close();
  assert.deepEqual(await h.reports(), []);
});

test("local status shows pending reports and an endpoint pause", async (t) => {
  const h = await setup(t);
  await h.prompt();
  const mcp = await h.connect();
  await mcp.close();
  const output = await h.prompt("armor status");
  assert.match(output.reason, /Run reports waiting to upload: 1/);
  assert.match(output.reason, /Run reporting paused: yes/);
});

// regression: #0013
test("reporting defaults off and never captures logged out runs", async (t) => {
  assert.equal(loadSettings({}).runReportingEnabled, false);
  for (const [env, enabled] of [
    [{ ARMORIQ_RUN_REPORTING_ENABLED: "true" }, true],
    [{ ARMORCODEX_RUN_REPORTING_ENABLED: "false", ARMORIQ_RUN_REPORTING_ENABLED: "true" }, false]
  ]) assert.equal(loadSettings(env).runReportingEnabled, enabled);
  for (const [options, loggedIn] of [[{ ARMORCODEX_RUN_REPORTING_ENABLED: "false" }, true], [{}, false]]) {
    const h = await setup(t, options, loggedIn);
    const output = await h.prompt();
    assert.match(output.hookSpecificOutput.additionalContext, /For this prompt, call `register_intent_plan`/);
    if (options.ARMORCODEX_RUN_REPORTING_ENABLED === "false") {
      const rootOnly = await h.prompt("child prompt", { session_id: "root-only", root_session_id: "root" });
      assert.match(rootOnly.hookSpecificOutput.additionalContext, /For this prompt/);
      assert.ok((await h.runtime()).sessions["root-only"].promptId);
      const child = { session_id: "child", is_subagent: true };
      const started = await h.hook("SessionStart", child);
      assert.match(started.hookSpecificOutput.additionalContext, /ArmorCodex active/);
      await h.hook("Stop", child);
      assert.equal((await h.runtime()).sessions.child.promptOpenSince, null);
      await h.hook("SessionEnd", child);
      assert.equal((await h.runtime()).sessions.child, undefined);
      const status = await h.prompt("armor status");
      assert.doesNotMatch(status.reason, /Run reports|Run reporting/);
      await assert.rejects(access(path.join(h.dataDir, "run-state-v1.json")), { code: "ENOENT" });
      await assert.rejects(access(path.join(h.dataDir, "runs")), { code: "ENOENT" });
    }
    if (!loggedIn) h.login();
    await h.hook("Stop");
    const mcp = await h.connect();
    await mcp.close();
    assert.deepEqual(await h.reports(), []);
    assert.deepEqual((await h.runtime()).runReports ?? [], []);
    assert.equal((await h.requests()).filter(({ url }) => url.endsWith("/iap/runs/batch")).length, 0);
  }
});

// regression: #0013
test("R15: a released runtime writer cannot erase open runs or final receipts", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: START });
  const h = await setup(t);
  await h.prompt();
  const runId = (await h.runtime()).sessions.root.promptId;
  const source = execFileSync("git", ["show", "origin/dev:plugins/armorcodex/scripts/lib/runtime-state.mjs"], { encoding: "utf8" });
  const lib = new URL("../plugins/armorcodex/scripts/lib/", import.meta.url);
  const released = await import(`data:text/javascript,${encodeURIComponent(source.replace(/"\.\/(common|fs-store)\.mjs"/g, (_, name) => JSON.stringify(new URL(`${name}.mjs`, lib).href)))}`);
  const rewrite = async () => {
    const state = await released.loadRuntimeState(path.join(h.dataDir, "runtime.json"));
    await released.saveRuntimeState(path.join(h.dataDir, "runtime.json"), state);
  };
  await rewrite();
  await h.tool("Bash", "released-writer");
  await rename(path.join(h.dataDir, "runs"), path.join(h.dataDir, "runs-saved"));
  await writeFile(path.join(h.dataDir, "runs"), "unavailable");
  await h.hook("Stop");
  await rewrite();
  assert.equal((await h.runState()).runReports[0].report.run_id, runId);
  assert.equal((await h.runtime()).runs, undefined);
  assert.equal((await h.runtime()).runReports, undefined);
  await rm(path.join(h.dataDir, "runs"));
  await rename(path.join(h.dataDir, "runs-saved"), path.join(h.dataDir, "runs"));
  await h.hook("SessionStart");
  const final = (await h.reports()).at(-1);
  assert.deepEqual([final.run_id, final.tool_calls, final.end_reason], [runId, 1, "stop"]);
});

for (const [enabled, status] of [["true", "200"], ["true", "422"], ["false", "200"]]) {
  // regression: #0013
  test(`broken run storage preserves registration and cleanup (enabled ${enabled}, status ${status})`, async (t) => {
    const h = await setup(t, { ARMORCODEX_RUN_REPORTING_ENABLED: enabled, RUN_TEST_PLAN_STATUS: status });
    await h.prompt();
    if (enabled === "true") await access(path.join(h.dataDir, "run-state-v1.json"));
    await rm(path.join(h.dataDir, "run-state-v1.json"), { force: true });
    await writeFile(path.join(h.dataDir, "run-state-v1.json"), "{broken");
    if (enabled === "false") {
      await rm(path.join(h.dataDir, "runs"), { recursive: true, force: true });
      await writeFile(path.join(h.dataDir, "runs"), "unavailable");
    }
    const mcp = await h.connect();
    const result = await mcp.register();
    assert.equal(result.isError ?? false, status !== "200", result.content[0].text);
    assert.match(result.content[0].text, status === "200" ? /Intent registered: plan/ : /Plan not registered: registration refused/);
    const session = (await h.runtime()).sessions.root;
    assert.equal(session.pendingRequest, null);
    assert.equal(session.countedPlanId, status === "200" ? PLAN_ID : null);
    if (enabled === "false") assert.equal(await readFile(path.join(h.dataDir, "run-state-v1.json"), "utf8"), "{broken");
  });
}

// regression: #0013
test("recovery preserves a different session whose harness is unknown", async (t) => {
  const h = await setup(t);
  await h.prompt();
  const state = await h.runState();
  state.runs[(await h.runtime()).sessions.root.promptId].owner = null;
  await writeFile(path.join(h.dataDir, "run-state-v1.json"), JSON.stringify(state));
  await h.hook("SessionStart", { session_id: "other" });
  assert.equal((await h.reports()).some(({ ended_at }) => ended_at), false);
  h.advance(30 * 60_000);
  await h.hook("SessionStart", { session_id: "other" });
  assert.equal((await h.reports()).find(({ ended_at }) => ended_at)?.end_reason, "recovered");
});

for (const enabled of ["true", "false"]) {
  // regression: #0013
  test(`invalid registration preserves validation with a held runtime lock (${enabled})`, async (t) => {
    const h = await setup(t, { ARMORCODEX_RUN_REPORTING_ENABLED: enabled, RUN_TEST_TICK: "true" });
    await h.prompt();
    const mcp = await h.connect();
    const file = path.join(h.dataDir, "runtime.json.lock");
    await writeFile(file, String(process.pid));
    try {
      const result = await mcp.register({});
      assert.equal(result.isError, true);
      assert.match(result.content[0].text, /goal|steps/);
      assert.doesNotMatch(result.content[0].text, /held by another process/);
    } finally { await rm(file, { force: true }); }
  });
}

// regression: #0013
test("a live same-session notification keeps counting the current run", async (t) => {
  const h = await setup(t);
  await h.prompt();
  await h.hook("SessionStart", { source: "notification" });
  await h.tool("Bash", "after-notification");
  await h.hook("Stop");
  const final = (await h.reports()).at(-1);
  assert.equal(final.end_reason, "stop");
  assert.equal(final.tool_calls, 1);
});

// regression: #0013
test("corrupt run state is preserved and visible while new runs and enforcement continue", async (t) => {
  const h = await setup(t);
  await h.prompt();
  await writeFile(path.join(h.dataDir, "run-state-v1.json"), "{broken");
  const denied = await h.tool("Bash", "corrupt-state");
  assert.match(denied.hookSpecificOutput.permissionDecisionReason, /intent plan missing/);
  const saved = (await readdir(h.dataDir)).filter((name) => name.startsWith("run-state-v1.json.corrupt."));
  assert.equal(saved.length, 1);
  assert.equal(await readFile(path.join(h.dataDir, saved[0]), "utf8"), "{broken");
  const status = await h.prompt("armor status");
  assert.match(status.reason, /Run state files set aside: 1/);
  await h.hook("Stop");
  assert.equal((await h.reports()).at(-1).tool_calls, 1);
});

// regression: #0013
test("prompt identity commits before run storage is locked and a later hook repairs a missing run", async (t) => {
  const h = await setup(t);
  const config = loadSettings(h.env);
  const lock = path.join(h.dataDir, "run-state-v1.json.lock");
  await mkdir(h.dataDir, { recursive: true });
  await writeFile(lock, String(process.pid));
  const original = fsPromises.writeFile;
  let observed = false;
  let committed;
  let runtimeLocked;
  const mocked = t.mock.method(fsPromises, "writeFile", async (file, ...args) => {
    if (String(file) === lock && !observed) {
      observed = true;
      committed = await h.runtime().catch(() => null);
      runtimeLocked = await access(path.join(h.dataDir, "runtime.json.lock")).then(() => true, () => false);
      await rm(lock);
    }
    return original(file, ...args);
  });
  syncBuiltinESMExports();
  t.after(() => { mocked.mock.restore(); syncBuiltinESMExports(); });
  await handleUserPromptSubmit({ session_id: "root", prompt: "first" }, config);
  assert.equal(observed, true);
  assert.equal(committed?.sessions.root.runId, committed?.sessions.root.promptId);
  assert.ok(committed?.sessions.root.runId);
  assert.equal(runtimeLocked, false);
  await rm(path.join(h.dataDir, "run-state-v1.json"));
  await mkdir(path.join(h.dataDir, "run-state-v1.json"));
  await h.prompt("second");
  const session = (await h.runtime()).sessions.root;
  assert.equal(session.runId, session.promptId);
  await rm(path.join(h.dataDir, "run-state-v1.json"), { recursive: true });
  await h.tool("Read", "repaired");
  const run = (await h.state()).runs[session.promptId];
  assert.equal(run.tool_calls, 1);
  assert.equal((await h.reports()).some(({ run_id }) => run_id === session.promptId), true);
});

// regression: #0013
test("counting tools and idle publishing preserve the run snapshot inode", async (t) => {
  const h = await setup(t);
  await h.prompt();
  const file = path.join(h.dataDir, "run-state-v1.json");
  const before = await stat(file);
  const snapshot = await readFile(file, "utf8");
  await h.tool("Read", "append-only");
  await h.tool("Read", "append-only");
  assert.equal((await stat(file)).ino, before.ino);
  assert.equal(await readFile(file, "utf8"), snapshot);
  assert.equal(Object.values((await h.state()).runs)[0].tool_calls, 1);
  await publishRunReports(loadSettings(h.env));
  await publishRunReports(loadSettings(h.env));
  assert.equal((await stat(file)).ino, before.ino);
  assert.equal(await readFile(file, "utf8"), snapshot);
});

// regression: #0013
test("a resumed session resolves its new harness before another session recovers runs", async (t) => {
  const h = await setup(t);
  await h.prompt("first");
  const runtime = await h.runtime();
  runtime.sessions.root.runOwner = { pid: 2147483647, startedAt: "gone" };
  await writeFile(path.join(h.dataDir, "runtime.json"), JSON.stringify(runtime));
  await h.hook("SessionStart");
  h.advance(10_000);
  await h.prompt("resumed");
  const runId = (await h.runtime()).sessions.root.promptId;
  await h.hook("SessionStart", { session_id: "other" });
  assert.equal((await h.reports()).some((report) => report.run_id === runId && report.ended_at), false);
});
