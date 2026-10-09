import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

test("backfill without a login names the armorcodex login command", (t) => {
  const home = mkdtempSync(join(tmpdir(), "armorcodex-backfill-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const script = new URL("../plugins/armorcodex/scripts/backfill.mjs", import.meta.url).pathname;
  const run = spawnSync(process.execPath, [script, "--dry-run"], {
    encoding: "utf8",
    env: {
      PATH: process.env.PATH,
      NODE_OPTIONS: process.env.NODE_OPTIONS ?? "",
      HOME: home,
      CODEX_HOME: join(home, ".codex"),
    },
  });
  assert.equal(run.status, 1, run.stderr);
  assert.match(run.stderr, /armoriq-dev login --product armorcodex/);
  assert.doesNotMatch(run.stderr, /ARMORIQ_API_KEY/);
});
