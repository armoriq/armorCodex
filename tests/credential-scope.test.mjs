import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { createRequire, syncBuiltinESMExports } from "node:module";
import os from "node:os";
import path from "node:path";
import { loadConfig } from "../plugins/armorcodex/scripts/lib/config.mjs";

const requireSdk = createRequire(new URL("../plugins/armorcodex/package.json", import.meta.url));
const { saveLoginProfile } = requireSdk("@armoriq/sdk-dev");

const PROD = "https://api.armoriq.ai";
const LOCAL = "http://127.0.0.1:3920";
const KEY = "ak_test_savedlogin0000000000000000";

function withSavedLogin(record, fn) {
  const home = mkdtempSync(path.join(os.tmpdir(), "armorcodex-creds-"));
  const real = os.homedir;
  os.homedir = () => home;
  syncBuiltinESMExports();
  try {
    assert.ok(os.homedir().startsWith(os.tmpdir()), os.homedir());
    saveLoginProfile({
      backend: PROD,
      product: "armorcodex",
      apiKey: KEY,
      email: "a@example.test",
      userId: "user-a",
      orgId: "org-a",
      ...record
    });
    return fn();
  } finally {
    os.homedir = real;
    syncBuiltinESMExports();
  }
}

test("a login for armorcodex on the configured backend is used", () => {
  const config = withSavedLogin({}, () => loadConfig({}));
  assert.equal(config.backendEndpoint, PROD);
  assert.equal(config.apiKey, KEY);
  assert.equal(config.observabilityEnabled, true);
});

test("the saved backend matches after URL normalization", () => {
  for (const backend of [`${PROD}/`, "HTTPS://API.ARMORIQ.AI", "https://api.armoriq.ai:443/"]) {
    const config = withSavedLogin({ backend }, () => loadConfig({}));
    assert.equal(config.apiKey, KEY, backend);
  }
});

test("a login minted on a local backend is not sent to production", () => {
  const config = withSavedLogin({ backend: LOCAL }, () => loadConfig({}));
  assert.equal(config.backendEndpoint, PROD);
  assert.equal(config.apiKey, "");
  assert.equal(config.observabilityEnabled, false);
  assert.equal(config.auditEnabled, false);
});

test("the same local login is used when the plugin calls that backend", () => {
  const config = withSavedLogin({ backend: LOCAL }, () => loadConfig({ BACKEND_ENDPOINT: LOCAL }));
  assert.equal(config.apiKey, KEY);
});

test("a login for another product is not used", () => {
  const config = withSavedLogin({ product: "armorclaude" }, () => loadConfig({}));
  assert.equal(config.apiKey, "");
});

test("a lookalike backend host does not match", () => {
  const config = withSavedLogin({ backend: "https://api.armoriq.ai.evil.test" }, () => loadConfig({}));
  assert.equal(config.apiKey, "");
});

test("ARMORIQ_API_KEY is used over the saved login", () => {
  const config = withSavedLogin({ product: "armorclaude", backend: LOCAL }, () =>
    loadConfig({ ARMORIQ_API_KEY: "ak_live_envkey000000000000000000" })
  );
  assert.equal(config.apiKey, "ak_live_envkey000000000000000000");
});
