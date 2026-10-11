import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
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

async function withServer(fn) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "armorcodex-plan-session-"));
  const dataDir = path.join(home, "data");
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["--import", SANDBOX, SERVER],
    env: { HOME: home, ARMORCODEX_TEST_HOME: home, TMPDIR: os.tmpdir(), ARMORCODEX_DATA_DIR: dataDir },
    stderr: "pipe"
  });
  const client = new Client({ name: "plan-session-test", version: "0.0.0" });
  await client.connect(transport);
  const register = async (meta) => {
    const result = await client.callTool({
      name: "register_intent_plan",
      arguments: { goal: "list files", steps: [{ action: "Bash" }] },
      ...(meta ? { _meta: meta } : {})
    });
    return result.content[0].text;
  };
  const config = withHome(home, () => loadConfig({ ARMORCODEX_DATA_DIR: dataDir, ARMORCODEX_MODE: "enforce" }));
  const preToolUse = (sessionId) =>
    handlePreToolUse(
      { hook_event_name: "PreToolUse", session_id: sessionId, tool_name: "Bash", tool_input: { command: "ls" } },
      config
    );
  try {
    await fn({ register, preToolUse, dataDir });
  } finally {
    await client.close();
    fs.rmSync(home, { recursive: true, force: true });
  }
}

test("a plan registered in one Codex session is enforced only in that session", async () => {
  await withServer(async ({ register, preToolUse }) => {
    assert.match(await register({ sessionId: "sess-A", threadId: "sess-A" }), /Intent registered/);
    const other = await preToolUse("sess-B");
    assert.equal(other?.hookSpecificOutput?.permissionDecision, "deny");
    assert.match(other.hookSpecificOutput.permissionDecisionReason, /intent plan missing/);
    assert.equal(await preToolUse("sess-A"), null);
  });
});

test("a registration without Codex's session id is rejected and stores nothing", async () => {
  await withServer(async ({ register, dataDir }) => {
    assert.match(await register(null), /Plan rejected: .*session id/);
    const files = fs.existsSync(dataDir) ? fs.readdirSync(dataDir) : [];
    assert.deepEqual(files.filter((name) => name.startsWith("pending-plan")), []);
  });
});
