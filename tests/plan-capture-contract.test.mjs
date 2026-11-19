import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { loadConfig, loadSettings } from "../plugins/armorcodex/scripts/lib/config.mjs";
import { beginPrompt, retireSessionPlan, syncSessionAuth, withRuntimeState } from "../plugins/armorcodex/scripts/lib/runtime-state.mjs";
import { signIn, withHome } from "./helpers/login.mjs";
import { recordBackendOutcome } from "../plugins/armorcodex/scripts/lib/backend-posture.mjs";
import { handlePreToolUse } from "../plugins/armorcodex/scripts/lib/engine.mjs";

const requirePlugin = createRequire(new URL("../plugins/armorcodex/package.json", import.meta.url));
const { Client } = requirePlugin("@modelcontextprotocol/sdk/client/index.js");
const { StdioClientTransport } = requirePlugin("@modelcontextprotocol/sdk/client/stdio.js");
const SERVER = fileURLToPath(new URL("../plugins/armorcodex/scripts/policy-mcp.mjs", import.meta.url));
const SDK = requirePlugin.resolve("axios");
const contract = JSON.parse(await readFile(new URL("./fixtures/plan-capture-v1.json", import.meta.url), "utf8"));
const SESSION = "contract-session";
const PLAN = { goal: "inspect files", steps: [{ action: "Bash", metadata: { inputs: {} } }] };
const EXPIRES = Math.floor(Date.now() / 1000) + 3600;
const requestModule = () => import("../plugins/armorcodex/scripts/lib/plan-request.mjs");

// regression: #0007
test("every canonical JSON, plan hash and request key vector matches the shared contract", async () => {
  const { canonicalJson, planHash, idempotencyKey } = await requestModule();
  for (const row of contract.canonicalJson) assert.equal(canonicalJson(row.input), row.expected, row.name);
  for (const row of contract.planHash) assert.equal(planHash(row.plan), row.expected, row.name);
  for (const row of contract.idempotencyKey) assert.equal(idempotencyKey(row.input), row.expected, row.name);
  for (const row of contract.idempotencyKey.filter((row) => row.input.kind === "refresh")) {
    assert.equal(idempotencyKey({ ...row.input, epoch: 2 }), row.expected, row.name);
  }
});

