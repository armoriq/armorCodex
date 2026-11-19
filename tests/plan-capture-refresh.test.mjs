import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { handlePreToolUse, handleStop } from "../plugins/armorcodex/scripts/lib/engine.mjs";
import { beginPrompt, retireSessionPlan, syncSessionAuth, withRuntimeState } from "../plugins/armorcodex/scripts/lib/runtime-state.mjs";
import { idempotencyKey, planHash } from "../plugins/armorcodex/scripts/lib/plan-request.mjs";
import { recordBackendOutcome } from "../plugins/armorcodex/scripts/lib/backend-posture.mjs";

const NOW = Date.parse("2026-11-14T12:00:00Z");
const SESSION = "refresh-session";
const PLAN = { goal: "inspect files", steps: [{ action: "Bash", metadata: { inputs: {} } }] };
const PARENT = "11111111-1111-4111-8111-111111111111";
const TOKEN = "22222222-2222-4222-8222-222222222222";
const refreshModule = () => import("../plugins/armorcodex/scripts/lib/plan-refresh.mjs");
const requirePlugin = createRequire(new URL("../plugins/armorcodex/package.json", import.meta.url));

async function setup(t, { remaining = 60, validity = 180, backendEndpoint, transport = "custom" } = {}) {
  t.mock.timers.enable({ apis: ["Date", "setInterval", "setTimeout"], now: NOW });
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "armorcodex-refresh-"));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const config = {
    dataDir, runtimeFile: path.join(dataDir, "runtime.json"), policyFile: path.join(dataDir, "policy.json"),
    mode: "enforce", apiKey: "ak_test_refresh", intentEndpoint: transport === "custom" ? "https://refresh.test/intent" : "",
    useSdkIntent: true, backendEndpoint: backendEndpoint ?? (transport === "sdk" ? "https://refresh.test" : undefined),
    iapEndpoint: "https://refresh.test", proxyEndpoint: "https://refresh.test", llmId: "codex", verifySsl: true,
    validitySeconds: validity, timeoutMs: 8000, intentRequired: true, sanitize: {},
    userId: "refresh-user", agentId: "codex", auditEnabled: false
  };
  const update = (change) => withRuntimeState(config.runtimeFile, (state) => change(state.sessions[SESSION]));
  const state = async () => JSON.parse(await readFile(config.runtimeFile, "utf8")).sessions[SESSION];
  await withRuntimeState(config.runtimeFile, (runtime) => {
    const session = syncSessionAuth(runtime, SESSION, config);
    beginPrompt(session, "inspect files");
    Object.assign(session, {
      lastActivityAt: NOW / 1000, countedPlanId: PARENT, tokenPlanId: PARENT,
      plan: PLAN, planHash: planHash(PLAN), kind: "new",
      tokenExpiresAt: new Date(NOW + remaining * 1000).toISOString(), expiresAt: NOW / 1000 + remaining,
      intentTokenRaw: JSON.stringify({ plan: PLAN, expiresAt: NOW / 1000 + remaining })
    });
  });
  const requests = [];
  let requested;
  const firstRequest = new Promise((resolve) => { requested = resolve; });
  let respond = () => new Response(JSON.stringify({
    success: true, plan_id: TOKEN, kind: "refresh",
    token: { expires_at: Date.now() / 1000 + 180 },
    intentTokenRaw: JSON.stringify({ plan: PLAN, expiresAt: Date.now() / 1000 + 180 })
  }));
  const answer = async (url, body, headers) => {
    requests.push({ url, body, headers, descriptor: (await state()).pendingRequest });
    requested();
    return respond();
  };
  if (transport === "sdk") {
    const axios = requirePlugin("axios");
    const originalAdapter = axios.defaults.adapter;
    t.after(() => { axios.defaults.adapter = originalAdapter; });
    axios.defaults.adapter = async (request) => {
      const response = await answer(request.url, JSON.parse(request.data), request.headers.toJSON());
      return { status: response.status, headers: {}, config: request, data: await response.json() };
    };
  } else {
    t.mock.method(globalThis, "fetch", (url, init) => answer(url, JSON.parse(init.body), init.headers));
  }
  const errors = [];
  return {
    config, state, update, requests, errors, firstRequest,
    respond: (answer) => { respond = answer; },
    start: async () => {
      const { createPlanRefresher } = await refreshModule();
      const refresher = createPlanRefresher({ currentConfig: () => config, onError: (error) => errors.push(error) });
      t.after(() => refresher.stop());
      return refresher;
    }
  };
}

