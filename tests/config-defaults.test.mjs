import test from "node:test";
import assert from "node:assert/strict";
import { loadConfig } from "../plugins/armorcodex/scripts/lib/config.mjs";

const PRODUCTION = {
  backendEndpoint: "https://api.armoriq.ai",
  iapEndpoint: "https://iap.armoriq.ai",
  proxyEndpoint: "https://proxy.armoriq.ai",
  csrgEndpoint: "https://iap.armoriq.ai",
};

const STAGING = {
  backendEndpoint: "https://staging-api.armoriq.ai",
  iapEndpoint: "https://iap-staging.armoriq.ai",
  proxyEndpoint: "https://cloud-run-proxy.armoriq.io",
  csrgEndpoint: "https://iap-staging.armoriq.ai",
};

const LOCAL = {
  backendEndpoint: "http://127.0.0.1:3000",
  iapEndpoint: "http://127.0.0.1:8080",
  proxyEndpoint: "http://127.0.0.1:3001",
  csrgEndpoint: "http://127.0.0.1:8080",
};

function endpoints(config) {
  return {
    backendEndpoint: config.backendEndpoint,
    iapEndpoint: config.iapEndpoint,
    proxyEndpoint: config.proxyEndpoint,
    csrgEndpoint: config.csrgEndpoint,
  };
}

test("production defaults match the SDK production endpoint table", () => {
  assert.deepEqual(endpoints(loadConfig({ ARMORIQ_ENV: "production" })), PRODUCTION);
});

test("no ARMORIQ_ENV means production", () => {
  const config = loadConfig({});
  assert.equal(config.useProduction, true);
  assert.deepEqual(endpoints(config), PRODUCTION);
});

test("the use_production option selects the same production defaults", () => {
  const config = loadConfig({ ARMORIQ_ENV: "local", CODEX_PLUGIN_OPTION_USE_PRODUCTION: "true" });
  assert.deepEqual(endpoints(config), PRODUCTION);
});

test("ARMORIQ_ENV=staging selects the SDK staging endpoints (#102)", () => {
  for (const value of ["staging", " Staging ", "STAGING"]) {
    const config = loadConfig({ ARMORIQ_ENV: value });
    assert.equal(config.useProduction, false, value);
    assert.deepEqual(endpoints(config), STAGING, value);
  }
});

test("ARMORIQ_ENV=local selects the SDK local endpoints, IAP on 8080 (#102)", () => {
  const config = loadConfig({ ARMORIQ_ENV: "local" });
  assert.equal(config.useProduction, false);
  assert.deepEqual(endpoints(config), LOCAL);
});

test("an unknown ARMORIQ_ENV falls back to production, as the SDK does", () => {
  for (const value of ["dev", "prod", "stage", ""]) {
    assert.deepEqual(endpoints(loadConfig({ ARMORIQ_ENV: value })), PRODUCTION, JSON.stringify(value));
  }
});

test("use_production=true wins over staging, and use_production=false without an env means local", () => {
  assert.deepEqual(
    endpoints(loadConfig({ ARMORIQ_ENV: "staging", CODEX_PLUGIN_OPTION_USE_PRODUCTION: "true" })),
    PRODUCTION
  );
  assert.deepEqual(endpoints(loadConfig({ ARMORCODEX_USE_PRODUCTION: "false" })), LOCAL);
  assert.deepEqual(
    endpoints(loadConfig({ ARMORIQ_ENV: "staging", ARMORCODEX_USE_PRODUCTION: "false" })),
    STAGING
  );
});

test("per-endpoint overrides still win over the staging table", () => {
  const config = loadConfig({
    ARMORIQ_ENV: "staging",
    BACKEND_ENDPOINT: "http://127.0.0.1:3930",
    ARMORCODEX_IAP_ENDPOINT: "http://127.0.0.1:3931",
    PROXY_ENDPOINT: "http://127.0.0.1:3932",
  });
  assert.deepEqual(endpoints(config), {
    backendEndpoint: "http://127.0.0.1:3930",
    iapEndpoint: "http://127.0.0.1:3931",
    proxyEndpoint: "http://127.0.0.1:3932",
    csrgEndpoint: "http://127.0.0.1:3931",
  });
});
