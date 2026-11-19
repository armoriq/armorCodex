import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { handleArmorPolicyCommand } from "../plugins/armorcodex/scripts/lib/armor-policy-commands.mjs";
import { loadConfig } from "../plugins/armorcodex/scripts/lib/config.mjs";
import { recordBackendOutcome } from "../plugins/armorcodex/scripts/lib/backend-posture.mjs";
import { handlePreToolUse } from "../plugins/armorcodex/scripts/lib/engine.mjs";
import { withHome } from "./helpers/login.mjs";

async function hookConfig(env = {}) {
  const home = await mkdtemp(path.join(os.tmpdir(), "armorcodex-mcpgate-"));
  const dataDir = path.join(home, "data");
  fs.mkdirSync(dataDir, { recursive: true });
  const config = withHome(home, () =>
    loadConfig({ ARMORCODEX_DATA_DIR: dataDir, ARMORCODEX_MODE: "enforce", ARMORCODEX_INTENT_REQUIRED: "false", ...env })
  );
  return { ...config, apiKey: "", useSdkIntent: false, intentEndpoint: "", verifyStepEndpoint: "" };
}

const preToolUse = (config, toolName) =>
  handlePreToolUse({ hook_event_name: "PreToolUse", session_id: "sess-mcp", tool_name: toolName, tool_input: {} }, config);

test("a tool from an MCP server the user never approved is denied by default", async () => {
  const config = await hookConfig();
  assert.equal(config.mcpDenyByDefault, true);
  const decision = await preToolUse(config, "mcp__echo__echo");
  assert.equal(decision?.hookSpecificOutput?.permissionDecision, "deny");
  assert.match(decision.hookSpecificOutput.permissionDecisionReason, /MCP server "echo" is not approved.*armor mcp approve echo/);
  assert.equal(await preToolUse(config, "mcp__armorcodex-policy__register_intent_plan"), null);
  assert.equal(await preToolUse(config, "mcp__armorcodex_policy__policy_command"), null);
});

test("an MCP server approved through armor mcp approve is allowed, a catch-all allow is not approval", async () => {
  const config = await hookConfig();
  await writeFile(
    config.policyFile,
    JSON.stringify({ version: 1, policy: { rules: [{ id: "all", action: "allow", tool: "*" }] }, history: [] })
  );
  assert.equal((await preToolUse(config, "mcp__echo__echo"))?.hookSpecificOutput?.permissionDecision, "deny");
  await handleArmorPolicyCommand("/armor mcp approve echo", config, "sess-user");
  await handleArmorPolicyCommand("/armor yes", config, "sess-user");
  assert.equal(await preToolUse(config, "mcp__echo__echo"), null);
  assert.equal((await preToolUse(config, "mcp__other__run"))?.hookSpecificOutput?.permissionDecision, "deny");
});

test("an allow rule limited by parameters does not approve the whole server", async () => {
  const config = await hookConfig();
  const rules = [{ id: "gh-safe", action: "allow", tool: "mcp__gh__create_issue", params: { repo: "safe" } }];
  await writeFile(config.policyFile, JSON.stringify({ version: 1, policy: { rules }, history: [] }));
  assert.equal((await preToolUse(config, "mcp__gh__create_issue"))?.hookSpecificOutput?.permissionDecision, "deny");
});

const resourceCall = (config, toolName, toolInput) =>
  handlePreToolUse({ hook_event_name: "PreToolUse", session_id: "sess-mcp", tool_name: toolName, tool_input: toolInput }, config);

test("an unapproved MCP server's resources can be neither listed nor read, an approved server's can", async () => {
  const config = await hookConfig();
  const denied = async (toolName, toolInput) =>
    (await resourceCall(config, toolName, toolInput))?.hookSpecificOutput?.permissionDecisionReason ?? "";
  assert.match(await denied("read_mcp_resource", { server: "probe", uri: "probe://notes/secret" }), /MCP server "probe" is not approved/);
  assert.match(await denied("list_mcp_resources", { server: "probe" }), /MCP server "probe" is not approved/);
  assert.match(await denied("list_mcp_resource_templates", { server: "probe" }), /MCP server "probe" is not approved/);
  assert.match(await denied("list_mcp_resources", {}), /across every server is blocked/);

  await handleArmorPolicyCommand("/armor mcp approve probe", config, "sess-user");
  await handleArmorPolicyCommand("/armor yes", config, "sess-user");
  assert.equal(await resourceCall(config, "read_mcp_resource", { server: "probe", uri: "probe://notes/secret" }), null);
  assert.equal(await resourceCall(config, "list_mcp_resources", { server: "probe" }), null);
  assert.match(await denied("read_mcp_resource", { server: "other", uri: "other://x" }), /MCP server "other" is not approved/);
});

test("approving one tool of a server does not open its resources", async () => {
  const config = await hookConfig();
  const rules = [{ id: "probe-echo", action: "allow", tool: "mcp__probe__echo" }];
  await writeFile(config.policyFile, JSON.stringify({ version: 1, policy: { rules }, history: [] }));
  assert.equal(await preToolUse(config, "mcp__probe__echo"), null);
  const decision = await resourceCall(config, "read_mcp_resource", { server: "probe", uri: "probe://notes/secret" });
  assert.equal(decision?.hookSpecificOutput?.permissionDecision, "deny");
});

test("ARMORCODEX_MCP_DENY_BY_DEFAULT=false turns the MCP gate off", async () => {
  const config = await hookConfig({ ARMORCODEX_MCP_DENY_BY_DEFAULT: "false" });
  assert.equal(await preToolUse(config, "mcp__echo__echo"), null);
  assert.equal(await resourceCall(config, "read_mcp_resource", { server: "probe", uri: "probe://notes/secret" }), null);
});

test("a blocked audit row redacts secrets in the backend's deny reason", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "armorcodex-redact-"));
  const config = {
    mode: "enforce",
    dataDir,
    policyFile: path.join(dataDir, "policy.json"),
    runtimeFile: path.join(dataDir, "runtime.json"),
    apiKey: "ak_test_redact00000000000000000000000",
    backendEndpoint: "https://audit.invalid",
    userId: "user-login",
    auditEnabled: true,
    intentRequired: true,
    agentId: "codex",
    sanitize: { maxChars: 2000, maxDepth: 4, maxKeys: 50, maxItems: 50 }
  };
  const planCheck = { deniedTools: ["Bash"], deniedReasons: ["Bash: rejected, token=sk_live_0123456789abcdef"] };
  await writeFile(config.runtimeFile, JSON.stringify({ sessions: { "sess-mcp": { planCheck } } }));
  await recordBackendOutcome(config, "ok");
  const decision = await preToolUse(config, "Bash");
  assert.equal(decision?.hookSpecificOutput?.permissionDecision, "deny");
  const rows = (await readFile(path.join(dataDir, "audit", "current.jsonl"), "utf8"))
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  assert.equal(rows.length, 1);
  assert.match(rows[0].error_message, /token=<redacted>/);
  assert.doesNotMatch(rows[0].error_message, /sk_live_0123456789abcdef/);
});
