import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { loadConfig } from "../plugins/armorcodex/scripts/lib/config.mjs";
import { handlePreToolUse } from "../plugins/armorcodex/scripts/lib/engine.mjs";
import { withHome } from "./helpers/login.mjs";

const requirePlugin = createRequire(new URL("../plugins/armorcodex/package.json", import.meta.url));
const { Client } = requirePlugin("@modelcontextprotocol/sdk/client/index.js");
const { StdioClientTransport } = requirePlugin("@modelcontextprotocol/sdk/client/stdio.js");
const SERVER = fileURLToPath(new URL("../plugins/armorcodex/scripts/policy-mcp.mjs", import.meta.url));
const SANDBOX = fileURLToPath(new URL("./helpers/mcp-sandbox.mjs", import.meta.url));
const SESSION = "sess-sync";

function startIntentBackend(answer) {
  const requests = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", async () => {
      const payload = JSON.parse(body || "{}");
      requests.push(payload);
      const { status, delayMs } = answer(payload, requests.length);
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      res.writeHead(status, { "content-type": "application/json" });
      const token = JSON.stringify({ plan: payload.plan, expiresAt: Math.floor(Date.now() / 1000) + 600 });
      res.end(JSON.stringify(status === 200 ? { intentTokenRaw: token } : { message: "backend down" }));
    });
  });
  return new Promise((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve({ server, requests, url: `http://127.0.0.1:${server.address().port}/intent` }))
  );
}

async function withServer(answer, fn) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "armorcodex-sync-reg-"));
  const dataDir = path.join(home, "data");
  const backend = await startIntentBackend(answer);
  const env = { ARMORCODEX_DATA_DIR: dataDir, ARMORCODEX_INTENT_URL: backend.url, ARMORCODEX_MODE: "enforce" };
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["--import", SANDBOX, SERVER],
    env: { HOME: home, ARMORCODEX_TEST_HOME: home, TMPDIR: os.tmpdir(), ...env },
    stderr: "pipe"
  });
  const client = new Client({ name: "sync-registration-test", version: "0.0.0" });
  await client.connect(transport);
  const register = async (goal, action = "Bash") => {
    const result = await client.callTool({
      name: "register_intent_plan",
      arguments: { goal, steps: [{ action }] },
      _meta: { sessionId: SESSION }
    });
    return result.content[0].text;
  };
  const config = withHome(home, () => loadConfig(env));
  const preToolUse = (toolName = "Bash") =>
    handlePreToolUse(
      { hook_event_name: "PreToolUse", session_id: SESSION, tool_name: toolName, tool_input: { command: "ls" } },
      config
    );
  const pendingPath = path.join(dataDir, `pending-plan.${SESSION}.json`);
  const pending = () => (fs.existsSync(pendingPath) ? JSON.parse(fs.readFileSync(pendingPath, "utf8")) : null);
  try {
    await fn({ register, preToolUse, pending, backend, config });
  } finally {
    await client.close();
    backend.server.close();
    fs.rmSync(home, { recursive: true, force: true });
  }
}

test("register_intent_plan returns only after the token and never leaves a plan without its token", async () => {
  await withServer(() => ({ status: 200, delayMs: 2000 }), async ({ register, pending }) => {
    const seen = [];
    const watcher = setInterval(() => {
      const file = pending();
      if (file) seen.push(file.plan ? (file.tokenRaw ? "plan+token" : "plan-only") : file.status);
    }, 20);
    const started = Date.now();
    const reply = await register("list files");
    clearInterval(watcher);
    assert.ok(Date.now() - started >= 1900, `returned after ${Date.now() - started} ms`);
    assert.match(reply, /Intent registered: 1 steps\. ArmorIQ token issued\./);
    assert.ok(seen.includes("issuing"), JSON.stringify([...new Set(seen)]));
    assert.ok(!seen.includes("plan-only"), JSON.stringify([...new Set(seen)]));
    assert.ok(pending().tokenRaw);
  });
});

test("a PreToolUse fired while the token is issuing waits, then allows the planned tool", async () => {
  await withServer(() => ({ status: 200, delayMs: 2000 }), async ({ register, preToolUse, backend }) => {
    const registering = register("list files");
    await new Promise((resolve) => setTimeout(resolve, 300));
    const started = Date.now();
    const decision = await preToolUse();
    assert.equal(decision, null);
    assert.ok(Date.now() - started >= 1000, `hook waited ${Date.now() - started} ms`);
    await registering;
    assert.equal(backend.requests.length, 1);
  });
});

test("when issuance fails, nothing is stored and PreToolUse denies without asking for a token", async () => {
  await withServer(() => ({ status: 500, delayMs: 0 }), async ({ register, preToolUse, pending, backend }) => {
    assert.match(await register("list files"), /Plan rejected: the ArmorIQ token request failed/);
    assert.equal(pending(), null);
    const decision = await preToolUse();
    assert.equal(decision?.hookSpecificOutput?.permissionDecision, "deny");
    assert.equal(backend.requests.length, 1);
  });
});

test("two registrations in one session end with the newer plan on disk", async () => {
  const delays = [1500, 100];
  await withServer((_, n) => ({ status: 200, delayMs: delays[n - 1] ?? 0 }), async ({ register, pending }) => {
    const [first, second] = await Promise.all([register("first", "Read"), register("second", "Bash")]);
    assert.match(first, /ArmorIQ token issued/);
    assert.match(second, /ArmorIQ token issued/);
    assert.deepEqual(pending().plan.steps.map((step) => step.action), ["Bash"]);
  });
});

test("PreToolUse never asks the backend for a token, even close to expiry", async () => {
  await withServer(() => ({ status: 200, delayMs: 0 }), async ({ register, preToolUse, backend, config }) => {
    await register("list files");
    await preToolUse();
    const runtime = JSON.parse(fs.readFileSync(config.runtimeFile, "utf8"));
    runtime.sessions[SESSION].expiresAt = Math.floor(Date.now() / 1000) + 5;
    fs.writeFileSync(config.runtimeFile, JSON.stringify(runtime));
    await preToolUse();
    assert.equal(backend.requests.length, 1);
  });
});

test("a PreToolUse that outwaits the issuing deadline denies and asks for a new registration", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "armorcodex-sync-deadline-"));
  try {
    const config = withHome(dataDir, () => loadConfig({ ARMORCODEX_DATA_DIR: dataDir, ARMORCODEX_MODE: "enforce" }));
    fs.writeFileSync(
      path.join(dataDir, `pending-plan.${SESSION}.json`),
      JSON.stringify({ status: "issuing", startedAt: Date.now(), deadlineAt: Date.now() + 300 })
    );
    const started = Date.now();
    const decision = await handlePreToolUse(
      { hook_event_name: "PreToolUse", session_id: SESSION, tool_name: "Bash", tool_input: {} },
      config
    );
    assert.ok(Date.now() - started >= 250, `waited ${Date.now() - started} ms`);
    assert.equal(decision?.hookSpecificOutput?.permissionDecision, "deny");
    assert.match(decision.hookSpecificOutput.permissionDecisionReason, /not issued in time: call register_intent_plan again/);
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});
