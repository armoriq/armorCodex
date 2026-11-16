import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { sdkModule } from "../plugins/armorcodex/scripts/lib/sdk.mjs";

const require = createRequire(new URL("../plugins/armorcodex/package.json", import.meta.url));
const libDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "plugins", "armorcodex", "scripts", "lib");

const USED = {
  credentials: ["loadLoginContext"],
  client_identity: ["clientHeaders"],
  client: ["ArmorIQClient"],
  turn_latency: ["codexTurnLatencies", "turnLatencyPayloads"],
  usage_sync: ["MAX_BATCH_BYTES", "MAX_BATCH_ENTRIES", "MAX_BATCH_SNAPSHOTS", "usageCallRecords"],
  observability: ["ArmorIQTelemetryRuntime", "OtelSession"],
  _version: ["VERSION"],
};

test("every SDK module loaded by name serves the same export as the SDK root", () => {
  const root = require("@armoriq/sdk-dev");
  for (const [name, exports] of Object.entries(USED)) {
    const mod = sdkModule(name);
    assert.notEqual(mod, root, `${name} should load without the SDK root`);
    for (const key of exports) {
      assert.ok(root[key] !== undefined, `SDK root lacks ${key}`);
      assert.equal(mod[key], root[key], `${name}.${key}`);
    }
  }
});

test("every sdkModule call in scripts/lib is covered above", async () => {
  const names = new Set();
  for (const file of await readdir(libDir)) {
    const src = await readFile(path.join(libDir, file), "utf8");
    for (const [, name] of src.matchAll(/sdkModule\("(\w+)"\)/g)) names.add(name);
  }
  assert.deepEqual([...names].sort(), Object.keys(USED).sort());
});

test("an SDK module missing from the install falls back to the SDK root", () => {
  assert.equal(sdkModule("no_such_module"), require("@armoriq/sdk-dev"));
});
