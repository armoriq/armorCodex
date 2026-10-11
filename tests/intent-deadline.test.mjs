import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";
import { signIn } from "./helpers/login.mjs";

const requirePlugin = createRequire(new URL("../plugins/armorcodex/package.json", import.meta.url));
const { Client } = requirePlugin("@modelcontextprotocol/sdk/client/index.js");
const { StdioClientTransport } = requirePlugin("@modelcontextprotocol/sdk/client/stdio.js");
const POLICY_MCP = fileURLToPath(new URL("../plugins/armorcodex/scripts/policy-mcp.mjs", import.meta.url));
const HOOK_ROUTER = fileURLToPath(new URL("../plugins/armorcodex/scripts/hook-router.mjs", import.meta.url));
const SESSION = "deadline-session";

async function startSlowBackend(delayMs, status) {
  const tokenRequests = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", async () => {
      if (req.method !== "POST" || req.url !== "/iap/sdk/token") {
        res.writeHead(404).end();
        return;
      }
      tokenRequests.push(JSON.parse(body));
      await sleep(delayMs);
      res.writeHead(status, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          success: true,
          plan_hash: "plan-hash-from-backend",
          intent_reference: "intent-ref-from-backend",
          token: { signature: "sig", expires_at: Math.floor(Date.now() / 1000) + 3600 },
          step_proofs: []
        })
      );
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  return { url, tokenRequests, close: () => new Promise((resolve) => server.close(resolve)) };
}

async function withMcp({ delayMs, deadlineMs, status = 200 }, fn) {
  const backend = await startSlowBackend(delayMs, status);
  const home = await mkdtemp(path.join(os.tmpdir(), "armorcodex-deadline-"));
  const dataDir = path.join(home, "data");
  signIn(home, { backend: backend.url, apiKey: "ak_test_deadline" });
  const env = {
    PATH: process.env.PATH,
    HOME: home,
    TMPDIR: os.tmpdir(),
    ARMORCODEX_DATA_DIR: dataDir,
    ARMORCODEX_MODE: "enforce",
    ARMORCODEX_BACKEND_ENDPOINT: backend.url,
    ARMORCODEX_IAP_ENDPOINT: backend.url,
    ARMORCODEX_PROXY_ENDPOINT: backend.url,
    ARMORCODEX_CSRG_ENDPOINT: backend.url,
    ARMORCODEX_MAX_RETRIES: "0"
  };
  if (deadlineMs !== undefined) env.ARMORCODEX_INTENT_DEADLINE_MS = String(deadlineMs);
  const transport = new StdioClientTransport({ command: process.execPath, args: [POLICY_MCP], env, stderr: "pipe" });
  let stderr = "";
  transport.stderr?.on("data", (chunk) => (stderr += chunk));
  const client = new Client({ name: "deadline-test", version: "0.0.0" });
  await client.connect(transport);
  const pendingPath = path.join(dataDir, `pending-plan.${SESSION}.json`);
  const readPendingPlan = async () => JSON.parse(await readFile(pendingPath, "utf8"));
  const registerPlan = async () => {
    const startedAt = Date.now();
    const result = await client.callTool({
      name: "register_intent_plan",
      arguments: { goal: "list files", steps: [{ action: "Bash", description: "ls" }] },
      _meta: { sessionId: SESSION }
    });
    const elapsedMs = Date.now() - startedAt;
    return { elapsedMs, text: result.content[0].text, pendingPlan: await readPendingPlan() };
  };
  try {
    await fn({ registerPlan, readPendingPlan, backend, env, stderr: () => stderr });
  } finally {
    await client.close();
    await backend.close();
    await rm(home, { recursive: true, force: true });
  }
}

function preToolUse(env, toolName, toolInput) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [HOOK_ROUTER], { env, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.on("error", reject);
    child.on("close", () => resolve(stdout.trim() ? JSON.parse(stdout) : null));
    child.stdin.end(
      JSON.stringify({
        hook_event_name: "PreToolUse",
        session_id: SESSION,
        cwd: env.HOME,
        tool_name: toolName,
        tool_input: toolInput
      })
    );
  });
}

