import assert from "node:assert/strict";
import {
  chmodSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

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