async function setup(t, options = {}) {
  const home = await mkdtemp(path.join(os.tmpdir(), "armorcodex-contract-"));
  const env = {
    HOME: home, TMPDIR: os.tmpdir(), ARMORCODEX_DATA_DIR: path.join(home, "data"),
    ARMORCODEX_MODE: "enforce", ARMORCODEX_OBSERVABILITY_DISABLED: "true",
    ARMORCODEX_USAGE_SYNC_DISABLED: "true", ...options.env
  };
  const config = () => withHome(home, () => loadConfig(env));
  if (!options.loggedOut) signIn(home, { backend: config().backendEndpoint, apiKey: "ak_test_contract000000000000000000" });
  const requestsFile = path.join(home, "requests.json");
  const preload = path.join(home, "transport.mjs");
  await writeFile(preload, `
import fs from "node:fs";
import { createRequire } from "node:module";
const axios = createRequire(import.meta.url)(${JSON.stringify(SDK)});
const replies = ${JSON.stringify(options.replies || [{}])};
const replayByKey = ${Boolean(options.replayByKey)};
const responses = new Map();
const requests = [];
const originalNow = Date.now;
let clockAdvance = 0;
Date.now = () => originalNow() + clockAdvance;
let release;
const released = new Promise((resolve) => { release = resolve; });
async function answer(url, body, headers) {
  if (!url.endsWith("/iap/sdk/token") && url !== "https://contract.test/intent") {
    return { status: 200, headers: {}, data: {} };
  }
  const state = JSON.parse(fs.readFileSync(${JSON.stringify(config().runtimeFile)}, "utf8"));
  requests.push({ body, headers, descriptor: state.sessions[${JSON.stringify(SESSION)}].pendingRequest });
  fs.writeFileSync(${JSON.stringify(requestsFile)}, JSON.stringify(requests));
  process.stderr.write("contract-request\\n");
  const key = headers["Idempotency-Key"];
  if (replayByKey && responses.has(key)) return responses.get(key);
  const row = replies[Math.min(requests.length - 1, replies.length - 1)];
  clockAdvance += row.clockAdvance || 0;
  if (row.defer) {
    let incoming = "";
    process.stdin.on("data", (chunk) => {
      incoming += chunk;
      const lines = incoming.split("\\n");
      incoming = lines.pop();
      for (const line of lines) {
        if (JSON.parse(line).params?.name === "policy_read") release();
      }
    });
    await released;
  }
  if (row.network) throw Object.assign(new Error("connection reset"), { code: "ECONNRESET" });
  if (row.transportError) throw Object.assign(new Error(row.reason), { code: row.transportError });
  const data = row.status ? { error: row.error, message: row.reason || "refused" } : {
    success: true, plan_id: "11111111-1111-4111-8111-" + String(requests.length).padStart(12, "0"),
    ...(row.legacy ? {} : { kind: headers["X-ArmorIQ-Plan-Kind"] }),
    token: { expires_at: ${EXPIRES} },
    intentTokenRaw: JSON.stringify({ plan: body.plan, expiresAt: ${EXPIRES} })
  };
  const response = { status: row.status || 200, headers: row.headers || {}, data, text: row.nonJson, streamError: row.streamError };
  if (replayByKey && !row.status) responses.set(key, response);
  return response;
}
axios.defaults.adapter = async (config) => {
  try {
    return { ...await answer(config.url, JSON.parse(config.data || "{}"), config.headers.toJSON()), config, statusText: "contract" };
  } catch (error) {
    error.config = config;
    throw error;
  }
};
globalThis.fetch = async (url, init = {}) => {
  const result = await answer(String(url), JSON.parse(init.body || "{}"), init.headers || {});
  const body = result.streamError
    ? new ReadableStream({ start(controller) { controller.error(new TypeError("connection reset")); } })
    : result.text ?? JSON.stringify(result.data);
  return new Response(body, { status: result.status, headers: { "content-type": "application/json", ...result.headers } });
};
`);
  let client;
  t.after(async () => {
    await client?.close();
    await rm(home, { recursive: true, force: true });
  });
  const prompt = (text) => withRuntimeState(config().runtimeFile, (state) => beginPrompt(syncSessionAuth(state, SESSION, config()), text));
  await prompt("first prompt");
  const transport = new StdioClientTransport({ command: process.execPath, args: ["--import", preload, SERVER], env, stderr: "pipe" });
  let stderr = "";
  let requested;
  const tokenRequested = new Promise((resolve) => { requested = resolve; });
  transport.stderr.on("data", (chunk) => { stderr += chunk; if (stderr.includes("contract-request")) requested(); });
  client = new Client({ name: "plan-contract-test", version: "1" });
  await client.connect(transport);
  return {
    home, config, prompt, client, tokenRequested, stderr: () => stderr,
    state: async () => JSON.parse(await readFile(config().runtimeFile, "utf8")).sessions[SESSION],
    requests: async () => JSON.parse(await readFile(requestsFile, "utf8").catch((error) => { if (error.code === "ENOENT") return "[]"; throw error; })),
    register: (plan = PLAN) => client.callTool({ name: "register_intent_plan", arguments: plan, _meta: { sessionId: SESSION } })
  };
}

const message = (result) => result.content[0].text;

for (const retirement of ["session retirement", "local registration"]) {
  // regression: #0007
  test(`${retirement} prevents a backend replay of the retired plan in the same prompt`, async (t) => {
    const h = await setup(t, { replayByKey: true });
    await h.register();
    const first = await h.state();
    let previous = first;
    for (const epoch of [1, 2]) {
      if (retirement === "session retirement") {
        await withRuntimeState(h.config().runtimeFile, (state) => retireSessionPlan(state.sessions[SESSION]));
      } else {
        await recordBackendOutcome(h.config(), "signed_out");
        assert.equal(message(await h.register()), "Plan recorded locally, not registered (logged_out).");
        await recordBackendOutcome(h.config(), "ok");
      }
      const result = await h.register();
      assert.equal(result.isError ?? false, false, message(result));
      const current = await h.state();
      assert.notEqual(current.countedPlanId, previous.countedPlanId);
      assert.equal(current.promptId, first.promptId);
      assert.equal(current.retirementEpoch, epoch);
      assert.equal(current.kind, "new");
      const requests = await h.requests();
      assert.notEqual(requests.at(-1).headers[contract.headers.idempotencyKey], requests.at(-2).headers[contract.headers.idempotencyKey]);
      await h.register();
      assert.equal((await h.requests()).length, epoch + 1);
      previous = current;
    }
    await h.prompt("second prompt");
    await h.register();
    const current = await h.state();
    assert.notEqual(current.promptId, first.promptId);
    assert.equal(current.retirementEpoch, 0);
    const { idempotencyKey, planHash } = await requestModule();
    const request = (await h.requests()).at(-1);
    assert.equal(request.headers[contract.headers.idempotencyKey], idempotencyKey({ kind: "new", promptId: current.promptId, planHash: planHash(request.body.plan) }));
  });
}

