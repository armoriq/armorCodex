import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { signIn } from "./helpers/login.mjs";
import { toolCapability } from "../plugins/armorcodex/scripts/lib/backend-posture.mjs";

const HOOK_ROUTER = fileURLToPath(new URL("../plugins/armorcodex/scripts/hook-router.mjs", import.meta.url));
const SERVER = fileURLToPath(new URL("../plugins/armorcodex/scripts/policy-mcp.mjs", import.meta.url));
const SANDBOX = fileURLToPath(new URL("./helpers/mcp-sandbox.mjs", import.meta.url));
const KEY = "ak_test_unreachable00000000000000000";

function startBackend(behavior) {
  const state = { behavior, probes: 0, batches: [] };
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      if (req.url === "/iap/validate-key") state.probes += 1;
      if (state.behavior === "hang") return;
      if (state.behavior === "503") return res.writeHead(503).end("down");
      if (state.behavior === "401") return res.writeHead(401).end("bad key");
      if (req.url === "/iap/audit/batch") state.batches.push(JSON.parse(body).rows);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(req.url === "/iap/validate-key" ? { userId: "user-login" } : { written: 1, failures: [] }));
    });
  });
  return new Promise((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve({ server, state, url: `http://127.0.0.1:${server.address().port}` }))
  );
}

async function setup(t, behavior) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "armorcodex-unreachable-"));
  const dataDir = path.join(home, "data");
  const backend = await startBackend(behavior);
  t.after(() => {
    backend.server.closeAllConnections();
    backend.server.close();
    fs.rmSync(home, { recursive: true, force: true });
  });
  signIn(home, { backend: backend.url, apiKey: KEY });
  const env = {
    PATH: process.env.PATH,
    HOME: home,
    ARMORCODEX_TEST_HOME: home,
    TMPDIR: os.tmpdir(),
    ARMORCODEX_DATA_DIR: dataDir,
    BACKEND_ENDPOINT: backend.url,
    IAP_ENDPOINT: backend.url,
    PROXY_ENDPOINT: backend.url
  };
  return { home, dataDir, backend, env };
}

async function hook(env, payload) {
  const child = spawn(process.execPath, [HOOK_ROUTER], { env });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (c) => (stdout += c));
  child.stderr.on("data", (c) => (stderr += c));
  const started = Date.now();
  child.stdin.end(JSON.stringify({ session_id: "s-down", ...payload }));
  const code = await new Promise((resolve) => child.once("close", resolve));
  assert.equal(code, 0, stderr);
  return { decision: stdout.trim() ? JSON.parse(stdout) : null, elapsed: Date.now() - started, stderr };
}

const preTool = (env, tool_name, tool_input = {}) => hook(env, { hook_event_name: "PreToolUse", tool_name, tool_input });

