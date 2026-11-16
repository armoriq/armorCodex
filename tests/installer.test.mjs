import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import test from "node:test";

function stubTools(binDir, codexVersion = "codex-cli 0.162.0") {
  for (const [name, body] of [
    ["codex", `#!/bin/sh\necho '${codexVersion}'\n`],
    ["npm", "#!/bin/sh\nexit 0\n"],
  ]) {
    writeFileSync(join(binDir, name), body);
    chmodSync(join(binDir, name), 0o755);
  }
}

function saveCodexLogin(home) {
  const file = join(home, ".armoriq", "credentials.json");
  mkdirSync(join(home, ".armoriq"), { recursive: true, mode: 0o700 });
  writeFileSync(file, JSON.stringify({ apiKey: "ak_test_update" }), { mode: 0o600 });
}

function runInstaller(root, home, binDir, flag = "--update", env = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn("bash", [new URL("../install_armorcodex.sh", import.meta.url).pathname, flag], {
      cwd: root,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        HOME: home,
        ARMORCODEX_INSTALL_HOME: join(home, ".armoriq", "armorCodex"),
        PATH: `${binDir}${delimiter}${process.env.PATH}`,
        NO_COLOR: "1",
        ...env,
      },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (status) => resolve({ status, stdout, stderr }));
  });
}

test("the installer finale prints the notice and claims it only when the ping is enabled", async (t) => {
  const notice = JSON.parse(readFileSync(new URL("./fixtures/install-ping-v1.json", import.meta.url))).notice;
  for (const [name, env, settings, enabled] of [
    ["missing settings", {}, undefined, true],
    ["DO_NOT_TRACK=1", { DO_NOT_TRACK: "1" }, undefined, false],
    ["DO_NOT_TRACK=true", { DO_NOT_TRACK: " TrUe " }, undefined, false],
    ["DO_NOT_TRACK=yes", { DO_NOT_TRACK: "yes" }, undefined, true],
    ["ARMORIQ_USAGE_PING_DISABLED=1", { ARMORIQ_USAGE_PING_DISABLED: "1" }, undefined, false],
    ["ARMORIQ_USAGE_PING_DISABLED=true", { ARMORIQ_USAGE_PING_DISABLED: " TRUE " }, undefined, false],
    ["ARMORIQ_USAGE_PING_DISABLED=yes", { ARMORIQ_USAGE_PING_DISABLED: " YeS " }, undefined, false],
    ["ARMORIQ_USAGE_PING_DISABLED=false", { ARMORIQ_USAGE_PING_DISABLED: "false" }, undefined, true],
    ["empty settings object", {}, "{}", true],
    ["usagePing=true", {}, '{"usagePing":true}', true],
    ["usagePing=false", {}, '{"usagePing":false}', false],
    ["non boolean usagePing", {}, '{"usagePing":"false"}', false],
    ["null settings", {}, "null", false],
    ["array settings", {}, "[]", false],
    ["primitive settings", {}, '"x"', false],
    ["malformed settings", {}, "{", false],
    ["unreadable settings", {}, "unreadable", false],
    ["backend outside the contract origins", { ARMORCODEX_BACKEND_ENDPOINT: "http://127.0.0.1:3000" }, undefined, false],
  ]) {
    await t.test(name, async () => {
      const root = mkdtempSync(join(tmpdir(), "armorcodex-install-notice-"));
      t.after(() => rmSync(root, { recursive: true, force: true }));
      const home = join(root, "home");
      const binDir = join(root, "bin");
      mkdirSync(home);
      mkdirSync(binDir);
      stubTools(binDir);
      writeFileSync(join(binDir, "git"), "#!/bin/sh\nexit 0\n");
      chmodSync(join(binDir, "git"), 0o755);
      saveCodexLogin(home);
      if (settings !== undefined) {
        const file = join(home, ".armoriq/settings.json");
        writeFileSync(file, settings === "unreadable" ? "{}" : settings);
        if (settings === "unreadable") chmodSync(file, 0);
      }
      const result = await runInstaller(root, home, binDir, "--force-install", {
        DO_NOT_TRACK: "",
        ARMORIQ_USAGE_PING_DISABLED: "",
        ...env,
      });
      assert.equal(result.status, 0, result.stderr || result.stdout);
      assert.equal(result.stdout.split("\n").filter((line) => line === notice).length, enabled ? 1 : 0);
      const marker = join(home, ".armoriq/reach/v1/armorcodex/notice-shown");
      assert.equal(existsSync(marker), enabled);
      if (enabled) assert.equal(lstatSync(marker).mode & 0o777, 0o600);
      const { hooks } = JSON.parse(readFileSync(join(home, ".codex/hooks.json"), "utf8"));
      const commands = Object.values(hooks).flatMap((groups) => groups.flatMap((group) => group.hooks.map((hook) => hook.command)));
      assert.deepEqual(commands, Array(6).fill(`node ${new URL("../plugins/armorcodex/scripts/bootstrap.mjs", import.meta.url).pathname} router`));
    });
  }
});

test("a normal update adds the Stop hook to an existing ArmorCodex hooks file", (t) => {
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
});
