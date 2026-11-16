import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import test from "node:test";
import { handleSessionStart } from "../plugins/armorcodex/scripts/lib/engine.mjs";
import {
  acquireSwapLock,
  autoUpdate,
  inspectStagedTree,
  readSdkCliSpec,
  scheduleStaging,
  stageMarkerPath,
  stagePaths,
  stageUpdate,
  swapNotice,
  swapStagedUpdate
} from "../plugins/armorcodex/scripts/lib/update-apply.mjs";

const GIT_ENV = {
  GIT_AUTHOR_NAME: "test",
  GIT_AUTHOR_EMAIL: "test@example.invalid",
  GIT_COMMITTER_NAME: "test",
  GIT_COMMITTER_EMAIL: "test@example.invalid",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null"
};

function git(cwd, ...args) {
  return execFileSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, ...GIT_ENV } }).trim();
}

const DEPENDENCIES = { "@armoriq/sdk-dev": "^0.8.16", "@modelcontextprotocol/sdk": "^1.27.1", zod: "^3.25.76" };

function writePluginTree(root, version, sdkSpec = "@armoriq/sdk-dev@latest") {
  const scripts = join(root, "plugins", "armorcodex", "scripts");
  mkdirSync(scripts, { recursive: true });
  writeFileSync(join(scripts, "bootstrap.mjs"), `// armorcodex ${version}\n`);
  writeFileSync(join(scripts, "hook-router.mjs"), `// router ${version}\n`);
  writeFileSync(
    join(root, "plugins", "armorcodex", "package.json"),
    `${JSON.stringify({ name: "armorcodex", version, dependencies: DEPENDENCIES }, null, 2)}\n`
  );
  writeFileSync(
    join(root, "plugins", "armorcodex", "package-lock.json"),
    `${JSON.stringify({ name: "armorcodex", version, lockfileVersion: 3 }, null, 2)}\n`
  );
  writeFileSync(join(root, "install_armorcodex.sh"), `npm install -g ${sdkSpec} --silent\n`);
  writeFileSync(join(root, ".gitignore"), "node_modules/\n");
}

/** A real origin whose main has moved past every release tag. */
function originRepo(root, releases) {
  const repo = join(root, "origin");
  mkdirSync(repo, { recursive: true });
  git(root, "init", "--quiet", "--initial-branch=main", repo);
  for (const { version, sdkSpec } of releases) {
    writePluginTree(repo, version, sdkSpec);
    git(repo, "add", "-A");
    git(repo, "commit", "--quiet", "-m", `release ${version}`);
    git(repo, "tag", `v${version}`);
  }
  writeFileSync(join(repo, "UNRELEASED.md"), "only on main\n");
  git(repo, "add", "-A");
  git(repo, "commit", "--quiet", "-m", "unreleased work");
  return repo;
}

const DEP_PACKAGES = [["@armoriq", "sdk-dev"], ["zod"], ["@modelcontextprotocol", "sdk"]];

function installDeps(pluginDir) {
  for (const parts of DEP_PACKAGES) {
    const dir = join(pluginDir, "node_modules", ...parts);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "package.json"), '{"name":"stub","version":"0.0.0"}\n');
  }
}

/** A live install that is a real clone of a real release tag. */
function liveInstall(root, repo, version) {
  const installHome = join(root, "install", "armorCodex");
  mkdirSync(join(root, "install"), { recursive: true });
  execFileSync("git", ["clone", "--quiet", "--branch", `v${version}`, `file://${repo}`, installHome], {
    env: { ...process.env, ...GIT_ENV }
  });
  installDeps(join(installHome, "plugins", "armorcodex"));
  assert.equal(git(installHome, "status", "--porcelain"), "", "a fresh install starts clean");
  return installHome;
}

/**
 * `npm ci` is stubbed because the real one needs the registry and this suite
 * must make no network calls. The stub creates the same package directories
 * the completeness check looks for, and refuses anything but `ci`, so a
 * regression back to `npm install` fails here.
 */
