import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { handlePermissionRequest, handlePreToolUse } from "../plugins/armorcodex/scripts/lib/engine.mjs";
import { decideV2 } from "../plugins/armorcodex/scripts/lib/v2-decision.mjs";
import { settleHold } from "../plugins/armorcodex/scripts/lib/policy-gate.mjs";

// Captured from conmap-auto's GET /policy/bundles/current?agent=armorcodex: an
// active org-wide policy blocking apply_patch and an agent shadow blocking Bash.
const LIVE = JSON.parse(
  await readFile(new URL("./fixtures/policy-bundle-armorcodex.json", import.meta.url), "utf8")
);
const ETAG = '"sha256:fixture"';

async function backend(handler) {
  const requests = [];
  const server = createServer((req, res) => {
    requests.push({ url: req.url, ifNoneMatch: req.headers["if-none-match"], apiKey: req.headers["x-api-key"] });
    handler(req, res);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { url: `http://127.0.0.1:${server.address().port}`, requests, close: () => server.close() };
}

function serveBundle(bundle) {
  return (req, res) => {
    if (req.headers["if-none-match"] === ETAG) {
      res.writeHead(304, { ETag: ETAG }).end();
      return;
    }
    res.writeHead(200, { "content-type": "application/json", ETag: ETAG }).end(JSON.stringify(bundle));
  };
}

function withPolicies(policies, extra = {}) {
  const agent = { ...LIVE.agents[0], policies, ...extra };
  return { ...LIVE, agents: [agent] };
}

const [FLOOR] = LIVE.agents[0].policies;
// The same org policy after an edit to `Bash: hold`, as the backend compiled it.
const FLOOR_HOLD = JSON.parse(
  await readFile(new URL("./fixtures/policy-v2-floor-bash-hold.json", import.meta.url), "utf8")
);

async function config(url, overrides = {}) {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "armorcodex-v2-"));
  await writeFile(path.join(dataDir, "runtime.json"), JSON.stringify({ sessions: {} }));
  return {
    mode: "enforce",
    dataDir,
    policyFile: path.join(dataDir, "policy.json"),
    runtimeFile: path.join(dataDir, "runtime.json"),
    apiKey: "ak_test_policyv2000000000000000000000",
    backendEndpoint: url,
    policyAgentId: "armorcodex",
    auditEnabled: false,
    intentRequired: false,
    planningEnabled: false,
    cryptoPolicyEnabled: false,
    sanitize: { maxChars: 2000, maxDepth: 4, maxKeys: 50, maxItems: 50 },
    ...overrides
  };
}

test("the org floor blocks with the policy name; the shadow is reported, not enforced", async (t) => {
  const server = await backend(serveBundle(LIVE));
  t.after(server.close);
  const cfg = await config(server.url);

  const patch = await decideV2(cfg, "apply_patch", { input: "*** Add File: a" });
  assert.equal(patch.verdict, "block");
  assert.equal(patch.policyName, "codex-floor");
  assert.equal(patch.targetType, "org");
  assert.equal(patch.ruleId, "apply_patch#0");
  assert.equal(patch.policyHash, FLOOR.policyHash);

  const bash = await decideV2(cfg, "Bash", { command: "ls" });
  assert.equal(bash.verdict, "allow");
  assert.deepEqual(
    bash.shadow.map((s) => [s.policy_name, s.verdict, s.rule_id]),
    [["codex-shadow-bash", "block", "Bash#0"]]
  );
  assert.equal(server.requests[0].url, "/policy/bundles/current?agent=armorcodex");
  assert.equal(server.requests[0].apiKey, cfg.apiKey);
});

test("the bundle is revalidated with its ETag only after 60 seconds, across hook processes", async (t) => {
  const server = await backend(serveBundle(LIVE));
  t.after(server.close);
  const cfg = await config(server.url);

  await decideV2(cfg, "Bash", { command: "ls" });
  await decideV2(cfg, "Bash", { command: "ls" });
  assert.equal(server.requests.length, 1, "a second hook inside 60s reuses the bundle on disk");

  const file = path.join(cfg.dataDir, "policy-bundle.json");
  const saved = JSON.parse(await readFile(file, "utf8"));
  saved.entry.confirmedAt -= 61_000;
  await writeFile(file, JSON.stringify(saved));

  const decision = await decideV2(cfg, "apply_patch", {});
  assert.equal(server.requests.length, 2);
  assert.equal(server.requests[1].ifNoneMatch, ETAG);
  assert.equal(decision.verdict, "block", "a 304 keeps the cached policy");
});

