import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { loadConfig } from "../plugins/armorcodex/scripts/lib/config.mjs";
import { getSdkClient } from "../plugins/armorcodex/scripts/lib/intent.mjs";
import { signIn, withHome } from "./helpers/login.mjs";

const requirePlugin = createRequire(new URL("../plugins/armorcodex/package.json", import.meta.url));
const build = requirePlugin("@armoriq/sdk/dist/_build_env.js");
const { Client } = requirePlugin("@modelcontextprotocol/sdk/client/index.js");
const { StdioClientTransport } = requirePlugin("@modelcontextprotocol/sdk/client/stdio.js");
const DEFAULT_BACKEND = build.ENDPOINTS[build.ARMORIQ_ENV].backend;
const KEY = "ak_test_configonce000000000000000";
const SERVER = fileURLToPath(new URL("../plugins/armorcodex/scripts/policy-mcp.mjs", import.meta.url));
const SANDBOX = fileURLToPath(new URL("./helpers/mcp-sandbox.mjs", import.meta.url));

function tempHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "armorcodex-config-once-"));
}

test("building the SDK client leaves ARMORIQ_ENV and the saved login in place", () => {
  const before = process.env.ARMORIQ_ENV;
  delete process.env.ARMORIQ_ENV;
  const home = signIn(tempHome(), { backend: DEFAULT_BACKEND, apiKey: KEY });
  try {
    withHome(home, () => {
      const first = loadConfig(process.env);
      assert.equal(first.apiKey, KEY);
      getSdkClient(first);
      assert.equal(process.env.ARMORIQ_ENV, undefined);
      const second = loadConfig(process.env);
      assert.equal(second.backendEndpoint, DEFAULT_BACKEND);
      assert.equal(second.apiKey, KEY);
    });
  } finally {
    if (before === undefined) delete process.env.ARMORIQ_ENV;
    else process.env.ARMORIQ_ENV = before;
    fs.rmSync(home, { recursive: true, force: true });
  }
});

async function waitFor(check, ms = 5000) {
  const until = Date.now() + ms;
  while (!check() && Date.now() < until) await new Promise((r) => setTimeout(r, 25));
}

async function startServer(home) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["--import", SANDBOX, SERVER],
    env: {
      HOME: home,
      ARMORCODEX_TEST_HOME: home,
      TMPDIR: os.tmpdir(),
      ARMORCODEX_DATA_DIR: path.join(home, "data")
    },
    stderr: "pipe"
  });
  const client = new Client({ name: "config-once-test", version: "0.0.0" });
  let stderr = "";
  transport.stderr.on("data", (chunk) => (stderr += chunk));
  await client.connect(transport).catch((error) => assert.fail(`${error.message}\n${stderr}`));
  const register = async (goal, sessionId = "config-once") => {
    const result = await client.callTool({
      name: "register_intent_plan",
      arguments: { goal, steps: [{ action: "Bash" }] },
      _meta: { sessionId }
    });
    return `${result.content[0].text}\n${stderr}`;
  };
  return { client, register };
}

function tokenRequests(home) {
  const file = path.join(home, "requests.jsonl");
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, "utf8").trim().split("\n").map((line) => JSON.parse(line))
    .filter((request) => request.url === `${DEFAULT_BACKEND}/iap/sdk/token`);
}

test("the MCP server requests a token for every registration in one process", async () => {
  const home = signIn(tempHome(), { backend: DEFAULT_BACKEND, apiKey: KEY });
  const { client, register } = await startServer(home);
  try {
    for (const goal of ["first-goal", "second-goal"]) {
      assert.match(await register(goal), /the ArmorIQ token request failed/, goal);
    }
    await waitFor(() => tokenRequests(home).length >= 2);
    const goals = tokenRequests(home).map((request) => (request.body.includes("second-goal") ? "second" : "first"));
    assert.deepEqual(goals.sort(), ["first", "second"]);
  } finally {
    await client.close();
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("the MCP server picks up a login made after it started", async () => {
  const home = tempHome();
  const { client, register } = await startServer(home);
  try {
    assert.match(await register("before-login"), /no ArmorIQ backend configured/);
    signIn(home, { backend: DEFAULT_BACKEND, apiKey: KEY });
    assert.match(await register("after-login"), /the ArmorIQ token request failed/);
  } finally {
    await client.close();
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("the token request carries the Codex session id as the plan's context id", async () => {
  const home = signIn(tempHome(), { backend: DEFAULT_BACKEND, apiKey: KEY });
  const { client, register } = await startServer(home);
  try {
    const sessionId = "019a2c1e-5b7d-7c11-9e3f-0a1b2c3d4e5f";
    assert.match(await register("context-goal", sessionId), /the ArmorIQ token request failed/);
    await waitFor(() => tokenRequests(home).length >= 1);
    assert.equal(JSON.parse(tokenRequests(home)[0].body).context_id, sessionId);
  } finally {
    await client.close();
    fs.rmSync(home, { recursive: true, force: true });
  }
});
