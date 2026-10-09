import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire, syncBuiltinESMExports } from "node:module";
import { loadConfig } from "../plugins/armorcodex/scripts/lib/config.mjs";

const requireSdk = createRequire(
  new URL("../plugins/armorcodex/package.json", import.meta.url),
);
const { saveLoginProfile, saveProfile, loadLoginContext } =
  requireSdk("@armoriq/sdk-dev");
const build = requireSdk("@armoriq/sdk-dev/dist/_build_env.js");
const DEFAULT_BACKEND = build.ENDPOINTS[build.ARMORIQ_ENV].backend;
const LOCAL = "http://127.0.0.1:3920";
const KEY = "ak_test_savedlogin0000000000000000";

test("with ARMORIQ_ENV unset, the login the SDK's CLI saves by default is loaded", () => {
  withLogins([{ backend: DEFAULT_BACKEND }], () => {
    const config = loadConfig({});
    assert.equal(config.backendEndpoint, DEFAULT_BACKEND);
    assert.equal(config.apiKey, KEY);
    assert.equal(config.userId, "user-A");
    assert.ok(config.loginHistory?.events?.length);
  });
});

test("the manifest offers no API-key setting alongside the login profile", () => {
  const manifest = JSON.parse(
    fs.readFileSync(
      new URL("../plugins/armorcodex/.codex-plugin/plugin.json", import.meta.url),
      "utf8",
    ),
  );
  assert.equal(Object.hasOwn(manifest.userConfig, "api_key"), false);
});

function withLogins(records, fn) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "armorcodex-creds-"));
  assert.ok(home.startsWith(os.tmpdir()), home);
  const original = os.homedir;
  os.homedir = () => home;
  syncBuiltinESMExports();
  try {
    for (const record of records) {
      saveLoginProfile({
        apiKey: KEY,
        backend: DEFAULT_BACKEND,
        product: "armorcodex",
        email: "user@example.test",
        userId: "user-A",
        orgId: "personal-A",
        ...record,
      });
    }
    return fn(path.join(home, ".armoriq", "credentials.json"));
  } finally {
    os.homedir = original;
    syncBuiltinESMExports();
    fs.rmSync(home, { recursive: true, force: true });
  }
}

function assertUnavailable(config) {
  assert.equal(config.apiKey, "");
  assert.equal(config.orgId, "");
  assert.equal(config.userId, "");
  assert.equal(config.loggedInAt, "");
  assert.equal(config.loginHistory, null);
  assert.equal(config.observabilityEnabled, false);
  assert.equal(config.auditEnabled, false);
}

test("config exposes the accepted login key, owner, org and exact history snapshot", () => {
  withLogins([{}], () => {
    const login = loadLoginContext({ backend: DEFAULT_BACKEND, product: "armorcodex" });
    const config = loadConfig({});
    assert.equal(config.apiKey, KEY);
    assert.equal(config.orgId, login.profile.orgId);
    assert.equal(config.userId, login.profile.userId);
    assert.equal(config.loggedInAt, login.profile.loggedInAt);
    assert.deepEqual(config.loginHistory, login.loginHistory);
    assert.equal(config.observabilityEnabled, true);
  });
});

test("backend scope uses the shared URL-origin comparison", () => {
  for (const backend of [
    `${DEFAULT_BACKEND}/`,
    DEFAULT_BACKEND.toUpperCase(),
    `${DEFAULT_BACKEND}:443/`,
    `${DEFAULT_BACKEND}/api?query=1`,
  ]) {
    withLogins([{ backend }], () =>
      assert.equal(loadConfig({}).apiKey, KEY, backend),
    );
  }
});

test("another active backend or product cannot replace the Codex profile", () => {
  withLogins(
    [
      {},
      { product: "armorclaude", userId: "user-B", apiKey: "ak_test_claude" },
      { backend: LOCAL, userId: "user-C", apiKey: "ak_test_local" },
    ],
    () => {
      const config = loadConfig({});
      assert.equal(config.apiKey, KEY);
      assert.equal(config.userId, "user-A");
      assert.equal(config.orgId, "personal-A");
      assert.equal(loadConfig({ BACKEND_ENDPOINT: LOCAL }).userId, "user-C");
    },
  );
});

test("local, other-product and lookalike-host logins are unavailable on the default backend", () => {
  for (const record of [
    { backend: LOCAL },
    { product: "armorclaude" },
    { backend: `${DEFAULT_BACKEND}.evil.test` },
  ]) {
    withLogins([record], () => assertUnavailable(loadConfig({})));
  }
});