test("no applicable v2 policy falls back to the local file", async (t) => {
  const none = await backend(serveBundle(withPolicies([])));
  const missing = await backend((req, res) => res.writeHead(404).end());
  t.after(() => (none.close(), missing.close()));
  assert.equal(await decideV2(await config(none.url), "apply_patch", {}), null);
  assert.equal(await decideV2(await config(missing.url), "apply_patch", {}), null);
});

test("a backend error with no cached bundle blocks", async (t) => {
  const server = await backend((req, res) => res.writeHead(503).end());
  t.after(server.close);
  const decision = await decideV2(await config(server.url), "apply_patch", {});
  assert.equal(decision.verdict, "block");
  assert.match(decision.reason, /policy-bundle-unavailable/);
});

test("a backend without policies[] is read from the legacy agent.policy", async (t) => {
  const legacy = { ...LIVE.agents[0], policy: FLOOR, policies: undefined };
  const server = await backend(serveBundle({ ...LIVE, agents: [legacy] }));
  t.after(server.close);
  const decision = await decideV2(await config(server.url), "apply_patch", {});
  assert.equal(decision.verdict, "block");
  assert.equal(decision.policyName, "codex-floor");
});

test("PreToolUse blocks a v2-denied tool with the policy name and records the source", async (t) => {
  const server = await backend(serveBundle(LIVE));
  t.after(server.close);
  const cfg = await config(server.url);

  const out = await handlePreToolUse(
    { hook_event_name: "PreToolUse", session_id: "s1", tool_name: "apply_patch", tool_input: { input: "x" } },
    cfg
  );
  assert.equal(out.hookSpecificOutput.permissionDecision, "deny");
  assert.match(out.hookSpecificOutput.permissionDecisionReason, /ArmorIQ policy "codex-floor" blocked apply_patch/);

  assert.equal(
    await handlePreToolUse(
      { hook_event_name: "PreToolUse", session_id: "s1", tool_name: "Bash", tool_input: { command: "ls" } },
      cfg
    ),
    null,
    "the shadow policy does not block"
  );
  const shadowLog = (await readFile(path.join(cfg.dataDir, "policy-shadow.jsonl"), "utf8")).trim().split("\n");
  assert.equal(JSON.parse(shadowLog.at(-1)).shadow[0].policy_name, "codex-shadow-bash");
});

test("the local policy still blocks when v2 allows: strictest wins", async (t) => {
  const server = await backend(serveBundle(LIVE));
  t.after(server.close);
  const cfg = await config(server.url);
  await writeFile(cfg.policyFile, JSON.stringify({ version: 1, policy: { rules: [{ id: "p1", action: "deny", tool: "bash" }] } }));
  const out = await handlePreToolUse(
    { hook_event_name: "PreToolUse", session_id: "s1", tool_name: "Bash", tool_input: { command: "ls" } },
    cfg
  );
  assert.match(out.hookSpecificOutput.permissionDecisionReason, /ArmorCodex policy deny: p1/);
});

