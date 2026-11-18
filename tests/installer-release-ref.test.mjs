import assert from "node:assert/strict";
import { createServer } from "node:http";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { execFileSync, spawn } from "node:child_process";
import test from "node:test";

const INSTALLER = new URL("../install_armorcodex.sh", import.meta.url).pathname;

function git(cwd, ...args) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "test",
      GIT_AUTHOR_EMAIL: "test@example.invalid",
      GIT_COMMITTER_NAME: "test",
      GIT_COMMITTER_EMAIL: "test@example.invalid",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_SYSTEM: "/dev/null"
    }
  }).trim();
}

/**
 * A repo whose main has moved past the release tag, so "landed on the tag"
 * and "landed on the branch tip" cannot be confused.
 */
function originRepo(root) {
  const repo = join(root, "origin");
  mkdirSync(join(repo, "plugins", "armorcodex", "scripts", "lib"), { recursive: true });
  git(root, "init", "--quiet", "--initial-branch=main", repo);

  // The installer asks the plugin's own config whether a login exists.
  writeFileSync(
    join(repo, "plugins", "armorcodex", "scripts", "lib", "config.mjs"),
    'export const loadConfig = () => ({ apiKey: "ak_fixture" });\nexport const loadSettings = () => ({ backendEndpoint: "https://example.invalid" });\n'
  );

  writeFileSync(join(repo, "plugins", "armorcodex", "scripts", "bootstrap.mjs"), "// released\n");
  writeFileSync(join(repo, "plugins", "armorcodex", "package.json"), '{"name":"armorcodex"}\n');
  git(repo, "add", "-A");
  git(repo, "commit", "--quiet", "-m", "release 9.9.9");
  git(repo, "tag", "v9.9.9");
  const releaseSha = git(repo, "rev-parse", "HEAD");

  writeFileSync(join(repo, "UNRELEASED.md"), "only on main\n");
  git(repo, "add", "-A");
  git(repo, "commit", "--quiet", "-m", "unreleased work");
  const mainSha = git(repo, "rev-parse", "HEAD");

  assert.notEqual(releaseSha, mainSha);
  return { repo, releaseSha, mainSha };
}

