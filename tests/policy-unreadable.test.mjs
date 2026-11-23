import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { handlePreToolUse, handleSessionStart } from "../plugins/armorcodex/scripts/lib/engine.mjs";

process.env.ARMORCODEX_NO_AUTO_UPDATE = "1";
const UNREADABLE = /could not parse its policy file, so it denies tool calls/;

async function run(policyText) {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "armorcodex-unreadable-"));
  const policyFile = path.join(dataDir, "policy.json");
  const config = { mode: "enforce", dataDir, policyFile, runtimeFile: path.join(dataDir, "runtime.json"), apiKey: "", sanitize: {} };
  if (policyText !== undefined) await writeFile(policyFile, policyText);
  const input = { session_id: "s1", tool_name: "Bash", tool_input: { command: "ls" }, source: "startup" };
  return { decision: await handlePreToolUse(input, config), banner: await handleSessionStart(input, config) };
}

for (const text of ['{"version": 2, "policy": {"rules": [', "[]", '{"policy": "garbage"}', '{"version": 2}']) {
  test(`a policy file holding ${text} denies every tool and the banner says why`, async () => {
    const { decision, banner } = await run(text);
    assert.equal(decision?.hookSpecificOutput?.permissionDecision, "deny");
    assert.match(decision.hookSpecificOutput.permissionDecisionReason, UNREADABLE);
    assert.match(banner.hookSpecificOutput.additionalContext, /ENFORCING/);
    assert.match(banner.hookSpecificOutput.additionalContext, UNREADABLE);
    assert.match(banner.systemMessage, UNREADABLE);
  });
}

test("a missing policy file still allows tools and keeps the plain banner", async () => {
  const { decision, banner } = await run();
  assert.equal(decision, null);
  assert.doesNotMatch(banner.hookSpecificOutput.additionalContext, UNREADABLE);
  assert.equal(banner.systemMessage, undefined);
});