function walRows(dataDir) {
  const file = path.join(dataDir, "audit", "current.jsonl");
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

const posture = (dataDir) => JSON.parse(fs.readFileSync(path.join(dataDir, "backend-posture.json"), "utf8"));

function assertUnreachableDeny({ decision }) {
  assert.equal(decision?.hookSpecificOutput?.permissionDecision, "deny");
  assert.match(decision.hookSpecificOutput.permissionDecisionReason, /backend_unreachable/);
  assert.match(decision.hookSpecificOutput.permissionDecisionReason, /\/armor status/);
}

test("tools map to the spec's capabilities", () => {
  assert.equal(toolCapability("Bash"), "shell");
  assert.equal(toolCapability("apply_patch"), "write");
  assert.equal(toolCapability("mcp__github__get_issue"), "mcp");
  assert.equal(toolCapability("WebFetch"), "web");
  assert.equal(toolCapability("Read"), "read");
  assert.equal(toolCapability("update_plan"), "other");
});

test("a backend that does not answer within 2 seconds blocks Bash, then apply_patch from the cached verdict", async (t) => {
  const { env, dataDir, backend } = await setup(t, "hang");
  const bash = await preTool(env, "Bash", { command: "ls" });
  assertUnreachableDeny(bash);
  assert.ok(bash.elapsed >= 2000 && bash.elapsed < 5000, `elapsed ${bash.elapsed}`);
  assert.equal(posture(dataDir).state, "unreachable");

  const patch = await preTool(env, "apply_patch", { input: "*** Begin Patch\n*** End Patch" });
  assertUnreachableDeny(patch);
  assert.ok(patch.elapsed < 1500, `the second hook process reuses the verdict, elapsed ${patch.elapsed}`);
  assert.equal(backend.state.probes, 1);

  const rows = walRows(dataDir);
  assert.deepEqual(
    rows.map((row) => [row.tool, row.capability, row.status, row.error_message]),
    [
      ["Bash", "shell", "blocked", "backend_unreachable"],
      ["apply_patch", "write", "blocked", "backend_unreachable"]
    ]
  );
});

test("a 5xx blocks every MCP tool, read-only ones included", async (t) => {
  const { env, dataDir } = await setup(t, "503");
  assertUnreachableDeny(await preTool(env, "mcp__github__get_issue", { number: 1 }));
  const [row] = walRows(dataDir);
  assert.equal(row.capability, "mcp");
  assert.equal(row.error_message, "backend_unreachable");
});

test("the verdict expires after 30 seconds and the next hook probes again", async (t) => {
  const { env, dataDir, backend } = await setup(t, "503");
  await preTool(env, "Bash", { command: "ls" });
  backend.state.behavior = "ok";
  const file = path.join(dataDir, "backend-posture.json");
  const saved = posture(dataDir);
  assert.ok(saved.until - saved.at === 30_000);
  fs.writeFileSync(file, JSON.stringify({ ...saved, until: Date.now() - 1 }));
  const { decision } = await preTool(env, "Bash", { command: "ls" });
  assert.doesNotMatch(decision?.hookSpecificOutput?.permissionDecisionReason ?? "", /backend_unreachable/);
  assert.equal(posture(dataDir).state, "ok");
  assert.equal(backend.state.probes, 2);
});

test("a 401 switches to local only mode instead of blocking as unreachable", async (t) => {
  const { env, dataDir, backend } = await setup(t, "401");
  const first = await preTool(env, "Bash", { command: "ls" });
  assert.doesNotMatch(first.decision?.hookSpecificOutput?.permissionDecisionReason ?? "", /backend_unreachable/);
  assert.equal(posture(dataDir).state, "signed_out");
  await hook(env, { hook_event_name: "PostToolUse", tool_name: "Bash", tool_input: { command: "ls" }, tool_response: {} });
  assert.deepEqual(walRows(dataDir), [], "local only mode sends and queues nothing");
  assert.equal(backend.state.probes, 1);
});

test("rows blocked while unreachable stay queued, then upload once the backend is back", async (t) => {
  const { env, dataDir, backend } = await setup(t, "503");
  assertUnreachableDeny(await preTool(env, "Bash", { command: "ls" }));
  const child = spawn(process.execPath, ["--import", SANDBOX, SERVER], { env, stdio: ["pipe", "pipe", "pipe"] });
  let stderr = "";
  child.stderr.on("data", (c) => (stderr += c));
  const exited = new Promise((resolve) => child.on("exit", resolve));
  t.after(() => child.kill("SIGKILL"));

  await new Promise((resolve) => setTimeout(resolve, 5600));
  assert.deepEqual(backend.state.batches, [], "nothing ships during the 30 second verdict");

  backend.state.behavior = "ok";
  const file = path.join(dataDir, "backend-posture.json");
  fs.writeFileSync(file, JSON.stringify({ ...posture(dataDir), until: Date.now() - 1 }));
  await new Promise((resolve) => setTimeout(resolve, 5600));
  child.stdin.end();
  await exited;

  const shipped = backend.state.batches.flat();
  assert.equal(shipped.length, 1, stderr);
  assert.equal(shipped[0].capability, "shell");
  assert.equal(shipped[0].status, "blocked");
  assert.equal(shipped[0].error_message, "backend_unreachable");
});

test("a slow call that finishes late does not replace a newer verdict", async (t) => {
  const { recordBackendOutcome, cachedPosture } = await import("../plugins/armorcodex/scripts/lib/backend-posture.mjs");
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "armorcodex-posture-race-"));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const config = { dataDir, apiKey: KEY, backendEndpoint: "https://backend.example" };
  const now = Date.now();
  await recordBackendOutcome(config, "ok", now);
  await recordBackendOutcome(config, "unreachable", now - 2000);
  assert.equal((await cachedPosture(config)).state, "ok");
  await recordBackendOutcome(config, "unreachable", now + 1);
  assert.equal((await cachedPosture(config)).state, "unreachable");
});