test("caller-selected keys and user identity cannot override an accepted login", () => {
  withLogins([{}], () => {
    const config = loadConfig({
      ARMORIQ_API_KEY: "ak_test_env",
      CODEX_PLUGIN_OPTION_API_KEY: "ak_test_codex_option",
      CLAUDE_PLUGIN_OPTION_API_KEY: "ak_test_claude_option",
      ARMORCODEX_USER_ID: "caller-user",
    });
    assert.equal(config.apiKey, KEY);
    assert.equal(config.userId, "user-A");
  });
});

test("environment and plugin keys cannot connect without a matching login", () => {
  withLogins([], () =>
    assertUnavailable(
      loadConfig({
        ARMORIQ_API_KEY: "ak_test_env",
        CODEX_PLUGIN_OPTION_API_KEY: "ak_test_option",
      }),
    ),
  );
});

test("missing or invalid loggedInAt never falls back to savedAt", () => {
  for (const value of [undefined, "invalid", "2026-10-09T10:00:00Z"]) {
    withLogins([{}], (file) => {
      const doc = JSON.parse(fs.readFileSync(file, "utf8"));
      doc.profiles[doc.active].loggedInAt = value;
      fs.writeFileSync(file, JSON.stringify(doc));
      assertUnavailable(loadConfig({}));
    });
  }
});

test("missing, truncated and owner-mismatched histories are unavailable", () => {
  for (const mutate of [
    (doc) => delete doc.loginHistory[doc.active],
    (doc) => doc.loginHistory[doc.active].events.pop(),
    (doc) => (doc.profiles[doc.active].userId = "other-user"),
  ]) {
    withLogins([{}], (file) => {
      const doc = JSON.parse(fs.readFileSync(file, "utf8"));
      mutate(doc);
      fs.writeFileSync(file, JSON.stringify(doc));
      assertUnavailable(loadConfig({}));
    });
  }
});

test("an unknown history stays unknown in the accepted config context", () => {
  withLogins([{}], (file) => {
    const doc = JSON.parse(fs.readFileSync(file, "utf8"));
    doc.historyOrigin = "unknown";
    doc.loginHistory[doc.active].origin = "unknown";
    fs.writeFileSync(file, JSON.stringify(doc));
    const config = loadConfig({});
    assert.equal(config.userId, "user-A");
    assert.equal(config.loginHistory.origin, "unknown");
    assert.deepEqual(
      config.loginHistory.events,
      doc.loginHistory[doc.active].events,
    );
  });
});

test("A to B to A and same-user rotation retain every login transition", () => {
  withLogins(
    [{}, { userId: "user-B" }, {}, { apiKey: "ak_test_rotated" }],
    () => {
      const config = loadConfig({});
      assert.equal(config.apiKey, "ak_test_rotated");
      assert.equal(config.userId, "user-A");
      assert.deepEqual(
        config.loginHistory.events.map((event) => event.userId),
        ["user-A", "user-B", "user-A", "user-A"],
      );
      assert.equal(config.loggedInAt, config.loginHistory.events.at(-1).at);
    },
  );
});

test("a non-login rewrite preserves the exposed login instant and history", () => {
  withLogins([{}], () => {
    const login = loadLoginContext({ backend: DEFAULT_BACKEND, product: "armorcodex" });
    saveProfile({
      ...login.profile,
      apiKey: "ak_test_rotated",
      orgId: "personal-new",
    });
    const config = loadConfig({});
    assert.equal(config.apiKey, "ak_test_rotated");
    assert.equal(config.orgId, "personal-new");
    assert.equal(config.loggedInAt, login.profile.loggedInAt);
    assert.deepEqual(config.loginHistory, login.loginHistory);
  });
});

test("config reads credential identity and history from one file read", () => {
  withLogins([{}], (file) => {
    const original = fs.readFileSync;
    let reads = 0;
    fs.readFileSync = function (target, ...args) {
      if (String(target) === file) reads += 1;
      return original.call(this, target, ...args);
    };
    syncBuiltinESMExports();
    try {
      assert.equal(loadConfig({}).userId, "user-A");
      assert.equal(reads, 1);
    } finally {
      fs.readFileSync = original;
      syncBuiltinESMExports();
    }
  });
});