function stubBin(root, { npmFails = false } = {}) {
  const binDir = join(root, "bin");
  mkdirSync(binDir, { recursive: true });
  const npm = join(binDir, "npm");
  const lines = npmFails
    ? ["#!/bin/sh", 'echo "npm stub: forced failure" >&2', "exit 1"]
    : [
        "#!/bin/sh",
        'if [ "$1" != "ci" ]; then echo "npm stub: refusing $1" >&2; exit 1; fi',
        'for p in "@armoriq/sdk-dev" "zod" "@modelcontextprotocol/sdk"; do',
        '  mkdir -p "node_modules/$p"',
        '  printf \'{"name":"stub","version":"0.0.0"}\' > "node_modules/$p/package.json"',
        "done",
        "exit 0"
      ];
  writeFileSync(npm, `${lines.join("\n")}\n`);
  chmodSync(npm, 0o755);
  return binDir;
}

function withPath(binDir, env = {}) {
  return { ...process.env, ...GIT_ENV, PATH: `${binDir}${delimiter}${process.env.PATH}`, ...env };
}

function scratch(t, label) {
  const root = mkdtempSync(join(tmpdir(), `armorcodex-${label}-`));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

function configFor(t, version) {
  const dataDir = mkdtempSync(join(tmpdir(), "armorcodex-apply-data-"));
  t.after(() => rmSync(dataDir, { recursive: true, force: true }));
  return {
    mode: "enforce",
    intentRequired: true,
    dataDir,
    runtimeFile: join(dataDir, "runtime.json"),
    clientVersion: `armorcodex/${version}`
  };
}

const treeVersion = (root) =>
  JSON.parse(readFileSync(join(root, "plugins", "armorcodex", "package.json"), "utf8")).version;

test("a newer release is staged beside the live tree, which is left untouched", async (t) => {
  const root = scratch(t, "stage");
  const repo = originRepo(root, [{ version: "0.3.3" }, { version: "0.4.0" }]);
  const installHome = liveInstall(root, repo, "0.3.3");
  const binDir = stubBin(root);
  const paths = stagePaths(installHome);
  const liveHeadBefore = git(installHome, "rev-parse", "HEAD");

  const result = await stageUpdate({
    installHome,
    tag: "v0.4.0",
    gitUrl: `file://${repo}`,
    env: withPath(binDir)
  });

  assert.equal(result.staged, true, result.reason);
  assert.equal(result.version, "0.4.0");
  assert.equal(treeVersion(installHome), "0.3.3", "the live tree still runs the old version");
  assert.equal(git(installHome, "rev-parse", "HEAD"), liveHeadBefore);
  assert.equal(git(installHome, "status", "--porcelain"), "", "staging did not dirty the live tree");
  assert.equal(treeVersion(paths.staged), "0.4.0");
  assert.equal(existsSync(join(paths.staged, "UNRELEASED.md")), false, "the tag was cloned, not the main tip");
  assert.equal(existsSync(paths.staging), false, "the staging claim is released");

  const marker = JSON.parse(readFileSync(stageMarkerPath(paths.staged), "utf8"));
  assert.equal(marker.version, "0.4.0");
  assert.equal(marker.tag, "v0.4.0");
  assert.equal(marker.sdkCliSpec, "@armoriq/sdk-dev@latest");
});

test("the next session start swaps the staged tree in at the same path, keeping the old one", async (t) => {
  const root = scratch(t, "swap");
  const repo = originRepo(root, [{ version: "0.3.3" }, { version: "0.4.0" }]);
  const installHome = liveInstall(root, repo, "0.3.3");
  const binDir = stubBin(root);
  const paths = stagePaths(installHome);

  await stageUpdate({ installHome, tag: "v0.4.0", gitUrl: `file://${repo}`, env: withPath(binDir) });

  const swap = swapStagedUpdate({ installHome, running: "0.3.3", env: withPath(binDir) });

  assert.equal(swap.swapped, true, swap.reason);
  assert.equal(swap.version, "0.4.0");
  assert.equal(swap.previousVersion, "0.3.3");
  assert.equal(treeVersion(installHome), "0.4.0", "the install path now holds the new version");
  assert.equal(treeVersion(paths.previous), "0.3.3", ".previous holds the replaced tree");
  assert.equal(existsSync(paths.staged), false, "the staged tree was consumed");
  assert.equal(
    git(installHome, "status", "--porcelain"),
    "",
    "the swapped-in tree is clean, so a later swap is not blocked"
  );
  assert.match(swapNotice(swap), /ArmorCodex updated to 0\.4\.0 \(was 0\.3\.3\)/);

  const again = swapStagedUpdate({ installHome, running: "0.4.0", env: withPath(binDir) });
  assert.equal(again.swapped, false);
  assert.equal(again.reason, "nothing-staged");
});

test("a release that moves the SDK CLI pin says so instead of installing it", async (t) => {
  const root = scratch(t, "cli-pin");
  const repo = originRepo(root, [
    { version: "0.3.3", sdkSpec: "@armoriq/sdk-dev@^0.8.24" },
    { version: "0.4.0", sdkSpec: "@armoriq/sdk-dev@^0.9.0" }
  ]);
  const installHome = liveInstall(root, repo, "0.3.3");
  const binDir = stubBin(root);

  await stageUpdate({ installHome, tag: "v0.4.0", gitUrl: `file://${repo}`, env: withPath(binDir) });
  const swap = swapStagedUpdate({ installHome, running: "0.3.3", env: withPath(binDir) });

  assert.equal(swap.swapped, true, swap.reason);
  assert.equal(swap.sdkCliSpecChanged, true);
  assert.equal(swap.sdkCliSpec, "@armoriq/sdk-dev@^0.9.0");
  assert.match(swapNotice(swap), /expects the ArmorIQ CLI at @armoriq\/sdk-dev@\^0\.9\.0/);
  assert.match(swapNotice(swap), /curl -fsSL https:\/\/armoriq\.ai\/install_armorcodex\.sh \| bash/);
});

test("a dirty live tree aborts the swap and leaves both trees intact", async (t) => {
  const root = scratch(t, "dirty");
  const repo = originRepo(root, [{ version: "0.3.3" }, { version: "0.4.0" }]);
  const installHome = liveInstall(root, repo, "0.3.3");
  const binDir = stubBin(root);
  const paths = stagePaths(installHome);

  await stageUpdate({ installHome, tag: "v0.4.0", gitUrl: `file://${repo}`, env: withPath(binDir) });

  const localEdit = join(installHome, "plugins", "armorcodex", "scripts", "hook-router.mjs");
  writeFileSync(localEdit, "// local change the user made\n");

  const swap = swapStagedUpdate({ installHome, running: "0.3.3", env: withPath(binDir) });

  assert.equal(swap.swapped, false);
  assert.equal(swap.reason, "dirty");
  assert.equal(readFileSync(localEdit, "utf8"), "// local change the user made\n");
  assert.equal(treeVersion(installHome), "0.3.3");
  assert.equal(treeVersion(paths.staged), "0.4.0", "the staged tree is kept for a later clean swap");
  assert.equal(existsSync(paths.previous), false, "nothing was moved aside");
});

test("an interrupted staged tree is never swapped in", async (t) => {
  const root = scratch(t, "incomplete");
  const repo = originRepo(root, [{ version: "0.3.3" }, { version: "0.4.0" }]);
  const installHome = liveInstall(root, repo, "0.3.3");
  const binDir = stubBin(root);
  const paths = stagePaths(installHome);

  await stageUpdate({ installHome, tag: "v0.4.0", gitUrl: `file://${repo}`, env: withPath(binDir) });

  // A kill before the marker is written is one shape of a half-staged tree.
  rmSync(stageMarkerPath(paths.staged));
  assert.equal(inspectStagedTree(paths.staged), null);

  const noMarker = swapStagedUpdate({ installHome, running: "0.3.3", env: withPath(binDir) });
  assert.equal(noMarker.swapped, false);
  assert.equal(noMarker.reason, "incomplete");
  assert.equal(treeVersion(installHome), "0.3.3");

  // A marker beside a half-finished dependency install is the other.
  rmSync(join(paths.staged, "plugins", "armorcodex", "node_modules", "zod"), { recursive: true, force: true });
  writeFileSync(stageMarkerPath(paths.staged), JSON.stringify({ version: "0.4.0", tag: "v0.4.0" }));

  const noDeps = swapStagedUpdate({ installHome, running: "0.3.3", env: withPath(binDir) });
  assert.equal(noDeps.swapped, false);
  assert.equal(noDeps.reason, "incomplete");
  assert.equal(treeVersion(installHome), "0.3.3");
  assert.equal(existsSync(paths.previous), false);
});

test("a staged tree that is not newer than the running build is left alone", async (t) => {
  const root = scratch(t, "not-newer");
  const repo = originRepo(root, [{ version: "0.3.3" }, { version: "0.4.0" }]);
  const installHome = liveInstall(root, repo, "0.4.0");
  const binDir = stubBin(root);
  const paths = stagePaths(installHome);

  await stageUpdate({ installHome, tag: "v0.3.3", gitUrl: `file://${repo}`, env: withPath(binDir) });
  assert.equal(treeVersion(paths.staged), "0.3.3");

  const swap = swapStagedUpdate({ installHome, running: "0.4.0", env: withPath(binDir) });

  assert.equal(swap.swapped, false);
  assert.equal(swap.reason, "not-newer");
  assert.equal(treeVersion(installHome), "0.4.0");
  assert.equal(existsSync(paths.staged), true);
  assert.equal(existsSync(paths.previous), false);
});

test("the opt-out prevents both staging and swapping", async (t) => {
  const root = scratch(t, "optout");
  const repo = originRepo(root, [{ version: "0.3.3" }, { version: "0.4.0" }]);
  const installHome = liveInstall(root, repo, "0.3.3");
  const binDir = stubBin(root);
  const paths = stagePaths(installHome);
  const optedOut = withPath(binDir, { ARMORCODEX_NO_AUTO_UPDATE: "1" });

  const scheduled = scheduleStaging({ installHome, tag: "v0.4.0", running: "0.3.3", env: optedOut });

  assert.equal(scheduled.started, false);
  assert.equal(scheduled.reason, "disabled");
  assert.equal(existsSync(paths.staged), false);
  assert.equal(existsSync(paths.staging), false);

  // Even with a complete staged tree already on disk, the opt-out holds.
  await stageUpdate({ installHome, tag: "v0.4.0", gitUrl: `file://${repo}`, env: withPath(binDir) });
  const swap = swapStagedUpdate({ installHome, running: "0.3.3", env: optedOut });

  assert.equal(swap.swapped, false);
  assert.equal(swap.reason, "disabled");
  assert.equal(treeVersion(installHome), "0.3.3");
  assert.equal(existsSync(paths.previous), false);
});

test("an unreachable origin leaves the live install working and nothing staged", async (t) => {
  const root = scratch(t, "offline");
  const repo = originRepo(root, [{ version: "0.3.3" }]);
  const installHome = liveInstall(root, repo, "0.3.3");
  const binDir = stubBin(root);
  const paths = stagePaths(installHome);

  const result = await stageUpdate({
    installHome,
    tag: "v0.4.0",
    gitUrl: `file://${join(root, "no-such-repo")}`,
    env: withPath(binDir)
  });

  assert.equal(result.staged, false);
  assert.equal(existsSync(paths.staged), false);
  assert.equal(existsSync(paths.staging), false, "the failed attempt cleans up its claim");
  assert.equal(treeVersion(installHome), "0.3.3");
  assert.equal(git(installHome, "status", "--porcelain"), "");
});

test("a failed dependency install leaves the live install working and nothing staged", async (t) => {
  const root = scratch(t, "npm-fail");
  const repo = originRepo(root, [{ version: "0.3.3" }, { version: "0.4.0" }]);
  const installHome = liveInstall(root, repo, "0.3.3");
  const binDir = stubBin(root, { npmFails: true });
  const paths = stagePaths(installHome);

  const result = await stageUpdate({
    installHome,
    tag: "v0.4.0",
    gitUrl: `file://${repo}`,
    env: withPath(binDir)
  });

  assert.equal(result.staged, false);
  assert.match(result.reason, /npm ci/);
  assert.equal(existsSync(paths.staged), false);
  assert.equal(existsSync(paths.staging), false);
  assert.equal(treeVersion(installHome), "0.3.3");
});

test("a second stager does not touch a claim another one holds", async (t) => {
  const root = scratch(t, "claim");
  const repo = originRepo(root, [{ version: "0.3.3" }, { version: "0.4.0" }]);
  const installHome = liveInstall(root, repo, "0.3.3");
  const binDir = stubBin(root);
  const paths = stagePaths(installHome);

  mkdirSync(paths.staging, { recursive: true });
  writeFileSync(join(paths.staging, "half-written"), "in flight\n");

  const result = await stageUpdate({
    installHome,
    tag: "v0.4.0",
    gitUrl: `file://${repo}`,
    env: withPath(binDir)
  });

  assert.equal(result.staged, false);
  assert.equal(result.reason, "in-progress");
  assert.equal(readFileSync(join(paths.staging, "half-written"), "utf8"), "in flight\n");
  assert.equal(existsSync(paths.staged), false);
});

// handleSessionStart runs under the fail-closed router, where a throw becomes
// a denied tool call, so the only acceptable failure mode is a normal return.

function freshCheck(config, latestVersion) {
  writeFileSync(
    join(config.dataDir, "update-check.json"),
    JSON.stringify({ lastCheckedAt: Math.floor(Date.now() / 1000), latestVersion })
  );
}

test("SessionStart swaps a staged release in and tells the user, in one session", async (t) => {
  const root = scratch(t, "session-swap");
  const repo = originRepo(root, [{ version: "0.3.3" }, { version: "0.4.0" }]);
  const installHome = liveInstall(root, repo, "0.3.3");
  const binDir = stubBin(root);
  const paths = stagePaths(installHome);
  const config = configFor(t, "0.3.3");
  freshCheck(config, "v0.4.0");

  await stageUpdate({ installHome, tag: "v0.4.0", gitUrl: `file://${repo}`, env: withPath(binDir) });

  const output = await handleSessionStart(
    { hook_event_name: "SessionStart", session_id: "sess-swap", source: "startup" },
    config,
    { installHome, liveRoot: installHome, env: withPath(binDir) }
  );

  assert.match(output.systemMessage, /ArmorCodex updated to 0\.4\.0 \(was 0\.3\.3\)/);
  assert.equal(output.hookSpecificOutput.additionalContext, "ArmorCodex active (ENFORCING, intent=required)");
  assert.equal(treeVersion(installHome), "0.4.0");
  assert.equal(treeVersion(paths.previous), "0.3.3");
  assert.ok(JSON.parse(readFileSync(config.runtimeFile, "utf8")).sessions["sess-swap"]);
});

test("SessionStart returns normally when the swap fails on a dirty tree", async (t) => {
  const root = scratch(t, "session-dirty");
  const repo = originRepo(root, [{ version: "0.3.3" }, { version: "0.4.0" }]);
  const installHome = liveInstall(root, repo, "0.3.3");
  const binDir = stubBin(root);
  const config = configFor(t, "0.3.3");
  freshCheck(config, "v0.4.0");

  await stageUpdate({ installHome, tag: "v0.4.0", gitUrl: `file://${repo}`, env: withPath(binDir) });
  writeFileSync(join(installHome, "plugins", "armorcodex", "scripts", "hook-router.mjs"), "// edited\n");

  const output = await handleSessionStart(
    { hook_event_name: "SessionStart", session_id: "sess-dirty", source: "startup" },
    config,
    { installHome, liveRoot: installHome, env: withPath(binDir) }
  );

  assert.equal(output.hookSpecificOutput.additionalContext, "ArmorCodex active (ENFORCING, intent=required)");
  assert.match(output.systemMessage, /ArmorCodex v0\.4\.0 is available/);
  assert.equal(treeVersion(installHome), "0.3.3");
});

test("SessionStart returns normally when the install path is gone entirely", async (t) => {
  const root = scratch(t, "session-missing");
  const missing = join(root, "not-there");
  const config = configFor(t, "0.3.3");
  freshCheck(config, "v0.4.0");

  const output = await handleSessionStart(
    { hook_event_name: "SessionStart", session_id: "sess-missing", source: "startup" },
    config,
    { installHome: missing, liveRoot: missing, env: { PATH: process.env.PATH } }
  );

  assert.equal(output.hookSpecificOutput.additionalContext, "ArmorCodex active (ENFORCING, intent=required)");
  assert.equal(output.systemMessage, undefined, "a tree that is not a release checkout gets no notice");
});

test("autoUpdate never stages or swaps a developer checkout run in place", async (t) => {
  const root = scratch(t, "dev-checkout");
  const repo = originRepo(root, [{ version: "0.3.3" }, { version: "0.4.0" }]);
  const installHome = liveInstall(root, repo, "0.3.3");
  const binDir = stubBin(root);
  const paths = stagePaths(installHome);
  const config = configFor(t, "0.3.3");
  freshCheck(config, "v0.4.0");

  await stageUpdate({ installHome, tag: "v0.4.0", gitUrl: `file://${repo}`, env: withPath(binDir) });

  const checkout = join(root, "somewhere", "else");
  execFileSync("git", ["clone", "--quiet", `file://${repo}`, checkout], { env: { ...process.env, ...GIT_ENV } });

  const result = await autoUpdate(config, { installHome, liveRoot: checkout, env: withPath(binDir) });

  assert.equal(result.swapped, false);
  assert.equal(result.reason, "not-managed");
  assert.equal(treeVersion(installHome), "0.3.3");
  assert.equal(treeVersion(paths.staged), "0.4.0", "the staged tree is untouched");
  assert.match(result.notice, /ArmorCodex v0\.4\.0 is available/);
});

for (const branch of ["dev", "my-feature"]) {
test(`an install on ${branch} is neither told about nor moved onto a release`, async (t) => {
  const root = scratch(t, "dev-channel");
  const repo = originRepo(root, [{ version: "0.3.3" }, { version: "0.4.0" }]);
  const installHome = liveInstall(root, repo, "0.3.3");
  git(installHome, "checkout", "--quiet", "-b", branch);
  writeFileSync(join(installHome, "MINE.md"), "unpushed work\n");
  git(installHome, "add", "MINE.md");
  git(installHome, "commit", "--quiet", "-m", "unpushed");
  const binDir = stubBin(root);
  const paths = stagePaths(installHome);
  const config = configFor(t, "0.3.3");
  freshCheck(config, "v0.4.0");

  await stageUpdate({ installHome, tag: "v0.4.0", gitUrl: `file://${repo}`, env: withPath(binDir) });

  const result = await autoUpdate(config, { installHome, liveRoot: installHome, env: withPath(binDir) });

  assert.equal(result.reason, "not-release-channel");
  assert.equal(result.notice, "");
  assert.equal(treeVersion(installHome), "0.3.3");
  assert.equal(git(installHome, "rev-parse", "--abbrev-ref", "HEAD"), branch);
  assert.ok(existsSync(join(installHome, "MINE.md")), "the owner's commit stays in place");
  assert.equal(treeVersion(paths.staged), "0.4.0", "the staged tree is not swapped in");
});
}

test("a second session swapping at the same time keeps the first one's .previous", async (t) => {
  const root = scratch(t, "concurrent");
  const repo = originRepo(root, [{ version: "0.3.3" }, { version: "0.4.0" }]);
  const installHome = liveInstall(root, repo, "0.3.3");
  const binDir = stubBin(root);
  const paths = stagePaths(installHome);
  await stageUpdate({ installHome, tag: "v0.4.0", gitUrl: `file://${repo}`, env: withPath(binDir) });

  const release = acquireSwapLock(paths.lock);
  assert.ok(release);
  assert.equal(swapStagedUpdate({ installHome, running: "0.3.3", env: withPath(binDir) }).reason, "in-progress");
  release();

  const first = swapStagedUpdate({ installHome, running: "0.3.3", env: withPath(binDir) });
  const second = swapStagedUpdate({ installHome, running: "0.3.3", env: withPath(binDir) });
  assert.equal(first.swapped, true);
  assert.equal(second.swapped, false);
  assert.equal(treeVersion(installHome), "0.4.0");
  assert.equal(treeVersion(paths.previous), "0.3.3", "the rollback copy survives");
  assert.equal(existsSync(paths.lock), false);
});

test("a staged tree carries the marker bootstrap needs to skip a reinstall", async (t) => {
  const root = scratch(t, "installed-marker");
  const repo = originRepo(root, [{ version: "0.3.3" }, { version: "0.4.0" }]);
  const installHome = liveInstall(root, repo, "0.3.3");
  const binDir = stubBin(root);
  const paths = stagePaths(installHome);
  await stageUpdate({ installHome, tag: "v0.4.0", gitUrl: `file://${repo}`, env: withPath(binDir) });

  assert.equal(
    readFileSync(join(paths.staged, "plugins", "armorcodex", "node_modules", ".armorcodex-installed"), "utf8"),
    "0.4.0"
  );
});

test("an install reached through a symlinked path still swaps", async (t) => {
  const root = scratch(t, "symlink");
  const repo = originRepo(root, [{ version: "0.3.3" }, { version: "0.4.0" }]);
  const installHome = liveInstall(root, repo, "0.3.3");
  const binDir = stubBin(root);
  const link = join(root, "linked");
  symlinkSync(join(root, "install"), link);
  const config = configFor(t, "0.3.3");
  freshCheck(config, "v0.4.0");
  await stageUpdate({ installHome, tag: "v0.4.0", gitUrl: `file://${repo}`, env: withPath(binDir) });

  const result = await autoUpdate(config, {
    installHome,
    liveRoot: join(link, "armorCodex"),
    env: withPath(binDir)
  });

  assert.equal(result.swapped, true, result.reason);
  assert.equal(treeVersion(installHome), "0.4.0");
});

test("a staged tree missing any dependency its package.json declares is not eligible", async (t) => {
  const root = scratch(t, "missing-dep");
  const repo = originRepo(root, [{ version: "0.3.3" }, { version: "0.4.0" }]);
  const installHome = liveInstall(root, repo, "0.3.3");
  const binDir = stubBin(root);
  const paths = stagePaths(installHome);

  await stageUpdate({ installHome, tag: "v0.4.0", gitUrl: `file://${repo}`, env: withPath(binDir) });
  assert.ok(inspectStagedTree(paths.staged));

  rmSync(join(paths.staged, "plugins", "armorcodex", "node_modules", "@armoriq", "sdk-dev"), { recursive: true });
  assert.equal(inspectStagedTree(paths.staged), null);
});

test("the CLI pin is read from the real installer", () => {
  const root = new URL("..", import.meta.url).pathname;
  assert.match(readSdkCliSpec(root), /^@armoriq\/sdk(-dev)?@/);
});

test("a stager killed mid-install can never leave an eligible tree behind", async (t) => {
  const root = scratch(t, "killed");
  const repo = originRepo(root, [{ version: "0.3.3" }, { version: "0.4.0" }]);
  const installHome = liveInstall(root, repo, "0.3.3");
  const paths = stagePaths(installHome);

  // An npm that never returns is the window a kill -9 lands in.
  const binDir = join(root, "bin");
  mkdirSync(binDir, { recursive: true });
  writeFileSync(join(binDir, "npm"), "#!/bin/sh\nsleep 120\n");
  chmodSync(join(binDir, "npm"), 0o755);

  const started = scheduleStaging({
    installHome,
    tag: "v0.4.0",
    running: "0.3.3",
    env: withPath(binDir, { ARMORCODEX_GIT_URL: `file://${repo}` })
  });
  assert.equal(started.started, true, started.reason);

  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline && !existsSync(join(paths.staging, "plugins"))) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.ok(existsSync(join(paths.staging, "plugins")), "the clone landed, so the install is underway");

  execFileSync("pkill", ["-9", "-f", "stage-update.mjs"], { stdio: "ignore" });
  execFileSync("pkill", ["-9", "-f", `${binDir}/npm`], { stdio: "ignore" });
  await new Promise((resolve) => setTimeout(resolve, 500));

  assert.equal(existsSync(paths.staged), false, "a killed stager never renames a tree into place");
  assert.equal(inspectStagedTree(paths.staged), null);

  const swap = swapStagedUpdate({ installHome, running: "0.3.3", env: withPath(binDir) });
  assert.equal(swap.swapped, false);
  assert.equal(swap.reason, "nothing-staged");
  assert.equal(treeVersion(installHome), "0.3.3");
});

