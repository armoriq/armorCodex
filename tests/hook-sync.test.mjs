import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  HOOK_SYNC_STATE_FILENAME,
  recordSyncResult,
  scheduleHookSync,
  syncOurHooks
} from "../plugins/armorcodex/scripts/lib/hook-sync.mjs";
import { hookGroups, routerCommand } from "../plugins/armorcodex/scripts/lib/hooks-file.mjs";
import { autoUpdate } from "../plugins/armorcodex/scripts/lib/update-apply.mjs";

const OTHER_TOOL = [{ matcher: "Bash", hooks: [{ type: "command", command: "/opt/other-tool/on-end", timeout: 30 }] }];

function scratch(t) {
  const root = mkdtempSync(join(tmpdir(), "armorcodex-hook-sync-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

function pre039Hooks(bootstrapPath, extra = {}) {
  const hooks = hookGroups(routerCommand(bootstrapPath));
  hooks.SessionEnd = { hooks: [{ ...hooks.SessionEnd.hooks[0], timeout: 30 }] };
  const file = { hooks: Object.fromEntries(Object.entries(hooks).map(([event, group]) => [event, [group]])) };
  file.hooks.SessionEnd = [...OTHER_TOOL, ...file.hooks.SessionEnd];
  return { ...file, ...extra };
}

function fakeCodex(root, hooksFile, { batchWrite = "ok" } = {}) {
  const state = join(root, "trust-state.json");
  const calls = join(root, "calls.log");
  const bin = join(root, "codex");
  writeFileSync(
    bin,
    `#!/usr/bin/env node
const fs = require("node:fs");
const crypto = require("node:crypto");
const hooksFile = ${JSON.stringify(hooksFile)};
const stateFile = ${JSON.stringify(state)};
const mode = ${JSON.stringify(batchWrite)};
fs.appendFileSync(${JSON.stringify(calls)}, process.argv.slice(2).join(" ") + "\\n");
const snake = (s) => s.replace(/[A-Z]/g, (c, i) => (i ? "_" : "") + c.toLowerCase());
const camel = (s) => s[0].toLowerCase() + s.slice(1);
const trust = () => (fs.existsSync(stateFile) ? JSON.parse(fs.readFileSync(stateFile, "utf8")) : {});
function listed() {
  const state = trust();
  const config = JSON.parse(fs.readFileSync(hooksFile, "utf8"));
  const out = [];
  for (const [event, groups] of Object.entries(config.hooks)) {
    groups.forEach((group, g) => group.hooks.forEach((hook, h) => {
      const key = hooksFile + ":" + snake(event) + ":" + g + ":" + h;
      const currentHash = "sha256:" + crypto.createHash("sha256").update(JSON.stringify({ matcher: group.matcher ?? null, hook })).digest("hex");
      const trusted = state[key]?.trusted_hash;
      out.push({ key, eventName: camel(event), handlerType: "command", command: hook.command, sourcePath: hooksFile, currentHash,
        trustStatus: trusted === undefined ? "untrusted" : trusted === currentHash ? "trusted" : "modified" });
    }));
  }
  return out;
}
let buffer = "";
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let i;
  while ((i = buffer.indexOf("\\n")) !== -1) {
    const msg = JSON.parse(buffer.slice(0, i));
    buffer = buffer.slice(i + 1);
    if (msg.id === undefined) continue;
    const reply = (result) => process.stdout.write(JSON.stringify({ id: msg.id, result }) + "\\n");
    if (msg.method === "initialize") reply({});
    else if (msg.method === "hooks/list") reply({ data: [{ cwd: msg.params.cwds[0], hooks: listed() }] });
    else if (msg.method === "config/batchWrite") {
      fs.appendFileSync(${JSON.stringify(calls)}, "batchWrite " + JSON.stringify(msg.params.edits) + "\\n");
      const value = Object.assign({}, ...msg.params.edits.map((edit) => edit.value));
      const isRestore = Object.values(value).every((v) => fs.readFileSync(${JSON.stringify(join(root, "prior-hashes.json"))}, "utf8").includes(v.trusted_hash));
      if (mode === "error" && !isRestore) { process.stdout.write(JSON.stringify({ id: msg.id, error: { message: "config is read-only" } }) + "\\n"); continue; }
      if (mode === "ignored" && !isRestore) { reply({ status: "ok" }); continue; }
      fs.writeFileSync(stateFile, JSON.stringify({ ...trust(), ...value }));
      reply({ status: "ok" });
    }
  }
});
`
  );
  chmodSync(bin, 0o755);
  return {
    bin,
    state: () => (existsSync(state) ? JSON.parse(readFileSync(state, "utf8")) : {}),
    calls: () => (existsSync(calls) ? readFileSync(calls, "utf8") : "")
  };
}

async function listVia(bin, hooksFile, cwd) {
  const { appServer } = await import("../plugins/armorcodex/scripts/lib/hook-trust.mjs");
  const server = appServer({ codexBin: bin, env: process.env, timeoutMs: 5000 });
  try {
    await server.request("initialize", {});
    return (await server.request("hooks/list", { cwds: [cwd] })).data[0].hooks;
  } finally {
    server.close();
  }
}

async function setup(t, options = {}) {
  const root = scratch(t);
  const codexHome = join(root, ".codex");
  mkdirSync(codexHome, { recursive: true });
  const hooksFile = join(codexHome, "hooks.json");
  const bootstrapPath = join(root, ".armoriq", "armorCodex", "plugins", "armorcodex", "scripts", "bootstrap.mjs");
  const original = `${JSON.stringify(options.file ?? pre039Hooks(bootstrapPath), null, 2)}\n`;
  writeFileSync(hooksFile, original);
  const codex = fakeCodex(root, hooksFile, options);
  const listedBefore = await listVia(codex.bin, hooksFile, root);
  const trusted = Object.fromEntries(
    listedBefore
      .filter((hook) => options.trustOthers || hook.command === routerCommand(bootstrapPath))
      .filter((hook) => options.untrusted !== hook.eventName)
      .map((hook) => [hook.key, { trusted_hash: hook.currentHash }])
  );
  writeFileSync(join(root, "trust-state.json"), JSON.stringify(trusted));
  writeFileSync(join(root, "prior-hashes.json"), JSON.stringify(trusted));
  return { root, hooksFile, bootstrapPath, original, codex, trusted };
}

function ourStatuses(hooks, bootstrapPath) {
  return hooks.filter((hook) => hook.command === routerCommand(bootstrapPath)).map((hook) => `${hook.eventName}:${hook.trustStatus}`);
}

test("a stale ArmorCodex entry is rewritten to the current definition and re-trusted, other hooks untouched", async (t) => {
  const { root, hooksFile, bootstrapPath, original, codex } = await setup(t, { trustOthers: true });
  const otherBefore = (await listVia(codex.bin, hooksFile, root)).find((hook) => hook.command === "/opt/other-tool/on-end");

  const result = await syncOurHooks({ hooksFile, bootstrapPath, codexBin: codex.bin, cwd: root });

  assert.equal(result.status, "synced", result.reason);
  assert.deepEqual(result.refreshed, ["SessionEnd"]);
  const after = JSON.parse(readFileSync(hooksFile, "utf8"));
  assert.deepEqual(after.hooks.SessionEnd, [...OTHER_TOOL, { hooks: [{ type: "command", command: routerCommand(bootstrapPath), timeout: 3 }] }]);
  const expected = JSON.parse(original);
  expected.hooks.SessionEnd[1].hooks[0].timeout = 3;
  assert.equal(readFileSync(hooksFile, "utf8"), `${JSON.stringify(expected, null, 2)}\n`);

  const listed = await listVia(codex.bin, hooksFile, root);
  assert.equal(ourStatuses(listed, bootstrapPath).length, 7);
  assert.ok(ourStatuses(listed, bootstrapPath).every((status) => status.endsWith(":trusted")), ourStatuses(listed, bootstrapPath).join(" "));
  const otherAfter = listed.find((hook) => hook.command === "/opt/other-tool/on-end");
  assert.deepEqual(otherAfter, otherBefore);
  assert.match(codex.calls(), /batchWrite .*session_end:1:0/);
  assert.doesNotMatch(codex.calls(), /batchWrite .*session_end:0:0/, "the other tool's hook is never trusted by ArmorCodex");
});

test("nothing is written and Codex is not started when every entry is already current", async (t) => {
  const root = scratch(t);
  const hooksFile = join(root, "hooks.json");
  const bootstrapPath = "/x/plugins/armorcodex/scripts/bootstrap.mjs";
  const file = pre039Hooks(bootstrapPath);
  file.hooks.SessionEnd[1].hooks[0].timeout = 3;
  const text = `${JSON.stringify(file, null, 4)}`;
  writeFileSync(hooksFile, text);

  const result = await syncOurHooks({ hooksFile, bootstrapPath, codexBin: join(root, "no-such-codex"), cwd: root });

  assert.equal(result.status, "current");
  assert.equal(readFileSync(hooksFile, "utf8"), text);
});

for (const [label, batchWrite] of [
  ["Codex refuses the trust write", "error"],
  ["the trust write does not take", "ignored"]
]) {
  test(`hooks.json and trust are restored when ${label}`, async (t) => {
    const { root, hooksFile, bootstrapPath, original, codex, trusted } = await setup(t, { batchWrite });

    const result = await syncOurHooks({ hooksFile, bootstrapPath, codexBin: codex.bin, cwd: root });

    assert.equal(result.status, "rolled-back");
    assert.ok(result.reason);
    assert.equal(readFileSync(hooksFile, "utf8"), original);
    assert.deepEqual(codex.state(), trusted);
    const listed = await listVia(codex.bin, hooksFile, root);
    assert.ok(ourStatuses(listed, bootstrapPath).every((status) => status.endsWith(":trusted")));
  });
}

test("a hooks.json is left alone when Codex cannot be reached", async (t) => {
  const { root, hooksFile, bootstrapPath, original } = await setup(t);

  const result = await syncOurHooks({ hooksFile, bootstrapPath, codexBin: join(root, "no-such-codex"), cwd: root });

  assert.equal(result.status, "failed");
  assert.equal(readFileSync(hooksFile, "utf8"), original);
});

test("hooks the person never trusted are not rewritten or trusted behind their back", async (t) => {
  const { root, hooksFile, bootstrapPath, original, codex, trusted } = await setup(t, { untrusted: "stop" });

  const result = await syncOurHooks({ hooksFile, bootstrapPath, codexBin: codex.bin, cwd: root });

  assert.equal(result.status, "skipped");
  assert.match(result.reason, /stop/);
  assert.equal(readFileSync(hooksFile, "utf8"), original);
  assert.deepEqual(codex.state(), trusted);
});

test("entries that point at another checkout are not touched", async (t) => {
  const { root, hooksFile, original, codex } = await setup(t);

  const result = await syncOurHooks({
    hooksFile,
    bootstrapPath: join(root, "elsewhere", "plugins", "armorcodex", "scripts", "bootstrap.mjs"),
    codexBin: codex.bin,
    cwd: root
  });

  assert.equal(result.status, "current");
  assert.equal(readFileSync(hooksFile, "utf8"), original);
  assert.equal(codex.calls(), "app-server\n", "only the test's own listing started Codex");
});

function installTree(root) {
  const installHome = join(root, ".armoriq", "armorCodex");
  const scripts = join(installHome, "plugins", "armorcodex", "scripts");
  mkdirSync(scripts, { recursive: true });
  writeFileSync(join(scripts, "sync-hooks.mjs"), "");
  return { installHome, bootstrapPath: join(scripts, "bootstrap.mjs") };
}

test("SessionStart starts a sync only when an ArmorCodex entry is stale, and backs off after a failure", (t) => {
  const root = scratch(t);
  const { installHome, bootstrapPath } = installTree(root);
  const dataDir = join(root, "data");
  const env = { HOME: root, CODEX_HOME: join(root, ".codex") };
  mkdirSync(env.CODEX_HOME, { recursive: true });
  const hooksFile = join(env.CODEX_HOME, "hooks.json");
  const spawned = [];
  const spawnChild = (command, args, options) => {
    spawned.push({ args, env: options.env });
    return { unref() {} };
  };

  assert.equal(scheduleHookSync({ installHome, dataDir, env, spawnChild }).reason, "absent");

  const current = pre039Hooks(bootstrapPath);
  current.hooks.SessionEnd[1].hooks[0].timeout = 3;
  writeFileSync(hooksFile, JSON.stringify(current));
  assert.equal(scheduleHookSync({ installHome, dataDir, env, spawnChild }).reason, "current");

  writeFileSync(hooksFile, JSON.stringify(pre039Hooks(bootstrapPath)));
  assert.equal(scheduleHookSync({ installHome, dataDir, env, spawnChild }).started, true);
  assert.equal(spawned.length, 1);
  assert.equal(spawned[0].args[0], join(installHome, "plugins", "armorcodex", "scripts", "sync-hooks.mjs"));
  assert.equal(spawned[0].env.ARMORCODEX_SYNC_HOOKS_FILE, hooksFile);

  const failedAt = new Date("2026-11-18T10:00:00Z");
  recordSyncResult({ stateFile: join(dataDir, HOOK_SYNC_STATE_FILENAME), result: { status: "rolled-back", reason: "x" }, version: "0.3.10", now: failedAt });
  const inAMinute = failedAt.getTime() + 60_000;
  assert.equal(scheduleHookSync({ installHome, dataDir, env, spawnChild, now: inAMinute }).reason, "backoff");
  const inTwoHours = failedAt.getTime() + 2 * 60 * 60 * 1000;
  assert.equal(scheduleHookSync({ installHome, dataDir, env, spawnChild, now: inTwoHours }).started, true);
});

test("a tree without the sync script is never asked to sync", (t) => {
  const root = scratch(t);
  const installHome = join(root, "old-release");
  const result = scheduleHookSync({ installHome, dataDir: join(root, "data"), env: { HOME: root }, spawnChild: () => assert.fail("spawned") });
  assert.equal(result.reason, "no-sync-script");
});

test("SessionStart on a managed release install asks for a hook sync, unless auto-update is off", async (t) => {
  const root = scratch(t);
  const installHome = join(root, "armorCodex");
  mkdirSync(join(installHome, ".git"), { recursive: true });
  writeFileSync(join(installHome, ".git", "HEAD"), "ref: refs/heads/main\n");
  const config = { dataDir: join(root, "data"), clientVersion: "0.3.9" };
  const check = { status: "current" };
  const calls = [];
  const scheduleHookSync = (args) => calls.push(args);

  await autoUpdate(config, { installHome, liveRoot: installHome, env: { HOME: root }, check, scheduleHookSync });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].installHome, installHome);
  assert.equal(calls[0].dataDir, config.dataDir);

  await autoUpdate(config, { installHome, liveRoot: installHome, env: { HOME: root, ARMORCODEX_NO_AUTO_UPDATE: "1" }, check, scheduleHookSync });
  assert.equal(calls.length, 1);
});
