import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { handlePermissionRequest, handlePostToolUse, handlePreToolUse } from "../plugins/armorcodex/scripts/lib/engine.mjs";
import { decideV2 } from "../plugins/armorcodex/scripts/lib/v2-decision.mjs";
import { combinePolicyDecisions, settleHold } from "../plugins/armorcodex/scripts/lib/policy-gate.mjs";

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

function holdBackend(answers) {
  const calls = [];
  const handler = (req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      const route = req.url.split("?")[0];
      if (route === "/policy/bundles/current") return serveBundle(withPolicies([FLOOR_HOLD]))(req, res);
      calls.push({ route, body: body ? JSON.parse(body) : undefined, email: req.headers["x-user-email"] });
      const [status, payload] = answers[route]?.(calls) ?? [404, {}];
      res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(payload));
    });
  };
  return { handler, calls };
}

const jwtFor = (claims) => `h.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.s`;

async function withPlan(cfg, sessionId, planId = "plan-1") {
  const token = { jwtToken: jwtFor({ type: "iap_token", plan_id: planId, agent_id: "codex-minted" }), planId };
  await writeFile(cfg.runtimeFile, JSON.stringify({ sessions: { [sessionId]: { intentTokenRaw: JSON.stringify(token) } } }));
}

const heldBash = (sessionId, command = "date -u") => ({
  hook_event_name: "PreToolUse",
  session_id: sessionId,
  tool_use_id: "tu1",
  tool_name: "Bash",
  tool_input: { command }
});

test("a held call without a signed plan is stopped with the way to attach one", async (t) => {
  const { handler, calls } = holdBackend({});
  const server = await backend(handler);
  t.after(server.close);
  const out = await handlePreToolUse(heldBash("s-noplan"), await config(server.url, { userEmail: "dev@acme.test" }));
  assert.match(out.hookSpecificOutput.permissionDecisionReason, /holds Bash for approval.*register_intent_plan/);
  assert.equal(calls.filter((c) => c.route !== "/iap/validate-key").length, 0);
});

test("a held call files one approval request, and its retry runs once the workspace approved it", async (t) => {
  let approved = false;
  const { handler, calls } = holdBackend({
    "/iap/sdk/enforce": () =>
      approved
        ? [200, { allowed: true, enforcementAction: "allow", reason: "approved_delegation", metadata: { delegationId: "d-1" } }]
        : [200, { allowed: false, enforcementAction: "hold", reason: "hold:Bash#0" }],
    "/delegation/my-role": () => [200, { role: "member", limit: 5 }],
    "/delegation/request": () => [201, { delegationId: "d-1", status: "pending" }]
  });
  const server = await backend(handler);
  t.after(server.close);
  const cfg = await config(server.url, { userEmail: "dev@acme.test", agentId: "codex", mcpName: "codex", auditEnabled: true });
  await withPlan(cfg, "s-hold");

  const first = await handlePreToolUse(heldBash("s-hold"), cfg);
  assert.equal(first.hookSpecificOutput.permissionDecision, "deny");
  assert.match(first.hookSpecificOutput.permissionDecisionReason, /"codex-floor" holds Bash for approval.*Approval request d-1 is waiting/);
  const wal = (await readFile(path.join(cfg.dataDir, "audit", "current.jsonl"), "utf8")).trim().split("\n").map((l) => JSON.parse(l));
  assert.deepEqual(wal.map((r) => r.status), ["held"], "a held row keeps the plan open on the backend");
  const enforce = calls.find((c) => c.route === "/iap/sdk/enforce").body;
  assert.equal(enforce.agent_id, "codex-minted", "the agent the token was minted for, not the configured one");
  assert.deepEqual(enforce.intent_token, { jwt_token: jwtFor({ type: "iap_token", plan_id: "plan-1", agent_id: "codex-minted" }), plan_id: "plan-1" });
  assert.equal(enforce.user_email, "dev@acme.test");
  assert.equal(enforce.mcp, "codex");
  const request = calls.find((c) => c.route === "/delegation/request");
  assert.deepEqual(
    { ...request.body, email: request.email },
    { tool: "Bash", action: "execute", arguments: { command: "date -u" }, requesterEmail: "dev@acme.test", requesterRole: "member", requesterLimit: 5, domain: "codex", planId: "plan-1", reason: "hold:Bash#0", email: "dev@acme.test" }
  );

  await handlePreToolUse(heldBash("s-hold"), cfg);
  assert.equal(calls.filter((c) => c.route === "/delegation/request").length, 1, "a still-held retry reuses its request");

  approved = true;
  assert.equal(await handlePreToolUse(heldBash("s-hold"), cfg), null);
  const prompt = await handlePermissionRequest({ ...heldBash("s-hold"), hook_event_name: "PermissionRequest" }, cfg);
  assert.equal(prompt.hookSpecificOutput, undefined, "Codex's own sandbox prompt is left to the person");
  assert.match(prompt.systemMessage, /approved this Bash call \(request d-1\)/);
  assert.equal(await settleHold(cfg, { ...heldBash("s-hold"), hook_event_name: "PostToolUse" }), "approved");
  assert.equal(await settleHold(cfg, { ...heldBash("s-hold"), hook_event_name: "PostToolUse" }), undefined);
});