async function releaseApi(t, tags) {
  const hits = [];
  const server = createServer((req, res) => {
    hits.push(req.url);
    const tag = tags.current;
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ tag_name: tag, name: tag }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return { baseUrl: `http://127.0.0.1:${server.address().port}`, hits };
}

/**
 * The installer prefers a checkout sitting next to itself, so a copy outside
 * the repo is the only way to exercise the clone path.
 */
function stagedInstaller(root) {
  const binDir = join(root, "bin");
  const scriptDir = join(root, "script");
  mkdirSync(binDir, { recursive: true });
  mkdirSync(scriptDir, { recursive: true });
  const staged = join(scriptDir, "install_armorcodex.sh");
  copyFileSync(INSTALLER, staged);

  for (const [name, body] of [
    ["codex", "#!/bin/sh\necho 'codex-cli 0.200.0'\n"],
    ["npm", "#!/bin/sh\nexit 0\n"]
  ]) {
    const file = join(binDir, name);
    writeFileSync(file, body);
    chmodSync(file, 0o755);
  }
  return { staged, binDir };
}

// The installer always emits colour, so assertions read the stripped text.
const plain = (text) => String(text).replace(/\u001B\[[0-9;:]*m/g, "");

// Async, not spawnSync: the installer calls back into the release API served
// by this process, and a synchronous spawn blocks the loop that answers it.
function runInstaller({ staged, binDir, home, installHome, gitUrl, releaseApiUrl, extraEnv = {} }) {
  const child = spawn("bash", [staged, "--update"], {
    cwd: home,
    env: {
      ...process.env,
      HOME: home,
      PATH: `${binDir}${delimiter}${process.env.PATH}`,
      ARMORCODEX_GIT_URL: gitUrl,
      ARMORCODEX_INSTALL_HOME: installHome,
      ARMORCODEX_RELEASE_API: releaseApiUrl,
      ...extraEnv
    }
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => (stdout += chunk));
  child.stderr.on("data", (chunk) => (stderr += chunk));
  return new Promise((resolve) => {
    child.on("close", (status) => resolve({ status, stdout, stderr }));
  });
}

test("a default install checks out the release tag, not the main tip", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "armorcodex-release-ref-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const { repo, releaseSha, mainSha } = originRepo(root);
  const tags = { current: "v9.9.9" };
  const { baseUrl, hits } = await releaseApi(t, tags);
  const { staged, binDir } = stagedInstaller(root);
  const home = join(root, "home");
  const installHome = join(root, "install", "armorCodex");
  mkdirSync(home, { recursive: true });

  const first = await runInstaller({
    staged,
    binDir,
    home,
    installHome,
    gitUrl: `file://${repo}`,
    releaseApiUrl: baseUrl
  });
  assert.equal(first.status, 0, first.stderr || first.stdout);
  assert.deepEqual(hits, ["/repos/armoriq/armorCodex/releases/latest"]);

  assert.equal(git(installHome, "rev-parse", "HEAD"), releaseSha);
  assert.notEqual(git(installHome, "rev-parse", "HEAD"), mainSha);
  assert.equal(
    existsSync(join(installHome, "UNRELEASED.md")),
    false,
    "the commit that is only on main must not be installed"
  );
  assert.match(plain(first.stdout), /installing release v9\.9\.9/);

  // The refresh path has no remote-tracking branch for a tag, so prove the
  // second run follows the new release rather than failing or sticking.
  writeFileSync(join(repo, "plugins", "armorcodex", "scripts", "bootstrap.mjs"), "// newer release\n");
  git(repo, "add", "-A");
  git(repo, "commit", "--quiet", "-m", "release 9.9.10");
  git(repo, "tag", "v9.9.10");
  const nextReleaseSha = git(repo, "rev-parse", "HEAD");
  tags.current = "v9.9.10";

  const second = await runInstaller({
    staged,
    binDir,
    home,
    installHome,
    gitUrl: `file://${repo}`,
    releaseApiUrl: baseUrl
  });
  assert.equal(second.status, 0, second.stderr || second.stdout);
  assert.equal(git(installHome, "rev-parse", "HEAD"), nextReleaseSha);
  assert.match(plain(second.stdout), /updated to v9\.9\.10/);
});

test("ARMORCODEX_GIT_REF still pins a branch and skips release resolution", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "armorcodex-release-ref-override-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const { repo, mainSha } = originRepo(root);
  const { baseUrl, hits } = await releaseApi(t, { current: "v9.9.9" });
  const { staged, binDir } = stagedInstaller(root);
  const home = join(root, "home");
  const installHome = join(root, "install", "armorCodex");
  mkdirSync(home, { recursive: true });

  const result = await runInstaller({
    staged,
    binDir,
    home,
    installHome,
    gitUrl: `file://${repo}`,
    releaseApiUrl: baseUrl,
    extraEnv: { ARMORCODEX_GIT_REF: "main" }
  });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.deepEqual(hits, [], "an explicit ref needs no release lookup");
  assert.equal(git(installHome, "rev-parse", "HEAD"), mainSha);
  assert.ok(existsSync(join(installHome, "UNRELEASED.md")));
});

test("an unreachable release API falls back to main instead of failing the install", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "armorcodex-release-ref-offline-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const { repo, mainSha } = originRepo(root);
  const { staged, binDir } = stagedInstaller(root);
  const home = join(root, "home");
  const installHome = join(root, "install", "armorCodex");
  mkdirSync(home, { recursive: true });

  const closed = createServer();
  await new Promise((resolve) => closed.listen(0, "127.0.0.1", resolve));
  const port = closed.address().port;
  await new Promise((resolve) => closed.close(resolve));

  const result = await runInstaller({
    staged,
    binDir,
    home,
    installHome,
    gitUrl: `file://${repo}`,
    releaseApiUrl: `http://127.0.0.1:${port}`
  });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(plain(result.stdout), /couldn't resolve the latest release/);
  assert.equal(git(installHome, "rev-parse", "HEAD"), mainSha);
});

test("a failed release lookup leaves an install that sits on a release tag where it is", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "armorcodex-release-ref-keep-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const { repo, releaseSha } = originRepo(root);
  const tags = { current: "v9.9.9" };
  const { baseUrl } = await releaseApi(t, tags);
  const { staged, binDir } = stagedInstaller(root);
  const home = join(root, "home");
  const installHome = join(root, "install", "armorCodex");
  mkdirSync(home, { recursive: true });
  const run = (releaseApiUrl) =>
    runInstaller({ staged, binDir, home, installHome, gitUrl: `file://${repo}`, releaseApiUrl });

  const first = await run(baseUrl);
  assert.equal(first.status, 0, first.stderr || first.stdout);
  assert.equal(git(installHome, "rev-parse", "HEAD"), releaseSha);

  tags.current = "rate limited";
  const second = await run(baseUrl);

  assert.equal(second.status, 0, second.stderr || second.stdout);
  assert.match(plain(second.stdout), /leaving the installed version as it is/);
  assert.equal(git(installHome, "rev-parse", "HEAD"), releaseSha);
  assert.equal(existsSync(join(installHome, "UNRELEASED.md")), false);
});

test("an install newer than the latest release is not moved back to it", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "armorcodex-release-ref-newer-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const { repo, mainSha } = originRepo(root);
  writeFileSync(join(repo, "plugins", "armorcodex", "package.json"), '{"name":"armorcodex","version":"10.0.0"}\n');
  git(repo, "add", "-A");
  git(repo, "commit", "--quiet", "-m", "bump to 10.0.0");
  const bumpedSha = git(repo, "rev-parse", "HEAD");
  assert.notEqual(bumpedSha, mainSha);
  const { baseUrl } = await releaseApi(t, { current: "v9.9.9" });
  const { staged, binDir } = stagedInstaller(root);
  const home = join(root, "home");
  const installHome = join(root, "install", "armorCodex");
  mkdirSync(home, { recursive: true });
  const base = { staged, binDir, home, installHome, gitUrl: `file://${repo}`, releaseApiUrl: baseUrl };

  const pinned = await runInstaller({ ...base, extraEnv: { ARMORCODEX_GIT_REF: "main" } });
  assert.equal(pinned.status, 0, pinned.stderr || pinned.stdout);
  assert.equal(git(installHome, "rev-parse", "HEAD"), bumpedSha);

  const update = await runInstaller(base);

  assert.equal(update.status, 0, update.stderr || update.stdout);
  assert.match(plain(update.stdout), /installed ArmorCodex 10\.0\.0 is newer than the latest release v9\.9\.9/);
  assert.equal(git(installHome, "rev-parse", "HEAD"), bumpedSha);
});
