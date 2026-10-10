import assert from "node:assert/strict";
import {
  chmodSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os, { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { spawnSync } from "node:child_process";
import { createRequire, syncBuiltinESMExports } from "node:module";
import test from "node:test";

test("a normal update adds the Stop and SessionEnd hooks to an existing ArmorCodex hooks file and leaves its other hooks unchanged", (t) => {
  const root = mkdtempSync(join(tmpdir(), "armorcodex-installer-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const home = join(root, "home");
  const codexDir = join(home, ".codex");
  const binDir = join(root, "bin");
  const hooksPath = join(codexDir, "hooks.json");
  mkdirSync(codexDir, { recursive: true });
  mkdirSync(binDir, { recursive: true });

  const existingHooks = {
    hooks: {
      SessionStart: [
        {
          matcher: "startup|resume",
          hooks: [
            {
              type: "command",
              command: "node /existing/armorcodex/scripts/bootstrap.mjs router",
              statusMessage: "Starting ArmorCodex",
            },
          ],
        },
      ],
      Notification: [
        {
          hooks: [
            { type: "command", command: "notify-send Codex" },
          ],
        },
      ],
    },
  };
  writeFileSync(hooksPath, `${JSON.stringify(existingHooks, null, 2)}\n`);

  for (const [name, body] of [
    ["codex", "#!/bin/sh\necho 'codex-cli 0.142.0'\n"],
    ["npm", "#!/bin/sh\nexit 0\n"],
  ]) {
    const path = join(binDir, name);
    writeFileSync(path, body);
    chmodSync(path, 0o755);
  }

  const installer = new URL("../install_armorcodex.sh", import.meta.url);
  const result = spawnSync("bash", [installer.pathname, "--update"], {
    cwd: root,
    encoding: "utf8",
    env: {
      ...process.env,
      HOME: home,
      PATH: `${binDir}${delimiter}${process.env.PATH}`,
      NO_COLOR: "1",
    },
  });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  const updatedHooks = JSON.parse(readFileSync(hooksPath, "utf8"));
  assert.deepEqual(updatedHooks.hooks.Notification, existingHooks.hooks.Notification);
  assert.ok(updatedHooks.hooks.Stop, "expected update to install the Stop hook");
  assert.match(
    updatedHooks.hooks.Stop[0].hooks[0].command,
    /armorcodex\/scripts\/bootstrap\.mjs router/i,
  );
  assert.deepEqual(updatedHooks.hooks.SessionStart, existingHooks.hooks.SessionStart);
  assert.match(
    updatedHooks.hooks.SessionEnd[0].hooks[0].command,
    /armorcodex\/scripts\/bootstrap\.mjs router/i,
  );
  assert.match(result.stdout, /added missing ArmorCodex Stop, SessionEnd hook\(s\)/);
});

test("an environment key cannot skip login or appear in installer instructions", (t) => {
  const root = mkdtempSync(join(tmpdir(), "armorcodex-login-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const installer = readFileSync(new URL("../install_armorcodex.sh", import.meta.url), "utf8");
  assert.match(connectStep(), /plugin_has_login\(\) \{[\s\S]*connect_to_armoriq\(\) \{/);
  const result = spawnSync("bash", ["-c", `
    section() { :; }
    err() { printf '%s\\n' "$1"; }
    ok() { printf '%s\\n' "$1"; }
    is_promptable() { return 1; }
    abort_install() { exit 17; }
    INSTALL_HOME="${new URL("..", import.meta.url).pathname}"
    PLUGIN_SUBDIR="plugins/armorcodex"
    ${connectStep()}
    connect_to_armoriq
  `], {
    encoding: "utf8",
    env: { PATH: process.env.PATH, HOME: root, ARMORIQ_API_KEY: "ignored-test-key" },
  });
  assert.equal(result.status, 17, result.stderr || result.stdout);
  assert.match(result.stdout, /armoriq-dev login --product armorcodex/);
  assert.doesNotMatch(result.stdout, /credentials already present|ARMORIQ_API_KEY/);
  assert.doesNotMatch(installer, /ARMORIQ_API_KEY/);
});

function connectStep() {
  const installer = readFileSync(new URL("../install_armorcodex.sh", import.meta.url), "utf8");
  const pick = (name) => installer.match(new RegExp(`${name}\\(\\) \\{[\\s\\S]*?\\n\\}\\n`))?.[0] ?? "";
  return [pick("plugin_has_login"), pick("connect_to_armoriq")].join("\n");
}

function runConnect(home) {
  return spawnSync("bash", ["-c", `
    section() { :; }
    err() { printf '%s\\n' "$1"; }
    ok() { printf '%s\\n' "$1"; }
    is_promptable() { return 1; }
    abort_install() { exit 17; }
    INSTALL_HOME="${new URL("..", import.meta.url).pathname}"
    PLUGIN_SUBDIR="plugins/armorcodex"
    ${connectStep()}
    connect_to_armoriq
  `], { encoding: "utf8", env: { PATH: process.env.PATH, HOME: home } });
}

test("only an armorcodex login the plugin loads skips the installer's login", (t) => {
  const requireSdk = createRequire(new URL("../plugins/armorcodex/package.json", import.meta.url));
  const { saveLoginProfile } = requireSdk("@armoriq/sdk-dev");
  const build = requireSdk("@armoriq/sdk-dev/dist/_build_env.js");
  const backend = build.ENDPOINTS[build.ARMORIQ_ENV].backend;
  const homes = {};
  for (const name of ["claudeOnly", "v1", "codex"]) {
    homes[name] = mkdtempSync(join(tmpdir(), `armorcodex-connect-${name}-`));
    t.after(() => rmSync(homes[name], { recursive: true, force: true }));
  }
  const save = (home, product) => {
    const real = os.homedir;
    os.homedir = () => home;
    syncBuiltinESMExports();
    try {
      saveLoginProfile({ backend, product, apiKey: "ak_test_connect", email: "a@example.test", userId: "user-a", orgId: "org-a" });
    } finally {
      os.homedir = real;
      syncBuiltinESMExports();
    }
  };
  save(homes.claudeOnly, "armorclaude");
  mkdirSync(join(homes.v1, ".armoriq"), { recursive: true });
  writeFileSync(join(homes.v1, ".armoriq", "credentials.json"), JSON.stringify({ apiKey: "ak_test_v1" }));
  save(homes.codex, "armorcodex");

  for (const name of ["claudeOnly", "v1"]) {
    const result = runConnect(homes[name]);
    assert.equal(result.status, 17, `${name}: ${result.stdout}${result.stderr}`);
    assert.match(result.stdout, /armoriq-dev login --product armorcodex/, name);
    assert.doesNotMatch(result.stdout, /already present|login for ArmorCodex found|connected/, name);
  }
  const codex = runConnect(homes.codex);
  assert.equal(codex.status, 0, codex.stdout + codex.stderr);
  assert.match(codex.stdout, /login for ArmorCodex found/);
});