test("an approval spent by a call that never finished does not carry over to a later run of the same call", async (t) => {
  let approved = true;
  const { handler } = holdBackend({
    "/iap/sdk/enforce": () =>
      approved
        ? [200, { allowed: true, enforcementAction: "allow", reason: "approved_delegation", metadata: { delegationId: "d-1" } }]
        : [200, { allowed: false, enforcementAction: "hold", reason: "hold:Bash#0" }],
    "/delegation/my-role": () => [200, { role: "member", limit: 5 }],
    "/delegation/request": () => [201, { delegationId: "d-2", status: "pending" }]
  });
  const server = await backend(handler);
  t.after(server.close);
  const cfg = await config(server.url, { userEmail: "dev@acme.test", agentId: "codex", mcpName: "codex" });
  await withPlan(cfg, "s-failed");
  assert.equal(await handlePreToolUse(heldBash("s-failed"), cfg), null);

  approved = false;
  await withPlan(cfg, "s-failed");
  const later = { ...heldBash("s-failed"), tool_use_id: "tu2" };
  const retry = await handlePreToolUse(later, cfg);
  assert.match(retry.hookSpecificOutput.permissionDecisionReason, /Approval request d-2 is waiting/);
  const prompt = await handlePermissionRequest({ ...later, hook_event_name: "PermissionRequest" }, cfg);
  assert.equal(prompt.hookSpecificOutput.decision.behavior, "deny");
  assert.equal(await settleHold(cfg, { ...later, hook_event_name: "PostToolUse" }), undefined);
});

test("a retry under the next turn's plan spends the approval filed under the earlier plan", async (t) => {
  let status = "pending";
  const { handler, calls } = holdBackend({
    "/iap/sdk/enforce": (all) =>
      all.at(-1).body.intent_token.plan_id === "plan-1" && status === "approved"
        ? [200, { allowed: true, enforcementAction: "allow", reason: "approved_delegation", metadata: { delegationId: "d-1" } }]
        : [200, { allowed: false, enforcementAction: "hold", reason: "hold:Bash#0" }],
    "/delegation/my-role": () => [200, { role: "member", limit: 5 }],
    "/delegation/request": () => [201, { delegationId: "d-1", status: "pending" }],
    "/delegation/d-1/status": () => [200, { status, delegationId: "d-1" }]
  });
  const server = await backend(handler);
  t.after(server.close);
  const cfg = await config(server.url, { userEmail: "dev@acme.test", agentId: "codex", mcpName: "codex" });
  await withPlan(cfg, "s-turns");
  await handlePreToolUse(heldBash("s-turns"), cfg);

  await withPlan(cfg, "s-turns", "plan-2");
  const pending = await handlePreToolUse(heldBash("s-turns"), cfg);
  assert.match(pending.hookSpecificOutput.permissionDecisionReason, /Approval request d-1 is waiting/);
  assert.equal(calls.filter((c) => c.route === "/delegation/request").length, 1, "no second request for the same call");

  status = "approved";
  await withPlan(cfg, "s-turns", "plan-3");
  assert.equal(await handlePreToolUse(heldBash("s-turns"), cfg), null);
  const plans = calls.filter((c) => c.route === "/iap/sdk/enforce").map((c) => c.body.intent_token.plan_id);
  assert.deepEqual(plans, ["plan-1", "plan-2", "plan-3", "plan-1"]);
  assert.equal(await settleHold(cfg, { ...heldBash("s-turns"), hook_event_name: "PostToolUse" }), "approved");
});

