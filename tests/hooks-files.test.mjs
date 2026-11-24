import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { hookGroups } from "../plugins/armorcodex/scripts/lib/hooks-file.mjs";

const PLUGIN = fileURLToPath(new URL("../plugins/armorcodex", import.meta.url));
const SHIPPED = ["hooks/hooks.json", ".codex/hooks.json"];

const events = (file) => Object.keys(JSON.parse(readFileSync(path.join(PLUGIN, file), "utf8")).hooks).sort();

test("every shipped hooks file and the installer register the same events, PostToolUseFailure included", () => {
  const installed = Object.keys(hookGroups("node /x/bootstrap.mjs router")).sort();
  assert.ok(installed.includes("PostToolUseFailure"));
  for (const file of SHIPPED) assert.deepEqual(events(file), installed, file);
});

function pluginCopy(t) {
  const root = mkdtempSync(path.join(os.tmpdir(), "armorcodex-nogit-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const plugin = path.join(root, "armorcodex");
  cpSync(PLUGIN, plugin, { recursive: true, filter: (src) => !src.startsWith(path.join(PLUGIN, "node_modules")) });
  mkdirSync(path.join(plugin, "node_modules"));
  for (const entry of readdirSync(path.join(PLUGIN, "node_modules"))) {
    if (entry.startsWith(".")) continue;
    symlinkSync(path.join(PLUGIN, "node_modules", entry), path.join(plugin, "node_modules", entry));
  }
  const { version } = JSON.parse(readFileSync(path.join(plugin, "package.json"), "utf8"));
  writeFileSync(path.join(plugin, "node_modules", ".armorcodex-installed"), version);
  return { root, plugin };
}

test("the repo-local hooks file starts ArmorCodex from a plugin copy outside git and from the checkout root", (t) => {
  const { root, plugin } = pluginCopy(t);
  const { hooks } = JSON.parse(readFileSync(path.join(plugin, ".codex", "hooks.json"), "utf8"));
  const env = {
    PATH: process.env.PATH,
    HOME: root,
    TMPDIR: os.tmpdir(),
    ARMORCODEX_DATA_DIR: path.join(root, "data"),
    ARMORCODEX_NO_AUTO_UPDATE: "1",
    ARMORIQ_USAGE_PING_DISABLED: "1",
    GIT_CEILING_DIRECTORIES: path.dirname(root)
  };
  for (const cwd of [plugin, path.join(plugin, "scripts", "lib"), fileURLToPath(new URL("..", import.meta.url))]) {
    for (const [event, groups] of Object.entries(hooks)) {
      for (const { command } of groups.flatMap((group) => group.hooks)) {
        const run = spawnSync("/bin/sh", ["-c", command], { cwd, env, input: "", encoding: "utf8" });
        assert.equal(run.status, 0, `${event} from ${cwd}: ${run.stderr}`);
      }
    }
  }
});
