import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { loadConfig } from "../plugins/armorcodex/scripts/lib/config.mjs";

const { ARMORIQ_ENV: BUILD_ENV } = createRequire(
  new URL("../plugins/armorcodex/package.json", import.meta.url),
)("@armoriq/sdk-dev/dist/_build_env.js");

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

const BY_ENV = { production: PRODUCTION, staging: STAGING, local: LOCAL };

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

test("no ARMORIQ_ENV means the environment the SDK was built for", () => {
  const config = loadConfig({});
  assert.equal(config.useProduction, BUILD_ENV === "production");
  assert.deepEqual(endpoints(config), BY_ENV[BUILD_ENV]);
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

test("ARMORIQ_ENV takes armorClaude's names and refuses anything else", () => {
  assert.deepEqual(endpoints(loadConfig({ ARMORIQ_ENV: " " })), BY_ENV[BUILD_ENV]);
  assert.deepEqual(endpoints(loadConfig({ ARMORIQ_ENV: "prod" })), PRODUCTION);
  assert.deepEqual(endpoints(loadConfig({ ARMORIQ_ENV: "Stage" })), endpoints(loadConfig({ ARMORIQ_ENV: "staging" })));
  for (const value of ["dev", "development", "test"]) {
    assert.deepEqual(endpoints(loadConfig({ ARMORIQ_ENV: value })), LOCAL, value);
  }
  for (const value of ["prdo", "qa", "constructor"]) {
    assert.throws(() => loadConfig({ ARMORIQ_ENV: value }), new RegExp(`ARMORIQ_ENV=${value} is not one of production, prod, staging`));
  }
});

test("use_production=true wins over staging, and use_production=false only turns production into local", () => {
  assert.deepEqual(
    endpoints(loadConfig({ ARMORIQ_ENV: "staging", CODEX_PLUGIN_OPTION_USE_PRODUCTION: "true" })),
    PRODUCTION
  );
  assert.deepEqual(
    endpoints(loadConfig({ ARMORCODEX_USE_PRODUCTION: "false" })),
    BUILD_ENV === "production" ? LOCAL : BY_ENV[BUILD_ENV]
  );
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
