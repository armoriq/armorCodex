import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { handlePreToolUse } from "../plugins/armorcodex/scripts/lib/engine.mjs";
import { requestIntent } from "../plugins/armorcodex/scripts/lib/intent.mjs";

const { ArmorIQClient } = createRequire(new URL("../plugins/armorcodex/package.json", import.meta.url))(
  "@armoriq/sdk"
);

const SESSION = "sess-plan-check";
const PLAN = { steps: [{ action: "Bash" }, { action: "Read" }, { action: "webrun" }], metadata: { goal: "inspect" } };

async function setup({ mode = "enforce", planCheck }) {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "armorcodex-plan-check-"));
  const config = {
    mode,
    dataDir,
    policyFile: path.join(dataDir, "policy.json"),
    runtimeFile: path.join(dataDir, "runtime.json"),
    apiKey: "ak_test_plancheck00000000000000000000",
    auditEnabled: true,
    useSdkIntent: false,
    intentEndpoint: "",
    verifyStepEndpoint: "",
    intentRequired: true,
    requireCsrgProofs: false,
    csrgVerifyEnabled: false,
    cryptoPolicyEnabled: false,
    llmId: "openai-codex",
    mcpName: "codex",
    userId: "user-login",
    agentId: "codex",
    debug: false,
    sanitize: { maxChars: 2000, maxDepth: 4, maxKeys: 50, maxItems: 50 }
  };
  const expiresAt = Math.floor(Date.now() / 1000) + 600;
  const token = { planId: randomUUID(), expiresAt, plan: PLAN, planCheck };
  await writeFile(
    path.join(dataDir, `pending-plan.${SESSION}.json`),
    JSON.stringify({ plan: PLAN, tokenRaw: JSON.stringify(token), allowedActions: [], expiresAt, planCheck })
  );
  return config;
}

async function walRows(config) {
  try {
    const raw = await readFile(path.join(config.dataDir, "audit", "current.jsonl"), "utf8");
    return raw.split("\n").filter(Boolean).map((line) => JSON.parse(line));
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
}

const preToolUse = (config, toolName, toolInput = {}) =>
  handlePreToolUse({ hook_event_name: "PreToolUse", session_id: SESSION, tool_name: toolName, tool_input: toolInput }, config);
const decisionOf = (output) => output?.hookSpecificOutput?.permissionDecision ?? "allow";

const blocksBash = (validated) => ({
  validated,
  allowedTools: ["Read", "webrun"],
  deniedTools: ["Bash"],
  deniedReasons: ["Bash: block:no-shell"],
  defaultEnforcementAction: "block"
});

test("enforce mode denies a tool the plan check lists, even when the check passed, and leaves a blocked row", async () => {
  const config = await setup({ planCheck: blocksBash(true) });
  const decision = await preToolUse(config, "Bash", { command: "ls" });
  assert.equal(decisionOf(decision), "deny");
  assert.match(decision.hookSpecificOutput.permissionDecisionReason, /ArmorIQ plan check denied Bash \(block:no-shell\)/);
  assert.equal(decisionOf(await preToolUse(config, "webrun", { q: "x" })), "allow");
  assert.deepEqual((await walRows(config)).map((row) => [row.status, row.tool]), [["blocked", "Bash"]]);
});

test("enforce mode denies a listed tool when the check did not validate", async () => {
  const config = await setup({ planCheck: { ...blocksBash(false), deniedReasons: ["Bash: agent_unresolved"] } });
  const decision = await preToolUse(config, "Bash", { command: "ls" });
  assert.match(decision.hookSpecificOutput.permissionDecisionReason, /plan check denied Bash \(agent_unresolved\)/);
});

test("monitor mode allows a listed tool, logs it to stderr, and writes no row", async (t) => {
  const stderr = [];
  t.mock.method(process.stderr, "write", (chunk) => {
    stderr.push(String(chunk));
    return true;
  });
  const config = await setup({ mode: "monitor", planCheck: blocksBash(true) });
  const before = Date.now();
  assert.equal(
    decisionOf(await handlePreToolUse(
      { hook_event_name: "PreToolUse", session_id: SESSION, tool_name: "Bash", tool_input: { command: "ls" }, tool_use_id: "call_1" },
      config
    )),
    "allow"
  );
  t.mock.restoreAll();
  assert.match(stderr.join(""), /\[armorcodex\] monitor mode: ArmorIQ plan check denied Bash \(block:no-shell\); allowing it/);
  assert.deepEqual(await walRows(config), []);
  const logPath = path.join(config.dataDir, "monitor.jsonl");
  const [entry, ...rest] = (await readFile(logPath, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
  assert.deepEqual(rest, []);
  assert.ok(entry.at >= before);
  assert.deepEqual(
    { ...entry, at: 0 },
    { at: 0, session_id: SESSION, tool: "Bash", tool_use_id: "call_1", reason: "ArmorIQ plan check denied Bash (block:no-shell)" }
  );
  assert.equal((await stat(logPath)).mode & 0o777, 0o600);
});

test("ArmorCodex's own tools and the read-only tools stay allowed even when the plan check lists them", async () => {
  const config = await setup({
    planCheck: { ...blocksBash(true), deniedTools: ["mcp__armorcodex_policy__register_intent_plan", "Read"] }
  });
  assert.equal(decisionOf(await preToolUse(config, "mcp__armorcodex_policy__register_intent_plan")), "allow");
  assert.equal(decisionOf(await preToolUse(config, "Read", { path: "a" })), "allow");
});

test("requestIntent returns the token's plan check", async (t) => {
  const planCheck = blocksBash(true);
  t.mock.method(ArmorIQClient.prototype, "getIntentToken", async () => ({
    planId: randomUUID(),
    expiresAt: Math.floor(Date.now() / 1000) + 600,
    plan: PLAN,
    planCheck
  }));
  const result = await requestIntent(
    {
      apiKey: "ak_test_plancheck00000000000000000000",
      useSdkIntent: true,
      intentEndpoint: "",
      userId: "user-login",
      agentId: "codex",
      contextId: "default",
      llmId: "openai-codex",
      iapEndpoint: "http://127.0.0.1:9",
      proxyEndpoint: "http://127.0.0.1:9",
      backendEndpoint: "http://127.0.0.1:9"
    },
    { plan: PLAN, session_id: SESSION, validitySeconds: 600 }
  );
  assert.deepEqual(result.planCheck, planCheck);
});