test("backend token that arrives inside the deadline is in the pending plan before the tool returns", async () => {
  await withMcp({ delayMs: 50, deadlineMs: 500 }, async ({ registerPlan, backend, stderr }) => {
    const result = await registerPlan();
    assert.equal(backend.tokenRequests.length, 1, stderr());
    assert.match(result.text, /ArmorIQ token issued\./);
    assert.ok(result.pendingPlan.tokenRaw.includes("intent-ref-from-backend"), stderr());
    assert.ok(result.elapsedMs < 500, `took ${result.elapsedMs}ms`);
  });
});

test("backend slower than the deadline: tool returns at the deadline with the local plan, token lands later", async () => {
  await withMcp({ delayMs: 1500, deadlineMs: 500 }, async ({ registerPlan, readPendingPlan, backend, stderr }) => {
    const result = await registerPlan();
    assert.equal(backend.tokenRequests.length, 1, stderr());
    assert.match(result.text, /issuing in background/);
    assert.equal(result.pendingPlan.tokenRaw, "");
    assert.deepEqual(result.pendingPlan.allowedActions, ["bash"]);
    assert.ok(result.elapsedMs >= 500 && result.elapsedMs < 1000, `took ${result.elapsedMs}ms`);

    const deadline = Date.now() + 3000;
    let pendingPlan = await readPendingPlan();
    while (!pendingPlan.tokenRaw && Date.now() < deadline) {
      await sleep(50);
      pendingPlan = await readPendingPlan();
    }
    assert.ok(pendingPlan.tokenRaw.includes("intent-ref-from-backend"), stderr());
  });
});

test("backend error inside the deadline is reported instead of claiming the token is still coming", async () => {
  await withMcp({ delayMs: 20, deadlineMs: 500, status: 500 }, async ({ registerPlan, backend, stderr }) => {
    const result = await registerPlan();
    assert.equal(backend.tokenRequests.length, 1, stderr());
    assert.match(result.text, /ArmorIQ token request failed\./);
    assert.equal(result.pendingPlan.tokenRaw, "");
    assert.deepEqual(result.pendingPlan.allowedActions, ["bash"]);
  });
});

test("deadline defaults to 500ms when ARMORCODEX_INTENT_DEADLINE_MS is unset", async () => {
  await withMcp({ delayMs: 1500 }, async ({ registerPlan }) => {
    const result = await registerPlan();
    assert.match(result.text, /issuing in background/);
    assert.ok(result.elapsedMs >= 500 && result.elapsedMs < 1000, `took ${result.elapsedMs}ms`);
  });
});

test("ARMORCODEX_INTENT_DEADLINE_MS=0 returns without waiting for the backend", async () => {
  await withMcp({ delayMs: 1500, deadlineMs: 0 }, async ({ registerPlan }) => {
    const result = await registerPlan();
    assert.match(result.text, /issuing in background/);
    assert.ok(result.elapsedMs < 300, `took ${result.elapsedMs}ms`);
  });
});

test("an on-plan call while the backend is failing is denied, not allowed without a token", async () => {
  await withMcp({ delayMs: 20, deadlineMs: 500, status: 500 }, async ({ registerPlan, backend, env, stderr }) => {
    await registerPlan();

    const output = await preToolUse(env, "Bash", { command: "ls" });

    assert.equal(output?.hookSpecificOutput?.permissionDecision, "deny", JSON.stringify(output));
    assert.match(output.hookSpecificOutput.permissionDecisionReason, /intent planning failed/);
    assert.equal(backend.tokenRequests.length, 2, stderr());
  });
});

test("an off-plan call while the plan token is pending is denied, and its token request carries the registered plan", async () => {
  await withMcp({ delayMs: 1500, deadlineMs: 300 }, async ({ registerPlan, backend, env, stderr }) => {
    await registerPlan();

    const output = await preToolUse(env, "apply_patch", { patch: "*** Begin Patch" });

    assert.equal(output?.hookSpecificOutput?.permissionDecision, "deny", JSON.stringify(output));
    assert.match(output.hookSpecificOutput.permissionDecisionReason, /tool not in plan \(apply_patch\)/);
    assert.equal(backend.tokenRequests.length, 2, stderr());
    assert.deepEqual(backend.tokenRequests[1].plan.steps.map((step) => step.action), ["Bash"]);
  });
});
