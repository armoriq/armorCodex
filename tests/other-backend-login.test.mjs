import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { signIn } from "./helpers/login.mjs";

const router = fileURLToPath(new URL("../plugins/armorcodex/scripts/hook-router.mjs", import.meta.url));
const PRODUCTION = "https://api.armoriq.ai";
const STAGING = "https://staging-api.armoriq.ai";

function sessionStart(t, logins, env = {}) {
  const home = mkdtempSync(path.join(tmpdir(), "armorcodex-otherlogin-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  for (const backend of logins) signIn(home, { backend, apiKey: "ak_test_otherlogin" });
  const result = spawnSync(process.execPath, [router], {
    input: JSON.stringify({ hook_event_name: "SessionStart", session_id: "other-login", source: "startup" }),
    encoding: "utf8",
    timeout: 30_000,
    env: {
      PATH: process.env.PATH,
      HOME: home,
      CODEX_HOME: path.join(home, ".codex"),
      ARMORCODEX_DATA_DIR: path.join(home, "data"),
      ARMORCODEX_OBSERVABILITY_DISABLED: "1",
      ARMORCODEX_USAGE_SYNC_DISABLED: "1",
      ARMORCODEX_AUDIT_ENABLED: "false",
      ...env,
    },
  });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

test("a dev-channel staging login left behind is named at SessionStart when the backend is production", (t) => {
  const output = sessionStart(t, [STAGING]);
  assert.match(output.hookSpecificOutput.additionalContext, /^ArmorCodex active/);
  assert.match(output.systemMessage, /no ArmorIQ login for https:\/\/api\.armoriq\.ai, only for staging-api\.armoriq\.ai/);
  assert.match(output.systemMessage, /armoriq login --product armorcodex/);
  assert.match(output.systemMessage, /set ARMORIQ_ENV=staging to use the staging-api\.armoriq\.ai login\.$/);
});

test("with ARMORIQ_ENV=staging and only a production login, SessionStart points back to production", (t) => {
  const output = sessionStart(t, [PRODUCTION], { ARMORIQ_ENV: "staging" });
  assert.match(output.systemMessage, /no ArmorIQ login for https:\/\/staging-api\.armoriq\.ai, only for api\.armoriq\.ai/);
  assert.match(output.systemMessage, /set ARMORIQ_ENV=production to use the api\.armoriq\.ai login\.$/);
});

test("SessionStart says nothing extra with a login for its own backend, or with no login at all", (t) => {
  assert.equal(sessionStart(t, [PRODUCTION, STAGING]).systemMessage, undefined);
  assert.equal(sessionStart(t, []).systemMessage, undefined);
  assert.equal(sessionStart(t, [STAGING], { ARMORIQ_ENV: "staging" }).systemMessage, undefined);
});
