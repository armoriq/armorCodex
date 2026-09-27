import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadConfig } from "../plugins/armorcodex/scripts/lib/config.mjs";
import { handleSessionStart } from "../plugins/armorcodex/scripts/lib/engine.mjs";

const PROD = "https://api.armoriq.ai";
const LOCAL = "http://127.0.0.1:3920";
const KEY = "ak_test_savedlogin0000000000000000";

function withSavedLogin(record, fn) {
  const home = mkdtempSync(path.join(os.tmpdir(), "armorcodex-creds-"));
  const file = path.join(home, ".armoriq", "credentials.json");
  assert.ok(file.startsWith(os.tmpdir()), file);
  mkdirSync(path.dirname(file));
  writeFileSync(file, JSON.stringify({ apiKey: KEY, ...record }));
  const saved = process.env.HOME;
  process.env.HOME = home;
  try {
    assert.equal(os.homedir(), home);
    return fn();
  } finally {
    process.env.HOME = saved;
  }
}

test("a login for armorcodex on the configured backend is used", () => {
  const config = withSavedLogin({ product: "armorcodex", backend: PROD }, () => loadConfig({}));
  assert.equal(config.backendEndpoint, PROD);
  assert.equal(config.apiKey, KEY);
  assert.equal(config.ignoredSavedCredential, null);
  assert.equal(config.observabilityEnabled, true);
});

test("the saved backend matches after URL normalization", () => {
  for (const backend of [`${PROD}/`, "HTTPS://API.ARMORIQ.AI", "https://api.armoriq.ai:443/"]) {
    const config = withSavedLogin({ product: "armorcodex", backend }, () => loadConfig({}));
    assert.equal(config.apiKey, KEY, backend);
  }
});

test("a login minted on a local backend is not sent to production", () => {
  const config = withSavedLogin({ product: "armorcodex", backend: LOCAL }, () => loadConfig({}));
  assert.equal(config.backendEndpoint, PROD);
  assert.equal(config.apiKey, "");
  assert.equal(config.observabilityEnabled, false);
  assert.equal(config.auditEnabled, false);
  assert.deepEqual(config.ignoredSavedCredential, { product: "armorcodex", backend: LOCAL });
});

test("the same local login is used when the plugin calls that backend", () => {
  const config = withSavedLogin({ product: "armorcodex", backend: LOCAL }, () =>
    loadConfig({ BACKEND_ENDPOINT: LOCAL })
  );
  assert.equal(config.apiKey, KEY);
});

test("a login for another product is not used", () => {
  const config = withSavedLogin({ product: "armorclaude", backend: PROD }, () => loadConfig({}));
  assert.equal(config.apiKey, "");
  assert.deepEqual(config.ignoredSavedCredential, { product: "armorclaude", backend: PROD });
});

test("a lookalike backend host does not match", () => {
  const config = withSavedLogin(
    { product: "armorcodex", backend: "https://api.armoriq.ai.evil.test" },
    () => loadConfig({})
  );
  assert.equal(config.apiKey, "");
});

test("a login that recorded no product or backend is not used", () => {
  const config = withSavedLogin({}, () => loadConfig({}));
  assert.equal(config.apiKey, "");
  assert.deepEqual(config.ignoredSavedCredential, { product: "", backend: "" });
});

test("ARMORIQ_API_KEY is used and the saved login is not read", () => {
  const config = withSavedLogin({ product: "armorclaude", backend: LOCAL }, () =>
    loadConfig({ ARMORIQ_API_KEY: "ak_live_envkey000000000000000000" })
  );
  assert.equal(config.apiKey, "ak_live_envkey000000000000000000");
  assert.equal(config.ignoredSavedCredential, null);
});

test("SessionStart names the ignored login and the login command", async () => {
  const dataDir = mkdtempSync(path.join(os.tmpdir(), "armorcodex-creds-banner-"));
  const output = await handleSessionStart(
    { hook_event_name: "SessionStart", session_id: "creds-banner-1" },
    {
      mode: "enforce",
      intentRequired: true,
      ignoredSavedCredential: { product: "armorcodex", backend: LOCAL },
      backendEndpoint: PROD,
      dataDir,
      policyFile: path.join(dataDir, "policy.json"),
      runtimeFile: path.join(dataDir, "runtime.json"),
      apiKey: "",
      debug: false
    }
  );
  const ctx = output?.hookSpecificOutput?.additionalContext || "";
  assert.match(
    ctx,
    /is for armorcodex on http:\/\/127\.0\.0\.1:3920, not armorcodex on https:\/\/api\.armoriq\.ai/
  );
  assert.match(ctx, /armoriq login --product armorcodex/);
});