test("new, identical and revised registrations persist the outbound descriptor before sending", async (t) => {
  const h = await setup(t);
  const first = await h.register();
  assert.equal(first.isError ?? false, false);
  assert.equal(message(first), `Intent registered: plan 11111111-1111-4111-8111-000000000001 (new), 1 steps. Token valid until ${new Date(EXPIRES * 1000).toISOString()}.`);
  const identical = await h.register();
  assert.equal(message(identical), message(first));
  assert.equal((await h.requests()).length, 1);
  const revision = await h.register({ ...PLAN, goal: "inspect more files" });
  assert.match(message(revision), /plan 11111111-1111-4111-8111-000000000002 \(revision\)/);
  const { planHash, idempotencyKey } = await requestModule();
  const requests = await h.requests();
  for (const [index, request] of requests.entries()) {
    const kind = index ? "revision" : "new";
    assert.equal(request.headers[contract.headers.kind], kind);
    assert.equal(request.headers[contract.headers.promptId], (await h.state()).promptId);
    assert.equal(request.headers[contract.headers.parentPlanId], index ? "11111111-1111-4111-8111-000000000001" : undefined);
    assert.deepEqual(request.descriptor.body, request.body);
    assert.equal(request.descriptor.key, request.headers[contract.headers.idempotencyKey]);
    assert.equal(request.descriptor.key, idempotencyKey({ kind, promptId: request.headers[contract.headers.promptId], parentPlanId: request.headers[contract.headers.parentPlanId], planHash: planHash(request.body.plan) }));
  }
  assert.equal((await h.state()).pendingRequest, null);
  await h.prompt("second prompt");
  await h.register();
  assert.equal((await h.requests())[2].headers[contract.headers.kind], "new");
});

test("an identical plan with an expired token sends a revision instead of returning success locally", async (t) => {
  const h = await setup(t);
  await h.register();
  await withRuntimeState(h.config().runtimeFile, (state) => { state.sessions[SESSION].tokenExpiresAt = new Date(0).toISOString(); });
  await h.register();
  assert.equal((await h.requests()).length, 2);
  assert.equal((await h.requests())[1].headers[contract.headers.kind], "revision");
});

test("retryable SDK failures resend the persisted body and contract headers with no SDK retries", async (t) => {
  const h = await setup(t, { replies: [{ network: true }, { status: 429, headers: { "retry-after": "0" } }, { status: 503, headers: { "retry-after": "0" } }, { status: 409, error: "request_in_progress", headers: { "retry-after": "0" } }, {}] });
  const result = await h.register();
  assert.equal(result.isError ?? false, false);
  const requests = await h.requests();
  assert.equal(requests.length, 5);
  for (const request of requests) assert.deepEqual(request, requests[0]);
});

for (const [failure, row, env] of [
  ["HTTP 422 idempotency_key_reused", { status: 422, error: "idempotency_key_reused" }],
  ["HTTP 409 conflict", { status: 409, error: "conflict" }],
  ["a local transport configuration error", { transportError: "ERR_BAD_OPTION_VALUE", clockAdvance: 40000 }],
  ["an invalid custom endpoint", { transportError: "ERR_INVALID_URL", clockAdvance: 40000 }, { ARMORCODEX_INTENT_URL: "https://contract.test/intent" }]
]) {
  test(`${failure} is a confirmed failure with no retry`, async (t) => {
    const h = await setup(t, { env, replies: [{ ...row, reason: "request refused" }] });
    const result = await h.register();
    assert.equal(result.isError, true);
    assert.equal(message(result), "Plan not registered: request refused.");
    assert.equal((await h.requests()).length, 1);
    assert.equal((await h.state()).pendingRequest, null);
    await h.register();
    assert.equal((await h.requests()).length, 2);
  });
}