test("SessionStart still returns when the updater itself throws", async (t) => {
  const config = configFor(t, "0.3.3");
  freshCheck(config, "v0.4.0");

  // A non-string install path makes path.resolve throw inside autoUpdate,
  // which on the fail-closed router must not become a denied tool call.
  const output = await handleSessionStart(
    { hook_event_name: "SessionStart", session_id: "sess-throw", source: "startup" },
    config,
    { installHome: 42, liveRoot: 42, env: { PATH: process.env.PATH } }
  );

  assert.equal(output.hookSpecificOutput.additionalContext, "ArmorCodex active (ENFORCING, intent=required)");
  assert.equal(output.systemMessage, undefined);
  assert.ok(JSON.parse(readFileSync(config.runtimeFile, "utf8")).sessions["sess-throw"]);
});

test("the detached stager really prepares a release when SessionStart schedules it", async (t) => {
  const root = scratch(t, "scheduled");
  const repo = originRepo(root, [{ version: "0.3.3" }, { version: "0.4.0" }]);
  const installHome = liveInstall(root, repo, "0.3.3");
  const binDir = stubBin(root);
  const paths = stagePaths(installHome);

  const started = scheduleStaging({
    installHome,
    tag: "v0.4.0",
    running: "0.3.3",
    env: withPath(binDir, { ARMORCODEX_GIT_URL: `file://${repo}` })
  });
  assert.equal(started.started, true, started.reason);

  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline && !inspectStagedTree(paths.staged)) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  const marker = inspectStagedTree(paths.staged);
  assert.ok(marker, "the detached stager produced a complete tree");
  assert.equal(marker.version, "0.4.0");
  assert.equal(treeVersion(installHome), "0.3.3", "the live tree was untouched while staging ran");

  const swap = swapStagedUpdate({ installHome, running: "0.3.3", env: withPath(binDir) });
  assert.equal(swap.swapped, true, swap.reason);
  assert.equal(treeVersion(installHome), "0.4.0");
});