for (const [validity, remaining, transport] of [[180, 60, "custom"], [3600, 120, "custom"], [180, 60, "sdk"]]) {
  test(`the 15 second refresh loop uses the ${transport} transport and the ${validity} second validity threshold`, async (t) => {
    const h = await setup(t, { validity, remaining: remaining + 16, transport });
    const before = await h.state();
    const loop = await h.start();
    t.mock.timers.tick(15000);
    await loop.run();
    assert.equal(h.requests.length, 0);
    t.mock.timers.tick(15000);
    await h.firstRequest;
    await loop.stop();
    assert.equal(h.requests.length, 1);
    const [request] = h.requests;
    assert.equal(request.headers["X-ArmorIQ-Plan-Kind"], "refresh");
    assert.equal(request.headers["X-ArmorIQ-Parent-Plan-Id"], PARENT);
    assert.equal(request.headers["Idempotency-Key"], idempotencyKey({ kind: "refresh", countedPlanId: PARENT, tokenExpiresAt: before.tokenExpiresAt }));
    assert.deepEqual(request.body, request.descriptor.body);
    assert.equal(request.descriptor.key, request.headers["Idempotency-Key"]);
    const after = await h.state();
    assert.equal(after.countedPlanId, PARENT);
    assert.equal(after.kind, "new");
    assert.equal(after.tokenPlanId, TOKEN);
    assert.equal(after.tokenExpiresAt, new Date(Date.now() + 180000).toISOString());
    assert.equal(after.pendingRequest, null);
    assert.equal(after.lastActivityAt, before.lastActivityAt);
    const nextLoop = await h.start();
    t.mock.timers.tick((180 - Math.min(120, validity / 3)) * 1000);
    await nextLoop.run();
    assert.equal(h.requests.length, 2);
    assert.equal(h.requests[1].headers["X-ArmorIQ-Parent-Plan-Id"], PARENT);
    assert.equal(h.requests[1].headers["Idempotency-Key"], idempotencyKey({ kind: "refresh", countedPlanId: PARENT, tokenExpiresAt: after.tokenExpiresAt }));
    assert.notEqual(h.requests[1].headers["Idempotency-Key"], request.headers["Idempotency-Key"]);
    assert.equal((await h.state()).countedPlanId, PARENT);
  });
}

for (const condition of ["closed", "idle", "retired", "logged out", "monitor", "signed out", "hook monitor", "no transport"]) {
  // regression: #0007
  test(`the refresh loop sends nothing for a ${condition} prompt`, async (t) => {
    const h = await setup(t, { backendEndpoint: condition === "signed out" ? "https://refresh.test" : undefined });
    if (condition === "closed") await handleStop({ session_id: SESSION }, h.config);
    if (condition === "idle") t.mock.timers.tick(1800000);
    if (condition === "retired") await h.update(retireSessionPlan);
    if (condition === "logged out") h.config.apiKey = "";
    if (condition === "monitor") h.config.mode = "monitor";
    if (condition === "signed out") {
      await recordBackendOutcome(h.config, "signed_out");
    }
    if (condition === "hook monitor") await h.update((session) => { session.mode = "monitor"; });
    if (condition === "no transport") {
      h.config.useSdkIntent = false;
      h.config.intentEndpoint = "";
    }
    const loop = await h.start();
    t.mock.timers.tick(15000);
    await loop.run();
    assert.deepEqual(h.requests, []);
    assert.deepEqual(h.errors, []);
  });
}

// regression: #0007
test("a refresh scan with different process settings preserves the login generation and plan", async (t) => {
  const h = await setup(t, { remaining: 600 });
  const before = await h.state();
  h.config.backendEndpoint = "https://different.test";
  const loop = await h.start();
  for (let i = 0; i < 3; i++) {
    await loop.run();
    const after = await h.state();
    assert.equal(after.authGeneration, before.authGeneration);
    assert.equal(after.countedPlanId, before.countedPlanId);
    assert.equal(after.intentTokenRaw, before.intentTokenRaw);
  }
  assert.deepEqual(h.requests, []);
});

for (const change of ["prompt", "auth", "stop"]) {
  test(`a refresh reply after ${change} is not installed and ticks stay single flight`, async (t) => {
    const h = await setup(t);
    let release;
    let requested;
    const started = new Promise((resolve) => { requested = resolve; });
    h.respond(() => new Promise((resolve) => { release = resolve; requested(); }));
    const loop = await h.start();
    const refreshing = loop.run();
    await started;
    t.mock.timers.tick(30000);
    if (change === "prompt") await h.update((session) => beginPrompt(session, "next prompt"));
    if (change === "auth") {
      h.config.apiKey = "ak_test_changed";
      await withRuntimeState(h.config.runtimeFile, (state) => syncSessionAuth(state, SESSION, h.config));
    }
    if (change === "stop") await handleStop({ session_id: SESSION }, h.config);
    release(new Response(JSON.stringify({ plan_id: TOKEN, kind: "refresh", intentTokenRaw: JSON.stringify({ plan: PLAN, expiresAt: Date.now() / 1000 + 180 }) })));
    await refreshing;
    await loop.run();
    assert.equal(h.requests.length, 1);
    const session = await h.state();
    assert.notEqual(session.tokenPlanId, TOKEN);
    if (change !== "stop") assert.equal(session.countedPlanId, null);
  });
}