for (const [condition, reason] of [["logged_out", "logged_out"], ["monitor_mode", "monitor_mode"], ["signed_out", "logged_out"], ["no_transport", "no_transport"]]) {
  // regression: #0007
  test(`${condition} records an explicit unregistered plan and sends nothing`, async (t) => {
    const h = await setup(t, { loggedOut: condition === "logged_out", env: { ARMORCODEX_MODE: reason === "monitor_mode" ? "monitor" : "enforce", ARMORCODEX_USE_SDK_INTENT: condition === "no_transport" ? "false" : "true", ARMORCODEX_INTENT_URL: condition === "no_transport" ? "" : "https://contract.test/intent" } });
    if (condition === "signed_out") await recordBackendOutcome(h.config(), "signed_out");
    const result = await h.register();
    assert.equal(message(result), `Plan recorded locally, not registered (${reason}).`);
    assert.equal(result.isError ?? false, false);
    assert.deepEqual(await h.requests(), []);
    const state = await h.state();
    assert.equal(state.unregisteredLocalPlan.reason, reason);
    assert.equal(state.countedPlanId, null);
    assert.equal(state.intentTokenRaw, "");
    assert.equal(state.pendingRequest, null);
    if (condition === "signed_out") {
      assert.equal(await handlePreToolUse({ session_id: SESSION, tool_name: "Bash", tool_input: {} }, h.config()), null);
    }
  });
}

for (const change of ["prompt", "auth"]) {
  test(`a late reply after ${change} changes is not installed`, async (t) => {
    const h = await setup(t, { replies: [{ defer: true }] });
    const registering = h.register();
    await h.tokenRequested;
    if (change === "prompt") await h.prompt("next prompt");
    else await rm(path.join(h.home, ".armoriq", "credentials.json"));
    await h.client.callTool({ name: "policy_read", arguments: {} });
    const result = await registering;
    assert.equal(result.isError, true);
    assert.match(message(result), /^Plan not registered: /);
    assert.equal((await h.state()).countedPlanId, null);
    assert.equal((await h.state()).intentTokenRaw, "");
  });
}

test("legacy replies keep working and warn once per process", async (t) => {
  const h = await setup(t, { replies: [{ legacy: true }] });
  assert.match(message(await h.register()), /Intent registered: plan .* \(new\)/);
  assert.match(message(await h.register({ ...PLAN, goal: "revise" })), /Intent registered: plan .* \(revision\)/);
  assert.equal((h.stderr().match(/backend.*without.*kind/gi) || []).length, 1);
});

test("custom endpoints receive the same contract headers and committed reply fields", async (t) => {
  const h = await setup(t, { env: { ARMORCODEX_INTENT_URL: "https://contract.test/intent" } });
  assert.match(message(await h.register()), /plan 11111111-1111-4111-8111-000000000001 \(new\)/);
  const [request] = await h.requests();
  assert.deepEqual(request.descriptor.body, request.body);
  assert.equal(request.headers[contract.headers.kind], "new");
});

for (const [failure, reply] of [
  ["a non JSON 5xx response", { status: 503, nonJson: "temporarily unavailable", headers: { "retry-after": "0" } }],
  ["an interrupted response body", { streamError: true }]
]) {
  test(`a custom endpoint retries ${failure} with the same descriptor`, async (t) => {
    const h = await setup(t, { env: { ARMORCODEX_INTENT_URL: "https://contract.test/intent" }, replies: [reply, {}] });
    const result = await h.register();
    assert.equal(result.isError ?? false, false, message(result));
    const requests = await h.requests();
    assert.equal(requests.length, 2);
    assert.deepEqual(requests[0], requests[1]);
  });
}

