import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { handleArmorPolicyCommand } from "../plugins/armorcodex/scripts/lib/armor-policy-commands.mjs";
import {
  matchParams,
  matchesAnyStringField,
  normalizeToolName
} from "../plugins/armorcodex/scripts/lib/common.mjs";
import {
  detectDataClasses,
  evaluatePolicy,
  loadPolicyState
} from "../plugins/armorcodex/scripts/lib/policy.mjs";

async function tempConfig() {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "armorcodex-migrate-"));
  return { dataDir, policyFile: path.join(dataDir, "policy.json") };
}

// The pre-migration evaluator: first matching rule wins, unmatched allows.
function legacyBlocks(rules, toolName, params) {
  const classes = detectDataClasses(toolName, params);
  for (const rule of rules) {
    const tool = normalizeToolName(rule.tool);
    const name = normalizeToolName(toolName);
    const toolHit =
      rule.tool === "*" || (tool.length > 1 && tool.endsWith("*") ? name.startsWith(tool.slice(0, -1)) : tool === name);
    if (!toolHit) continue;
    if (rule.dataClass && !classes.has(rule.dataClass)) continue;
    if (rule.params && !matchParams(rule.params, params).matched) continue;
    if (rule.anyParam && !matchesAnyStringField(rule.anyParam, params)) continue;
    return rule.action !== "allow";
  }
  return false;
}

const RULE_POOL = [
  { action: "deny", tool: "bash", anyParam: { $contains: "secret" } },
  { action: "allow", tool: "bash" },
  { action: "require_approval", tool: "mcp__github__*" },
  { action: "deny", tool: "*" },
  { action: "allow", tool: "apply_patch" },
  { action: "deny", tool: "apply_patch", params: { input: { $contains: ".env" } } },
  { action: "deny", tool: "*", dataClass: "PCI" },
  { action: "allow", tool: "*" }
];

const CALLS = [
  ["Bash", { command: "ls" }],
  ["Bash", { command: "cat secret.txt" }],
  ["Bash", { command: "echo card 4111 1111 1111 1111" }],
  ["apply_patch", { input: "*** Add File: .env" }],
  ["apply_patch", { input: "*** Add File: notes.md" }],
  ["mcp__github__create_pr", { title: "x" }],
  ["mcp__slack__post", { text: "hello" }]
];

function* ruleLists() {
  for (let a = 0; a < RULE_POOL.length; a += 1) {
    yield [RULE_POOL[a]];
    for (let b = 0; b < RULE_POOL.length; b += 1) {
      if (b === a) continue;
      yield [RULE_POOL[a], RULE_POOL[b]];
      for (let c = 0; c < RULE_POOL.length; c += 1) {
        if (c !== a && c !== b) yield [RULE_POOL[a], RULE_POOL[b], RULE_POOL[c]];
      }
    }
  }
}

test("migration never turns a call that is blocked today into an allowed one", () => {
  let lists = 0;
  for (const list of ruleLists()) {
    const rules = list.map((rule, i) => ({ id: `policy${i + 1}`, ...rule }));
    for (const [tool, params] of CALLS) {
      if (!legacyBlocks(rules, tool, params)) continue;
      const decision = evaluatePolicy({ policy: { rules }, toolName: tool, toolParams: params });
      assert.equal(decision.allowed, false, `${JSON.stringify(rules)} must still block ${tool} ${JSON.stringify(params)}`);
    }
    lists += 1;
  }
  assert.ok(lists > 300);
});

