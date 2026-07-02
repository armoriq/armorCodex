import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  handleArmorPolicyCommand,
  isArmorPolicyCommand,
  parseCommand
} from "../plugins/armorcodex/scripts/lib/armor-policy-commands.mjs";
import { loadPolicyState } from "../plugins/armorcodex/scripts/lib/policy.mjs";

async function tempConfig() {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "armorcodex-cmd-"));
  return { dataDir, policyFile: path.join(dataDir, "policy.json") };
}

test("isArmorPolicyCommand detects /armor and bare forms, ignores prose", () => {
  assert.equal(isArmorPolicyCommand("/armor policy list"), true);
  assert.equal(isArmorPolicyCommand("armor policy add deny bash"), true);
  assert.equal(isArmorPolicyCommand("/armor yes"), true);
  assert.equal(isArmorPolicyCommand("just talking about armor plating"), false);
  // Natural-language `Policy ...` is handled by the legacy path, not here.
  assert.equal(isArmorPolicyCommand("Policy new: deny bash"), false);
});

test("parseCommand maps verbs", () => {
  assert.equal(parseCommand("/armor policy list").cmd, "list");
  assert.equal(parseCommand("/armor policy view").cmd, "view");
  assert.equal(parseCommand("/armor yes").cmd, "confirm");
  assert.equal(parseCommand("/armor no").cmd, "cancel");
  assert.equal(parseCommand("/armor policy reset").cmd, "reset");
  assert.equal(parseCommand("/armor policy remove policy1").id, "policy1");
  assert.equal(parseCommand("/armor policy default deny").decision, "deny");
  assert.equal(parseCommand("/armor policy default hold").decision, "require_approval");
  const add = parseCommand("/armor policy add deny bash");
  assert.equal(add.cmd, "add");
  assert.deepEqual(add.rules, [{ action: "deny", tool: "bash" }]);
  const many = parseCommand("/armor policy add allow bash and apply_patch, deny apply_patch");
  assert.equal(many.rules.length, 3);
});

test("add stages a proposal without applying; confirm applies it", async () => {
  const config = await tempConfig();
  const staged = await handleArmorPolicyCommand("/armor policy add deny bash", config, "tester");
  assert.match(staged, /Proposed policy change/);
  // Not yet applied.
  let state = await loadPolicyState(config.policyFile);
  assert.equal(state.version, 0);
  assert.equal(state.policy.rules.length, 0);
  // Confirm.
  const applied = await handleArmorPolicyCommand("/armor yes", config, "tester");
  assert.match(applied, /Policy updated to v1/);
  state = await loadPolicyState(config.policyFile);
  assert.equal(state.version, 1);
  assert.equal(state.policy.rules[0].action, "deny");
  assert.equal(state.policy.rules[0].tool, "bash");
});

test("confirm with no staged proposal is a no-op message", async () => {
  const config = await tempConfig();
  const msg = await handleArmorPolicyCommand("/armor yes", config, "tester");
  assert.match(msg, /No staged policy change/);
});

test("confirm rejects a proposal whose base version no longer matches", async () => {
  const config = await tempConfig();
  // Hand-write a pending proposal with a stale base version.
  await writeFile(
    path.join(config.dataDir, "policy-pending.json"),
    JSON.stringify({
      proposalId: "pol_stale123",
      reason: "stale",
      stagedBy: "tester",
      baseVersion: 99,
      basePolicyHash: "deadbeef",
      proposalHash: "cafef00d",
      proposedPolicy: { rules: [{ id: "policy1", action: "deny", tool: "bash" }] },
      stagedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 60000).toISOString()
    })
  );
  const msg = await handleArmorPolicyCommand("/armor yes", config, "tester");
  assert.match(msg, /changed since|Re-stage/);
  const state = await loadPolicyState(config.policyFile);
  assert.equal(state.version, 0);
});

test("applying is human-only: confirm blocked when allowConfirm is false", async () => {
  const config = await tempConfig();
  await handleArmorPolicyCommand("/armor policy add deny bash", config, "mcp", { allowConfirm: false });
  const blocked = await handleArmorPolicyCommand("/armor yes", config, "mcp", { allowConfirm: false });
  assert.match(blocked, /human-only/);
  const state = await loadPolicyState(config.policyFile);
  assert.equal(state.version, 0); // never applied by the non-human caller
});

test("identical proposal is reported as no change", async () => {
  const config = await tempConfig();
  const msg = await handleArmorPolicyCommand("/armor policy reset", config, "tester");
  assert.match(msg, /No changes/);
});

test("profile save then switch round-trips the ruleset", async () => {
  const config = await tempConfig();
  await handleArmorPolicyCommand("/armor policy add deny bash", config, "tester");
  await handleArmorPolicyCommand("/armor yes", config, "tester");
  await handleArmorPolicyCommand("/armor profile save baseline", config, "tester");
  await handleArmorPolicyCommand("/armor policy reset", config, "tester");
  await handleArmorPolicyCommand("/armor yes", config, "tester");
  let state = await loadPolicyState(config.policyFile);
  assert.equal(state.policy.rules.length, 0);
  await handleArmorPolicyCommand("/armor profile switch baseline", config, "tester");
  await handleArmorPolicyCommand("/armor yes", config, "tester");
  state = await loadPolicyState(config.policyFile);
  assert.equal(state.policy.rules.length, 1);
  assert.equal(state.policy.rules[0].tool, "bash");
});