// regression: #0007
test("an unknown outcome retains the descriptor and reuses it on the next registration", async (t) => {
  const h = await setup(t, { replies: [{ status: 503, reason: "temporarily unavailable", clockAdvance: 40000 }, {}] });
  const first = await h.register();
  assert.equal(first.isError, true);
  assert.equal(message(first), "Plan registration not confirmed: temporarily unavailable. Register the same plan again to retry it with the same request id, or start a new prompt.");
  const pending = (await h.state()).pendingRequest;
  assert.ok(pending);
  const different = await h.register({ ...PLAN, goal: "a different plan" });
  assert.equal(different.isError, true);
  assert.match(message(different), /Register the same plan again to retry it, or start a new prompt/);
  assert.equal((await h.requests()).length, 1);
  await writeFile(h.config().policyFile, JSON.stringify({ version: 2, policy: { rules: [{ id: "changed", action: "deny", tool: "Write" }] } }));
  const second = await h.register();
  assert.equal(second.isError ?? false, false);
  const requests = await h.requests();
  assert.equal(requests.length, 2);
  assert.deepEqual(requests[1], requests[0]);
  assert.deepEqual(requests[1].descriptor, pending);
});

for (const condition of ["no prompt", "unreachable"]) {
  // regression: #0007
  test(`registration refuses ${condition} without sending a token request`, async (t) => {
    const h = await setup(t);
    if (condition === "no prompt") {
      await withRuntimeState(h.config().runtimeFile, (state) => { state.sessions[SESSION].promptId = null; });
    } else await recordBackendOutcome(h.config(), "unreachable");
    const result = await h.register();
    assert.equal(result.isError, true);
    assert.match(message(result), condition === "no prompt" ? /no current prompt id/ : /backend_unreachable/);
    assert.deepEqual(await h.requests(), []);
    assert.equal((await h.state()).pendingRequest, null);
  });
}

test("one logical deadline bounds attempts and honours both Retry-After forms", async () => {
  const { requestWithRetry } = await requestModule();
  for (const retryAfter of ["2", new Date(2000).toUTCString()]) {
    let now = 0;
    const timeouts = [];
    const waits = [];
    const result = await requestWithRetry(async (timeoutMs) => {
      timeouts.push(timeoutMs);
      if (timeouts.length === 1) throw Object.assign(new Error("pending"), { retryable: true, retryAfter });
      return "confirmed";
    }, { now: () => now, wait: async (ms) => { waits.push(ms); now += ms; }, timeoutMs: 30000 });
    assert.equal(result, "confirmed");
    assert.deepEqual(waits, [2000]);
    assert.deepEqual(timeouts, [30000, 30000]);
  }
  let now = 0;
  let attempts = 0;
  await assert.rejects(requestWithRetry(async (timeoutMs) => {
    attempts++;
    assert.equal(timeoutMs, 40000);
    throw Object.assign(new Error("pending"), { retryable: true, retryAfter: "60" });
  }, { now: () => now, wait: async (ms) => { now += ms; }, timeoutMs: 60000 }), (error) => error.unconfirmed === true);
  assert.equal(attempts, 1);
  assert.equal(now, 40000);
});

test("a hung attempt ends at the logical deadline", async (t) => {
  const { requestWithRetry } = await requestModule();
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
  const result = assert.rejects(requestWithRetry(() => new Promise(() => {}), { timeoutMs: 60000 }), (error) => error.unconfirmed === true);
  t.mock.timers.tick(40000);
  await result;
});

test("validity precedence and bounds reject invalid configuration by variable name", () => {
  for (const [env, expected] of [
    [{}, 3600], [{ ARMORCODEX_VALIDITY_SECONDS: "180" }, 180],
    [{ ARMORIQ_INTENT_VALIDITY_SECONDS: "3600", ARMORCODEX_VALIDITY_SECONDS: "180" }, 3600],
    [{ ARMORIQ_INTENT_VALIDITY_SECONDS: "180", ARMORCODEX_VALIDITY_SECONDS: "invalid" }, 180]
  ]) assert.equal(loadSettings(env).validitySeconds, expected);
  for (const variable of ["ARMORIQ_INTENT_VALIDITY_SECONDS", "ARMORCODEX_VALIDITY_SECONDS"]) {
    for (const value of ["", "179", "3601", "60seconds", "180.5", "NaN"]) {
      assert.throws(() => loadSettings({ [variable]: value }), new RegExp(variable));
    }
  }
});

test("invalid validity prevents the MCP process from starting", () => {
  const result = spawnSync(process.execPath, [SERVER], { env: { ARMORIQ_INTENT_VALIDITY_SECONDS: "179" }, encoding: "utf8", input: "" });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /ARMORIQ_INTENT_VALIDITY_SECONDS/);
});