test("a legacy policy.json is rewritten as armor.policy.v1 in place with a backup", async () => {
  const config = await tempConfig();
  const legacy = {
    version: 3,
    updatedAt: "2026-11-01T00:00:00.000Z",
    policy: {
      rules: [
        { id: "policy1", action: "allow", tool: "bash" },
        { id: "policy2", action: "deny", tool: "bash", anyParam: { $contains: "secret.txt" } },
        { id: "policy3", action: "deny", tool: "*" }
      ]
    },
    history: [{ version: 3, reason: "seed" }]
  };
  const original = JSON.stringify(legacy);
  await writeFile(config.policyFile, original);

  const state = await loadPolicyState(config.policyFile);
  const stored = JSON.parse(await readFile(config.policyFile, "utf8"));
  assert.equal(stored.policy.schemaVersion, "armor.policy.v1");
  assert.equal(stored.policy.defaults.decision, "deny");
  assert.equal(stored.policy.defaults.conflictResolution, "deny_overrides");
  assert.deepEqual(
    stored.policy.statements.map((s) => [s.id, s.effect]),
    [["policy1", "permit"], ["policy2", "forbid"]]
  );
  assert.equal(stored.version, 4);
  assert.match(stored.history.at(-1).reason, /armor\.policy\.v1.*policy\.json\.legacy\.bak/);
  assert.equal(await readFile(`${config.policyFile}.legacy.bak`, "utf8"), original);

  const decide = (tool, params) => evaluatePolicy({ policy: state.document, toolName: tool, toolParams: params }).allowed;
  assert.equal(decide("Bash", { command: "ls" }), true);
  assert.equal(decide("apply_patch", { input: "x" }), false, "the trailing deny * is the default");
  assert.equal(decide("Bash", { command: "cat secret.txt" }), false, "deny now overrides the earlier allow");

  const again = await loadPolicyState(config.policyFile);
  assert.equal(again.version, 4, "a migrated file is not migrated twice");
});

test("policy commands keep armor.policy.v1 statements the rule shape cannot express", async () => {
  const config = await tempConfig();
  const document = {
    schemaVersion: "armor.policy.v1",
    kind: "PolicyProfile",
    metadata: { name: "console", description: "" },
    defaults: { decision: "allow", conflictResolution: "deny_overrides" },
    statements: [
      {
        id: "no-curl",
        effect: "forbid",
        principal: { type: "agent", id: "armorcodex" },
        action: { type: "bash_program", in: ["curl", "wget"] },
        resource: { type: "workspace", scope: "current" },
        conditions: [{ field: "bash.raw", op: "matches", value: "https?://" }]
      }
    ]
  };
  await writeFile(config.policyFile, JSON.stringify({ version: 1, policy: document, history: [] }));

  await handleArmorPolicyCommand("/armor policy add deny apply_patch", config, "tester");
  await handleArmorPolicyCommand("/armor yes", config, "tester");

  const state = await loadPolicyState(config.policyFile);
  assert.deepEqual(state.document.statements[0], document.statements[0]);
  assert.equal(state.document.statements[1].action.eq, "apply_patch");
  const decide = (tool, params) => evaluatePolicy({ policy: state.document, toolName: tool, toolParams: params }).allowed;
  assert.equal(decide("Bash", { command: "curl https://example.com" }), false);
  assert.equal(decide("Bash", { command: "curl --version" }), true);
  assert.equal(decide("Bash", { command: "ls" }), true);
});

test("default hold blocks unmatched tools and lists as a catch-all rule", async () => {
  const config = await tempConfig();
  await handleArmorPolicyCommand("/armor policy add allow bash", config, "tester");
  await handleArmorPolicyCommand("/armor yes", config, "tester");
  await handleArmorPolicyCommand("/armor policy default hold", config, "tester");
  await handleArmorPolicyCommand("/armor yes", config, "tester");

  const state = await loadPolicyState(config.policyFile);
  assert.equal(state.document.defaults.decision, "hold");
  assert.deepEqual(state.policy.rules.at(-1), { id: "default", action: "require_approval", tool: "*" });
  const decision = evaluatePolicy({ policy: state.document, toolName: "apply_patch", toolParams: {} });
  assert.equal(decision.allowed, false);
  assert.equal(evaluatePolicy({ policy: state.document, toolName: "Bash", toolParams: {} }).allowed, true);
});
