import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire, syncBuiltinESMExports } from "node:module";

const requireSdk = createRequire(new URL("../../plugins/armorcodex/package.json", import.meta.url));
const { profileName } = requireSdk("@armoriq/sdk-dev");

/** Write an armorcodex login for `backend` into `home`, appending its login event at `at`. */
export function signIn(home, { backend, apiKey, userId = "user-login", at = new Date().toISOString(), origin = "fresh" }) {
  assert.ok(home.startsWith(os.tmpdir()), home);
  const file = path.join(home, ".armoriq", "credentials.json");
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const doc = fs.existsSync(file)
    ? JSON.parse(fs.readFileSync(file, "utf8"))
    : { version: 2, active: null, profiles: {}, historyOrigin: origin, loginHistory: {} };
  const name = profileName(backend, "armorcodex");
  const history = doc.loginHistory[name] ?? { id: randomUUID(), origin, events: [] };
  history.events.push({ sequence: history.events.length + 1, at, userId });
  doc.loginHistory[name] = history;
  doc.profiles[name] = {
    backend: new URL(backend).origin,
    product: "armorcodex",
    apiKey,
    email: "dev@example.com",
    userId,
    orgId: "org-1",
    loggedInAt: at,
    savedAt: at
  };
  doc.active = name;
  fs.writeFileSync(file, `${JSON.stringify(doc, null, 2)}\n`, { mode: 0o600 });
  return home;
}

export function withHome(home, fn) {
  const original = os.homedir;
  os.homedir = () => home;
  syncBuiltinESMExports();
  try {
    return fn();
  } finally {
    os.homedir = original;
    syncBuiltinESMExports();
  }
}
