import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { handleArmorPolicyCommand } from "../plugins/armorcodex/scripts/lib/armor-policy-commands.mjs";
import { loadPolicyState } from "../plugins/armorcodex/scripts/lib/policy.mjs";

const requirePlugin = createRequire(new URL("../plugins/armorcodex/package.json", import.meta.url));
const { Client } = requirePlugin("@modelcontextprotocol/sdk/client/index.js");
const { StdioClientTransport } = requirePlugin("@modelcontextprotocol/sdk/client/stdio.js");
const SERVER = fileURLToPath(new URL("../plugins/armorcodex/scripts/policy-mcp.mjs", import.meta.url));
const SANDBOX = fileURLToPath(new URL("./helpers/mcp-sandbox.mjs", import.meta.url));

const DENY_RULES = [
  { id: "no-bash", action: "deny", tool: "Bash" },
  { id: "no-patch", action: "deny", tool: "apply_patch" }
];

async function withPolicyServer(fn) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "armorcodex-authority-"));
  const dataDir = path.join(home, "data");
  fs.mkdirSync(dataDir, { recursive: true });
  const policyFile = path.join(dataDir, "policy.json");
  await writeFile(policyFile, JSON.stringify({ version: 3, policy: { rules: DENY_RULES }, history: [] }));
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["--import", SANDBOX, SERVER],
    env: { HOME: home, ARMORCODEX_TEST_HOME: home, TMPDIR: os.tmpdir(), ARMORCODEX_DATA_DIR: dataDir },
    stderr: "pipe"
  });
  const client = new Client({ name: "authority-test", version: "0.0.0" });
  await client.connect(transport);
  const call = async (name, args) => (await client.callTool({ name, arguments: args })).content[0].text;
  try {
    await fn({ call, config: { dataDir, policyFile } });
  } finally {
    await client.close();
    fs.rmSync(home, { recursive: true, force: true });
  }
}

test("policy_update from the agent stages a replace instead of wiping the deny rules", async () => {
  await withPolicyServer(async ({ call, config }) => {
    const reply = await call("policy_update", { update: { reason: "cleanup", mode: "replace", rules: [] } });
    assert.match(reply, /Proposed policy change/);
    const state = await loadPolicyState(config.policyFile);
    assert.equal(state.version, 3);
    assert.deepEqual(state.policy.rules.map((rule) => rule.id), ["no-bash", "no-patch"]);
  });
});

test("policy_update text commands that change policy are refused from the agent", async () => {
  await withPolicyServer(async ({ call, config }) => {
    for (const text of ["policy reset", "policy delete no-bash", "policy new: allow Bash"]) {
      assert.match(await call("policy_update", { text }), /staged, never applied/);
    }
    assert.match(await call("policy_update", { text: "policy list" }), /no-bash/);
    const state = await loadPolicyState(config.policyFile);
    assert.equal(state.version, 3);
    assert.equal(state.policy.rules.length, 2);
  });
});

test("an agent-staged change needs the user to confirm it by id, armor yes only shows it", async () => {
  await withPolicyServer(async ({ call, config }) => {
    await call("policy_update", { update: { reason: "cleanup", mode: "replace", rules: [] } });
    const shown = await handleArmorPolicyCommand("/armor yes", config, "sess-user");
    const id = shown.match(/armor policy confirm (pol_\w+)/)?.[1];
    assert.ok(id, shown);
    assert.match(shown, /The agent staged this change/);
    assert.equal((await loadPolicyState(config.policyFile)).policy.rules.length, 2);
    assert.match(await handleArmorPolicyCommand(`/armor policy confirm ${id}`, config, "sess-user"), /Policy updated to v4/);
    assert.equal((await loadPolicyState(config.policyFile)).policy.rules.length, 0);
  });
});

test("the agent cannot replace a change the user staged and has not confirmed", async () => {
  await withPolicyServer(async ({ call, config }) => {
    await handleArmorPolicyCommand("/armor policy add deny webfetch", config, "sess-user");
    const reply = await call("policy_update", { update: { reason: "swap", mode: "replace", rules: [] } });
    assert.match(reply, /cannot replace it/);
    assert.match(await call("policy_command", { command: "policy reset" }), /cannot replace it/);
    assert.match(await handleArmorPolicyCommand("/armor yes", config, "sess-user"), /Policy updated to v4/);
    const rules = (await loadPolicyState(config.policyFile)).policy.rules;
    assert.equal(rules.length, 3);
    assert.ok(rules.some((rule) => rule.tool === "webfetch" && rule.action === "deny"));
  });
});

test("the agent cannot save over or delete a policy profile", async () => {
  await withPolicyServer(async ({ call, config }) => {
    await handleArmorPolicyCommand("/armor profile save strict", config, "sess-user");
    for (const command of ["profile save strict", "profile delete strict"]) {
      assert.match(await call("policy_command", { command }), /human-only/);
    }
    assert.match(await handleArmorPolicyCommand("/armor profile list", config, "sess-user"), /strict \(2 rules\)/);
  });
});
