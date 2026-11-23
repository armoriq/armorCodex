import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { handlePreToolUse, handleSessionStart } from "../plugins/armorcodex/scripts/lib/engine.mjs";
import { localOnly } from "../plugins/armorcodex/scripts/lib/backend-posture.mjs";

process.env.ARMORCODEX_NO_AUTO_UPDATE = "1";

const NOT_SIGNED_IN =
  "Not signed in to ArmorIQ: only the local policy and intent plan apply; org policies, approvals and audit upload are off";
const MONITOR =
  "Monitor mode: the local policy still blocks; intent drift, org policy blocks and holds, and backend outages are allowed, not blocked";

async function backend(t, status) {
  const server = http.createServer((req, res) => {
    req.resume();
    req.on("end", () => res.writeHead(status, { "content-type": "application/json" }).end("{}"));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  return `http://127.0.0.1:${server.address().port}`;
}

async function configFor(t, overrides = {}) {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "armorcodex-banner-"));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  return {
    mode: "enforce",
    intentRequired: true,
    dataDir,
    policyFile: path.join(dataDir, "policy.json"),
    runtimeFile: path.join(dataDir, "runtime.json"),
    backendEndpoint: overrides.backendEndpoint ?? (await backend(t, 200)),
    apiKey: "ak_test_banner",
    sanitize: {},
    ...overrides
  };
}

async function banner(config) {
  const output = await handleSessionStart({ hook_event_name: "SessionStart", session_id: "s-banner", source: "startup" }, config);
  return output.hookSpecificOutput.additionalContext;
}

test("a signed-in enforcing session gets the plain banner", async (t) => {
  assert.equal(await banner(await configFor(t)), "ArmorCodex active (ENFORCING, intent=required)");
});

test("an enforcing session with no login says only the local policy and intent plan apply", async (t) => {
  assert.equal(
    await banner(await configFor(t, { apiKey: "", intentRequired: false })),
    `ArmorCodex active (ENFORCING, intent=optional). ${NOT_SIGNED_IN}.`
  );
});

test("a stored key the backend rejected is reported as local only", async (t) => {
  assert.equal(
    await banner(localOnly(await configFor(t))),
    "ArmorCodex active (ENFORCING, intent=required). ArmorIQ rejected the stored key: only the local policy and intent plan apply; org policies, approvals and audit upload are off until you sign in again."
  );
});

test("a key the backend rejects at session start is reported as local only", async (t) => {
  assert.equal(
    await banner(await configFor(t, { backendEndpoint: await backend(t, 401) })),
    "ArmorCodex active (ENFORCING, intent=required). ArmorIQ rejected the stored key: only the local policy and intent plan apply; org policies, approvals and audit upload are off until you sign in again."
  );
});

test("a backend that is down at session start is named, with what it blocks", async (t) => {
  assert.equal(
    await banner(await configFor(t, { backendEndpoint: await backend(t, 503) })),
    "ArmorCodex active (ENFORCING, intent=required). The ArmorIQ backend is not answering: every tool call except ArmorCodex's own tools is blocked until it answers."
  );
  assert.equal(
    await banner(await configFor(t, { mode: "monitor", backendEndpoint: await backend(t, 503) })),
    `ArmorCodex active (MONITORING, intent=required). ${MONITOR}.`
  );
});

test("monitor mode says what still blocks and what is only allowed", async (t) => {
  assert.equal(
    await banner(await configFor(t, { mode: "monitor" })),
    `ArmorCodex active (MONITORING, intent=required). ${MONITOR}.`
  );
  assert.equal(
    await banner(await configFor(t, { mode: "monitor", apiKey: "" })),
    `ArmorCodex active (MONITORING, intent=required). ${MONITOR}. ${NOT_SIGNED_IN}.`
  );
});

test("org policies switched off are named in the banner", async (t) => {
  assert.equal(
    await banner(await configFor(t, { policyV2Enabled: false })),
    "ArmorCodex active (ENFORCING, intent=required). Org policies are off (ARMORCODEX_POLICY_V2=false): only the local policy and intent plan apply."
  );
});

test("the local policy blocks in monitor mode, as the monitor banner says", async (t) => {
  const config = await configFor(t, { mode: "monitor", apiKey: "" });
  await writeFile(config.policyFile, JSON.stringify({ rules: [{ id: "policy1", action: "deny", tool: "bash" }] }));
  const decision = await handlePreToolUse(
    { session_id: "s-banner", tool_name: "Bash", tool_input: { command: "touch x" }, tool_use_id: "tu1" },
    config
  );
  assert.equal(decision?.hookSpecificOutput?.permissionDecision, "deny");
});