test("a held Bash call: blocked with approvals off; with approvals on, released once to Codex's prompt", async (t) => {
  const server = await backend(serveBundle(withPolicies([FLOOR_HOLD])));
  t.after(server.close);
  const cfg = await config(server.url);
  const call = (mode, turn = "t1") => ({
    hook_event_name: "PreToolUse",
    session_id: "s-hold",
    turn_id: turn,
    permission_mode: mode,
    tool_name: "Bash",
    tool_input: { command: "date -u" }
  });

  const off = await handlePreToolUse(call("bypassPermissions"), cfg);
  assert.match(off.hookSpecificOutput.permissionDecisionReason, /holds Bash for approval.*Approvals are off/);

  const first = await handlePreToolUse(call("default"), cfg);
  assert.match(first.hookSpecificOutput.permissionDecisionReason, /escalated permissions/);
  assert.equal(await handlePreToolUse(call("default"), cfg), null, "the identical retry goes to the approval prompt");

  const prompt = await handlePermissionRequest(
    { ...call("default"), hook_event_name: "PermissionRequest", tool_input: { command: "date -u", description: "why" } },
    cfg
  );
  assert.equal(prompt.hookSpecificOutput, undefined, "the person decides");
  assert.match(prompt.systemMessage, /codex-floor/);

  assert.equal(await settleHold(cfg, { ...call("default"), hook_event_name: "PostToolUse" }), "approved");

  const other = await handlePreToolUse({ ...call("default"), tool_input: { command: "date" } }, cfg);
  assert.equal(other.hookSpecificOutput.permissionDecision, "deny", "a release covers only that exact command");
  const later = await handlePreToolUse(call("default", "t2"), cfg);
  assert.equal(later.hookSpecificOutput.permissionDecision, "deny", "a release covers only the turn it was refused in");
});

test("a released hold that never reached a prompt is recorded as such", async (t) => {
  const server = await backend(serveBundle(withPolicies([FLOOR_HOLD])));
  t.after(server.close);
  const cfg = await config(server.url);
  const call = { hook_event_name: "PreToolUse", session_id: "s-np", turn_id: "t1", permission_mode: "default", tool_name: "Bash", tool_input: { command: "make" } };
  await handlePreToolUse(call, cfg);
  assert.equal(await handlePreToolUse(call, cfg), null);
  assert.equal(await settleHold(cfg, { ...call, hook_event_name: "PostToolUse" }), "ran_without_prompt");
  assert.equal(await settleHold(cfg, { ...call, hook_event_name: "PostToolUse" }), undefined);
});

test("monitor mode still enforces a local block that v2 also makes", async (t) => {
  const server = await backend(serveBundle(LIVE));
  t.after(server.close);
  const cfg = await config(server.url, { mode: "monitor" });
  await writeFile(cfg.policyFile, JSON.stringify({ version: 1, policy: { rules: [{ id: "p1", action: "deny", tool: "apply_patch" }] } }));
  const out = await handlePreToolUse(
    { hook_event_name: "PreToolUse", session_id: "s1", tool_name: "apply_patch", tool_input: { input: "x" } },
    cfg
  );
  assert.equal(out.hookSpecificOutput.permissionDecision, "deny");
});

test("a cached bundle confirmed in the future is refetched", async (t) => {
  const server = await backend(serveBundle(LIVE));
  t.after(server.close);
  const cfg = await config(server.url);
  await writeFile(
    path.join(cfg.dataDir, "policy-bundle.json"),
    JSON.stringify({
      backend: server.url,
      key: (await import("node:crypto")).createHash("sha256").update(cfg.apiKey).digest("hex").slice(0, 16),
      agentId: "armorcodex",
      entry: { agentId: "armorcodex", etag: ETAG, agent: { ...LIVE.agents[0], policies: [] }, confirmedAt: Date.now() + 365 * 864e5 }
    })
  );
  const decision = await decideV2(cfg, "apply_patch", {});
  assert.equal(server.requests.length, 1);
  assert.equal(server.requests[0].ifNoneMatch, undefined);
  assert.equal(decision.verdict, "block");
});

test("a shadow document that fails to evaluate is skipped, not enforced", async (t) => {
  const broken = { ...FLOOR, policyId: "broken", name: "broken-shadow", targetType: "org", status: "shadow", document: { defaults: null, statements: [] } };
  const server = await backend(serveBundle(withPolicies([FLOOR, broken])));
  t.after(server.close);
  const decision = await decideV2(await config(server.url), "Bash", { command: "ls" });
  assert.equal(decision.verdict, "allow");
  assert.deepEqual(decision.shadow, []);
});

test("ARMORCODEX_POLICY_V2=false turns organization policy off without a request", async (t) => {
  const server = await backend(serveBundle(LIVE));
  t.after(server.close);
  assert.equal(await decideV2(await config(server.url, { policyV2Enabled: false }), "apply_patch", {}), null);
  assert.equal(server.requests.length, 0);
});
