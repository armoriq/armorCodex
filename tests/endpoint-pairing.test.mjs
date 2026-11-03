import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { loadConfig, requireEndpoint } from "../plugins/armorcodex/scripts/lib/config.mjs";
import { getSdkClient } from "../plugins/armorcodex/scripts/lib/intent.mjs";
import { createCryptoPolicyService } from "../plugins/armorcodex/scripts/lib/crypto-policy.mjs";
import { createIapService } from "../plugins/armorcodex/scripts/lib/iap-service.mjs";

const ROWS = {
  production: ["https://api.armoriq.ai", "https://proxy.armoriq.ai", "https://iap.armoriq.ai"],
  staging: ["https://staging-api.armoriq.ai", "https://cloud-run-proxy.armoriq.io", "https://iap-staging.armoriq.ai"],
  local: ["http://127.0.0.1:3000", "http://127.0.0.1:3001", "http://127.0.0.1:8080"],
};
const CUSTOM = "http://127.0.0.1:3930";

const paired = (config) => [config.backendEndpoint, config.proxyEndpoint, config.iapEndpoint, config.csrgEndpoint];

test("a backend override from a known env pairs that env's proxy and IAP under every ARMORIQ_ENV (R4-3)", () => {
  for (const [row, [backend, proxy, iap]] of Object.entries(ROWS)) {
    for (const armoriqEnv of [undefined, "production", "staging", "local"]) {
      for (const variable of ["BACKEND_ENDPOINT", "ARMORCODEX_BACKEND_ENDPOINT"]) {
        const config = loadConfig({ ARMORIQ_ENV: armoriqEnv, [variable]: `${backend}/` });
        assert.deepEqual(paired(config), [backend, proxy, iap, iap], `${row} ${variable} ARMORIQ_ENV=${armoriqEnv}`);
      }
    }
  }
});

test("a custom backend gets no proxy, IAP or CSRG from any env", () => {
  for (const armoriqEnv of [undefined, "production", "staging", "local"]) {
    const config = loadConfig({ ARMORIQ_ENV: armoriqEnv, BACKEND_ENDPOINT: CUSTOM });
    assert.deepEqual(paired(config), [CUSTOM, "", "", ""], `ARMORIQ_ENV=${armoriqEnv}`);
  }
  for (const spelling of ["HTTPS://API.ARMORIQ.AI", "https://api.armoriq.ai:443", "http://localhost:3000"]) {
    assert.deepEqual(paired(loadConfig({ BACKEND_ENDPOINT: spelling })), [spelling, "", "", ""], spelling);
  }
});

test("explicit proxy, IAP and CSRG variables win over the pairing", () => {
  const config = loadConfig({
    BACKEND_ENDPOINT: CUSTOM,
    PROXY_ENDPOINT: "http://127.0.0.1:3931",
    ARMORCODEX_IAP_ENDPOINT: "http://127.0.0.1:3932",
  });
  assert.deepEqual(paired(config), [CUSTOM, "http://127.0.0.1:3931", "http://127.0.0.1:3932", "http://127.0.0.1:3932"]);

  const staging = loadConfig({
    BACKEND_ENDPOINT: ROWS.staging[0],
    ARMORCODEX_PROXY_ENDPOINT: "http://127.0.0.1:3933",
    CSRG_URL: "http://127.0.0.1:3934",
  });
  assert.deepEqual(paired(staging), [ROWS.staging[0], "http://127.0.0.1:3933", ROWS.staging[2], "http://127.0.0.1:3934"]);
});

test("requireEndpoint names the variable a custom backend is missing", () => {
  const config = loadConfig({ BACKEND_ENDPOINT: CUSTOM });
  assert.throws(() => requireEndpoint(config, "proxyEndpoint"), /http:\/\/127\.0\.0\.1:3930.*PROXY_ENDPOINT/);
  assert.throws(() => requireEndpoint(config, "iapEndpoint"), /IAP_ENDPOINT/);
  assert.throws(() => requireEndpoint(config, "csrgEndpoint"), /CSRG_URL.*IAP_ENDPOINT/);
  assert.equal(requireEndpoint(loadConfig({}), "proxyEndpoint"), ROWS.production[1]);
});

test("the SDK client is never built with an endpoint config did not resolve", () => {
  const noProxy = loadConfig({ BACKEND_ENDPOINT: CUSTOM, ARMORIQ_API_KEY: "ak_test_pairing", IAP_ENDPOINT: "http://127.0.0.1:3932" });
  assert.throws(() => getSdkClient(noProxy), /PROXY_ENDPOINT/);
  const noIap = loadConfig({ BACKEND_ENDPOINT: CUSTOM, ARMORIQ_API_KEY: "ak_test_pairing", PROXY_ENDPOINT: "http://127.0.0.1:3931" });
  assert.throws(() => getSdkClient(noIap), /IAP_ENDPOINT/);
});

test("crypto policy and CSRG verification refuse a custom backend without posting", async (t) => {
  const calls = [];
  t.mock.method(globalThis, "fetch", async (url) => {
    calls.push(String(url));
    throw new Error("unexpected fetch");
  });
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "armorcodex-pairing-"));
  const config = {
    ...loadConfig({ BACKEND_ENDPOINT: CUSTOM, ARMORCODEX_DATA_DIR: dataDir }),
    cryptoPolicyEnabled: true,
    csrgVerifyEnabled: true,
  };
  await assert.rejects(
    createCryptoPolicyService(config).issuePolicyToken({ policy: { rules: [] } }, {}),
    /IAP_ENDPOINT/
  );
  await assert.rejects(createIapService(config).verifyWithCsrg("/steps/[0]/action", {}, [], "t", {}), /IAP_ENDPOINT/);
  assert.deepEqual(calls, []);
});