for (const condition of ["success", "failure", "closed", "idle"]) {
  test(`the pre tool guard handles an expired token with refresh ${condition}`, async (t) => {
    const h = await setup(t, { remaining: -1 });
    if (condition === "failure") h.respond(() => new Response(JSON.stringify({ message: "refused" }), { status: 422 }));
    if (condition === "closed") await handleStop({ session_id: SESSION }, h.config);
    if (condition === "idle") t.mock.timers.tick(1800000);
    const input = { session_id: SESSION, tool_name: "Bash", tool_input: { command: "pwd" } };
    const result = await handlePreToolUse(input, h.config);
    assert.equal(h.requests.length, ["success", "failure"].includes(condition) ? 1 : 0);
    if (condition === "success") {
      assert.equal(result, null);
      assert.equal((await h.state()).tokenPlanId, TOKEN);
      assert.equal(await handlePreToolUse(input, h.config), null);
      assert.equal(h.requests.length, 1);
    } else {
      assert.match(JSON.stringify(result), /expired/i);
      assert.equal((await h.state()).tokenPlanId, PARENT);
    }
  });
}

test("failed refreshes retain an unconfirmed descriptor and back off between logical requests", async (t) => {
  const h = await setup(t);
  h.respond(() => {
    t.mock.timers.tick(40000);
    return new Response(JSON.stringify({ message: "unavailable" }), { status: 503 });
  });
  const loop = await h.start();
  await loop.run();
  assert.equal(h.requests.length, 1);
  assert.ok((await h.state()).pendingRequest);
  t.mock.timers.tick(15000);
  await loop.run();
  assert.equal(h.requests.length, 1);
  t.mock.timers.tick(15000);
  await loop.run();
  assert.equal(h.requests.length, 2);
  assert.deepEqual(h.requests[1], h.requests[0]);
  assert.equal((await h.state()).tokenPlanId, PARENT);
  assert.equal(h.errors.length, 2);
});

test("a tool waiting for a background refresh uses its confirmed token", async (t) => {
  const h = await setup(t, { remaining: -1 });
  let release;
  let requested;
  const started = new Promise((resolve) => { requested = resolve; });
  h.respond(() => new Promise((resolve) => { release = resolve; requested(); }));
  const loop = await h.start();
  const refreshing = loop.run();
  await started;
  let guardReady;
  const waiting = new Promise((resolve) => { guardReady = resolve; });
  h.config.readCurrentAuth = () => { guardReady(); return h.config; };
  const guarding = handlePreToolUse({ session_id: SESSION, tool_name: "Bash", tool_input: { command: "pwd" } }, h.config);
  await waiting;
  release(new Response(JSON.stringify({ plan_id: TOKEN, kind: "refresh", intentTokenRaw: JSON.stringify({ plan: PLAN, expiresAt: Date.now() / 1000 + 180 }) })));
  await refreshing;
  assert.equal(await guarding, null);
  assert.equal(h.requests.length, 1);
});

// regression: #0007
test("a refresh arriving during step verification keeps its token and allows the tool", async (t) => {
  const h = await setup(t);
  h.config.csrgVerifyEnabled = true;
  h.config.verifyStepEndpoint = "https://refresh.test/verify";
  const fetch = globalThis.fetch;
  let release;
  let started;
  const verifying = new Promise((resolve) => { started = resolve; });
  t.mock.method(globalThis, "fetch", (url, init) => {
    if (String(url) !== h.config.verifyStepEndpoint) return fetch(url, init);
    started();
    return new Promise((resolve) => { release = () => resolve(new Response(JSON.stringify({ allowed: true }))); });
  });
  const guarding = handlePreToolUse({ session_id: SESSION, tool_name: "Bash", tool_input: {} }, h.config);
  await verifying;
  const loop = await h.start();
  await loop.run();
  release();
  assert.equal(await guarding, null);
  assert.equal((await h.state()).tokenPlanId, TOKEN);
  assert.equal((await h.state()).intentTokenRaw, JSON.stringify({ plan: PLAN, expiresAt: Date.now() / 1000 + 180 }));
});

test("a tool does not refresh with a key the backend rejected", async (t) => {
  const h = await setup(t, { remaining: -1, backendEndpoint: "https://refresh.test" });
  h.config.readCurrentAuth = () => h.config;
  await recordBackendOutcome(h.config, "signed_out");
  const result = await handlePreToolUse({ session_id: SESSION, tool_name: "Bash", tool_input: {} }, h.config);
  assert.deepEqual(h.requests, []);
  assert.match(JSON.stringify(result), /expired/i);
});

test("a synchronous refresh stops at the 40 second logical deadline", async (t) => {
  const h = await setup(t, { remaining: -1 });
  let requested;
  const started = new Promise((resolve) => { requested = resolve; });
  h.respond(() => { requested(); return new Promise(() => {}); });
  const guarding = handlePreToolUse({ session_id: SESSION, tool_name: "Bash", tool_input: {} }, h.config);
  await started;
  t.mock.timers.tick(40000);
  assert.match(JSON.stringify(await guarding), /expired/i);
  assert.equal(h.requests.length, 1);
  assert.equal((await h.state()).tokenPlanId, PARENT);
  assert.ok((await h.state()).pendingRequest);
});
