import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { buildAuthHeaders } from "../plugins/armorcodex/scripts/lib/common.mjs";
import { CLIENT } from "../plugins/armorcodex/scripts/lib/client-identity.mjs";
import { loadConfig } from "../plugins/armorcodex/scripts/lib/config.mjs";
import { signIn, withHome } from "./helpers/login.mjs";

const BACKEND = "https://api.armoriq.ai";
const STAGING = "https://staging-api.armoriq.ai";

function home(t) {
  const dir = mkdtempSync(join(tmpdir(), "armorcodex-creds-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function credentialsFile(dir, body) {
  mkdirSync(join(dir, ".armoriq"), { recursive: true });
  writeFileSync(join(dir, ".armoriq", "credentials.json"), typeof body === "string" ? body : JSON.stringify(body));
}

const load = (dir, env = {}) => withHome(dir, () => loadConfig(env));

test("a version 2 document yields this product's key for this backend", (t) => {
  const dir = home(t);
  signIn(dir, { backend: BACKEND, apiKey: "ak_live_codex" });
  const config = load(dir);
  assert.equal(config.backendEndpoint, BACKEND, "production is the default backend");
  assert.equal(config.apiKey, "ak_live_codex");
  assert.equal(config.orgId, "org-1");
});

test("a version 2 document never leaks another product's or backend's key", (t) => {
  const dir = home(t);
  signIn(dir, { backend: STAGING, apiKey: "ak_test_codex_staging" });
  assert.equal(load(dir).apiKey, "", "a staging login is not used for production");
  assert.equal(load(dir, { ARMORIQ_ENV: "staging" }).apiKey, "ak_test_codex_staging");
});

test("a trailing slash or path on the backend still matches the profile", (t) => {
  const dir = home(t);
  signIn(dir, { backend: BACKEND, apiKey: "ak_live_codex" });
  assert.equal(load(dir, { ARMORCODEX_BACKEND_ENDPOINT: "https://api.armoriq.ai/" }).apiKey, "ak_live_codex");
});

test("the pre-version-2 flat document still resolves", (t) => {
  const dir = home(t);
  credentialsFile(dir, { apiKey: "ak_live_flat", orgId: "org-flat" });
  const config = load(dir);
  assert.equal(config.apiKey, "ak_live_flat");
  assert.equal(config.orgId, "org-flat");
});

test("a malformed or empty document yields no key rather than throwing", (t) => {
  for (const body of ["nonsense", "null", "{}", '{"version":2}', '{"version":2,"profiles":7}', '{"apiKey":7}']) {
    const dir = home(t);
    credentialsFile(dir, body);
    assert.equal(load(dir).apiKey, "", body);
  }
});

test("backend requests carry the client version so the backend can see this build", () => {
  const headers = buildAuthHeaders({ apiKey: "ak_live_codex" });
  assert.equal(headers["X-ArmorIQ-Client"], `armorcodex/${CLIENT.version}`);
});