test("a held call is stopped when the approval check fails or the backend blocks it", async (t) => {
  for (const [answer, expected] of [
    [() => [500, {}], /approval check failed \(HTTP 500\)/],
    [() => [200, { allowed: false, enforcementAction: "block", message: "The intent token was issued to another agent." }], /issued to another agent/]
  ]) {
    const { handler, calls } = holdBackend({ "/iap/sdk/enforce": answer });
    const server = await backend(handler);
    t.after(server.close);
    const cfg = await config(server.url, { userEmail: "dev@acme.test" });
    await withPlan(cfg, "s-fail");
    const out = await handlePreToolUse(heldBash("s-fail"), cfg);
    assert.equal(out.hookSpecificOutput.permissionDecision, "deny");
    assert.match(out.hookSpecificOutput.permissionDecisionReason, expected);
    assert.equal(calls.filter((c) => c.route === "/delegation/request").length, 0);
  }
});

test("a call only the tools default allows is not credited to a policy", async (t) => {
  const server = await backend(serveBundle(withPolicies([FLOOR_HOLD])));
  t.after(server.close);
  const decision = await decideV2(await config(server.url), "Read", { file_path: "a" });
  assert.equal(decision.verdict, "allow");
  assert.equal(decision.policyName, undefined);
  assert.equal(combinePolicyDecisions(decision, { allowed: true, effect: "default" }).record.source, "default");
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

test("in monitor mode a v2 block or hold runs, and its row records the verdict as not enforced", async (t) => {
  const server = await backend(serveBundle(withPolicies([FLOOR_HOLD])));
  t.after(server.close);
  const cfg = await config(server.url, { mode: "monitor", auditEnabled: true });
  for (const [tool, toolInput, id] of [["apply_patch", { input: "x" }, "call_patch"], ["Bash", { command: "date -u" }, "call_bash"]]) {
    const call = { session_id: "s-mon", tool_name: tool, tool_input: toolInput, tool_use_id: id };
    assert.equal(await handlePreToolUse({ ...call, hook_event_name: "PreToolUse" }, cfg), null);
    await handlePostToolUse({ ...call, hook_event_name: "PostToolUse", tool_response: "ok" }, cfg);
  }
  const rows = (await readFile(path.join(cfg.dataDir, "audit", "current.jsonl"), "utf8")).trim().split("\n").map((l) => JSON.parse(l));
  assert.deepEqual(
    rows.map((r) => [r.tool, r.status, r.input.armoriq_policy.policy_name, r.input.armoriq_policy.verdict, r.input.armoriq_policy.enforced]),
    [
      ["apply_patch", "success", "codex-floor", "block", false],
      ["Bash", "success", "codex-floor", "hold", false]
    ]
  );
  assert.match(rows[0].input.armoriq_policy.unenforced_reasons[0], /^ArmorIQ policy "codex-floor" blocked apply_patch/);
  assert.match(rows[1].input.armoriq_policy.unenforced_reasons[0], /^ArmorIQ policy "codex-floor" holds Bash/);
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
