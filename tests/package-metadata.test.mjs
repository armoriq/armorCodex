import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

function readJson(relativePath) {
  return JSON.parse(readFileSync(new URL(relativePath, import.meta.url), "utf8"));
}

test("release metadata uses the registry SDK and one ArmorCodex version", () => {
  const pkg = readJson("../plugins/armorcodex/package.json");
  const lock = readJson("../plugins/armorcodex/package-lock.json");
  const plugin = readJson("../plugins/armorcodex/.codex-plugin/plugin.json");
  const codexMarketplace = readJson("../.codex-plugin/marketplace.json");
  const agentsMarketplace = readJson("../.agents/plugins/marketplace.json");
  const lockedSdk = lock.packages["node_modules/@armoriq/sdk"];

  assert.equal(pkg.dependencies["@armoriq/sdk"], "^0.6.3");
  assert.equal(lock.packages[""].dependencies["@armoriq/sdk"], "^0.6.3");
  assert.equal(lockedSdk.version, "0.6.3");
  assert.match(lockedSdk.resolved, /^https:\/\/registry\.npmjs\.org\//);
  assert.match(lockedSdk.integrity, /^sha512-/);
  assert.equal(lockedSdk.link, undefined);
  assert.equal(
    Object.keys(lock.packages).some((key) => key.includes("armoriq-sdk-customer-ts")),
    false,
  );

  for (const version of [
    pkg.version,
    lock.version,
    lock.packages[""].version,
    plugin.version,
    codexMarketplace.metadata.version,
    codexMarketplace.plugins[0].version,
    agentsMarketplace.metadata.version,
    agentsMarketplace.plugins[0].version,
  ]) {
    assert.equal(version, "0.3.2");
  }
});
