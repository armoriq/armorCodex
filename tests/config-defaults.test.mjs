import test from "node:test";
import assert from "node:assert/strict";
import { loadConfig } from "../plugins/armorcodex/scripts/lib/config.mjs";

const PRODUCTION = {
  backendEndpoint: "https://api.armoriq.ai",
  iapEndpoint: "https://iap.armoriq.ai",
  proxyEndpoint: "https://proxy.armoriq.ai",
  csrgEndpoint: "https://iap.armoriq.ai",
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
