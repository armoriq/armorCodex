import assert from "node:assert/strict";
import {
  chmodSync,
  cpSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os, { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { createRequire, syncBuiltinESMExports } from "node:module";
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

function saveCodexLogin(home, product = "armorcodex") {
  const requireSdk = createRequire(new URL("../plugins/armorcodex/package.json", import.meta.url));
  const { saveLoginProfile } = requireSdk("@armoriq/sdk-dev");
  const build = requireSdk("@armoriq/sdk-dev/dist/_build_env.js");
  const real = os.homedir;
  os.homedir = () => home;
  syncBuiltinESMExports();
  try {
    saveLoginProfile({
      backend: build.ENDPOINTS[build.ARMORIQ_ENV].backend,
      product,
      apiKey: "ak_test_update",
      email: "a@example.test",
      userId: "user-a",
      orgId: "org-a",
    });
  } finally {
    os.homedir = real;
    syncBuiltinESMExports();
  }
}

function runInstaller(root, home, binDir, flag = "--update") {
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

test("a normal update adds the Stop and SessionEnd hooks to an existing ArmorCodex hooks file and leaves its other hooks unchanged", async (t) => {
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

  stubTools(binDir);
  saveCodexLogin(home);

  const result = await runInstaller(root, home, binDir);

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
  assert.match(
    result.stdout,
    /added missing ArmorCodex UserPromptSubmit, PreToolUse, PermissionRequest, PostToolUse, Stop, SessionEnd hook\(s\)/,
  );
});

test("an existing hooks.json with only another tool's hooks keeps them and gains all seven ArmorCodex hooks", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "armorcodex-other-hooks-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, "home");
  const binDir = join(root, "bin");
  const hooksPath = join(home, ".codex", "hooks.json");
  mkdirSync(join(home, ".codex"), { recursive: true });
  mkdirSync(binDir, { recursive: true });
  const other = [{ hooks: [{ type: "command", command: "/opt/other-tool/bridge --source codex" }] }];
  writeFileSync(hooksPath, `${JSON.stringify({ hooks: { SessionStart: other, PostToolUse: other } }, null, 2)}\n`);
  stubTools(binDir);
  saveCodexLogin(home);

  const result = await runInstaller(root, home, binDir);

  assert.equal(result.status, 0, result.stderr || result.stdout);
  const { hooks } = JSON.parse(readFileSync(hooksPath, "utf8"));
  const ours = (event) => (hooks[event] ?? []).filter((group) =>
    group.hooks.some((hook) => /armorcodex\/scripts\/bootstrap\.mjs router$/i.test(hook.command)));
  for (const event of ["SessionStart", "UserPromptSubmit", "PreToolUse", "PermissionRequest", "PostToolUse", "Stop", "SessionEnd"]) {
    assert.equal(ours(event).length, 1, `${event} should have one ArmorCodex hook`);
  }
  assert.deepEqual(hooks.SessionStart[0], other[0]);
  assert.deepEqual(hooks.PostToolUse[0], other[0]);
  assert.doesNotMatch(result.stdout, /unrelated|--force-hooks/);

  const uninstall = await runInstaller(root, home, binDir, "--uninstall");
  assert.equal(uninstall.status, 0, uninstall.stderr || uninstall.stdout);
  assert.deepEqual(JSON.parse(readFileSync(hooksPath, "utf8")), { hooks: { SessionStart: other, PostToolUse: other } });
});

test("an update with an old-format credentials.json reaches the login step", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "armorcodex-update-v1-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, "home");
  const binDir = join(root, "bin");
  mkdirSync(join(home, ".armoriq"), { recursive: true });
  mkdirSync(binDir, { recursive: true });
  stubTools(binDir);
  writeFileSync(
    join(home, ".armoriq", "credentials.json"),
    JSON.stringify({ apiKey: "ak_test_flat", product: "armorcodex", backend: "https://staging-api.armoriq.ai" }),
  );

  const result = await runInstaller(root, home, binDir);

  assert.match(result.stdout, /Connect to ArmorIQ/);
  assert.match(result.stderr + result.stdout, /No TTY available for interactive login/);
  assert.doesNotMatch(result.stdout, /ArmorCodex is up to date/);
  assert.notEqual(result.status, 0);
});

test("an update with an armorcodex login the plugin loads does not prompt", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "armorcodex-update-v2-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, "home");
  const binDir = join(root, "bin");
  mkdirSync(home, { recursive: true });
  mkdirSync(binDir, { recursive: true });
  stubTools(binDir);
  saveCodexLogin(home);

  const result = await runInstaller(root, home, binDir);

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /ArmorIQ login for ArmorCodex found/);
  assert.doesNotMatch(result.stdout, /Connect your ArmorIQ account now|to authenticate/);
  assert.match(result.stdout, /ArmorCodex is up to date/);
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
    PLUGIN_PATH="${new URL("../plugins/armorcodex", import.meta.url).pathname}"
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
    PLUGIN_PATH="${new URL("../plugins/armorcodex", import.meta.url).pathname}"
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

for (const [version, message] of [
  ["codex-cli 0.161.0", /Codex 0\.162 or newer is required \(found codex-cli 0\.161\.0\)/],
  ["codex-cli dev-build", /could not read the Codex version \(got: codex-cli dev-build\)/],
]) {
  test(`the installer stops before changing anything when codex --version prints ${version}`, async (t) => {
    const root = mkdtempSync(join(tmpdir(), "armorcodex-codex-min-"));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const home = join(root, "home");
    const binDir = join(root, "bin");
    mkdirSync(home, { recursive: true });
    mkdirSync(binDir, { recursive: true });
    stubTools(binDir, version);

    const result = await runInstaller(root, home, binDir);

    assert.notEqual(result.status, 0, result.stdout);
    assert.match(result.stderr, message);
    assert.doesNotMatch(result.stdout, /prerequisites OK/);
    assert.deepEqual(readdirSync(home), []);
  });
}

test("the installer accepts a Codex major version above 0", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "armorcodex-codex-min-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, "home");
  const binDir = join(root, "bin");
  mkdirSync(home, { recursive: true });
  mkdirSync(binDir, { recursive: true });
  stubTools(binDir, "codex-cli 1.0.0");

  const result = await runInstaller(root, home, binDir);

  assert.match(result.stdout, /prerequisites OK \(codex-cli 1\.0\.0/);
});

test("re-running the installer upgrades an SDK left behind in node_modules", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "armorcodex-stale-sdk-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, "home");
  const binDir = join(root, "bin");
  const checkout = join(root, "checkout");
  const plugin = join(checkout, "plugins", "armorcodex");
  mkdirSync(home, { recursive: true });
  mkdirSync(binDir, { recursive: true });
  mkdirSync(plugin, { recursive: true });
  const source = new URL("../plugins/armorcodex/", import.meta.url).pathname;
  cpSync(join(source, "scripts"), join(plugin, "scripts"), { recursive: true });
  for (const name of ["package.json", "package-lock.json"]) cpSync(join(source, name), join(plugin, name));
  cpSync(new URL("../install_armorcodex.sh", import.meta.url).pathname, join(checkout, "install_armorcodex.sh"));
  writeFileSync(join(binDir, "codex"), "#!/bin/sh\necho 'codex-cli 0.162.0'\n");
  chmodSync(join(binDir, "codex"), 0o755);

  const env = {
    ...process.env,
    HOME: home,
    PATH: `${binDir}${delimiter}${process.env.PATH}`,
    NO_COLOR: "1",
    npm_config_cache: process.env.npm_config_cache || join(os.homedir(), ".npm"),
    npm_config_prefix: join(root, "npm-global"),
  };
  const sdkVersion = () =>
    JSON.parse(readFileSync(join(plugin, "node_modules", "@armoriq", "sdk-dev", "package.json"), "utf8")).version;
  const locked = JSON.parse(readFileSync(join(plugin, "package-lock.json"), "utf8"))
    .packages["node_modules/@armoriq/sdk-dev"].version;
  const stale = "0.8.12";
  assert.notEqual(locked, stale);

  const seed = spawnSync("npm", ["install", "--omit=dev", "--no-save", "--no-audit", "--no-fund", `@armoriq/sdk-dev@${stale}`], {
    cwd: plugin,
    encoding: "utf8",
    env,
  });
  assert.equal(seed.status, 0, seed.stderr);
  assert.equal(sdkVersion(), stale);
  saveCodexLogin(home);

  const result = spawnSync("bash", [join(checkout, "install_armorcodex.sh"), "--force-install"], {
    cwd: root,
    encoding: "utf8",
    env,
  });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /installing LOCAL checkout/);
  assert.match(result.stdout, /npm dependencies installed/);
  assert.equal(sdkVersion(), locked);
});

test("a curl re-run over an install left at an old commit moves it to the requested ref and its SDK", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "armorcodex-curl-rerun-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, "home");
  const binDir = join(root, "bin");
  const upstream = join(root, "upstream");
  const upstreamPlugin = join(upstream, "plugins", "armorcodex");
  const installHome = join(home, ".armoriq", "armorCodex");
  mkdirSync(home, { recursive: true });
  mkdirSync(binDir, { recursive: true });
  mkdirSync(upstreamPlugin, { recursive: true });
  const source = new URL("../plugins/armorcodex/", import.meta.url).pathname;
  const installer = new URL("../install_armorcodex.sh", import.meta.url).pathname;
  cpSync(join(source, "scripts"), join(upstreamPlugin, "scripts"), { recursive: true });
  cpSync(installer, join(upstream, "install_armorcodex.sh"));
  writeFileSync(join(binDir, "codex"), "#!/bin/sh\necho 'codex-cli 0.162.0'\n");
  chmodSync(join(binDir, "codex"), 0o755);

  const env = {
    ...process.env,
    HOME: home,
    PATH: `${binDir}${delimiter}${process.env.PATH}`,
    NO_COLOR: "1",
    npm_config_cache: process.env.npm_config_cache || join(os.homedir(), ".npm"),
    npm_config_prefix: join(root, "npm-global"),
    ARMORCODEX_GIT_URL: upstream,
    ARMORCODEX_GIT_REF: "main",
  };
  const run = (cmd, args, cwd) => {
    const result = spawnSync(cmd, args, { cwd, encoding: "utf8", env });
    assert.equal(result.status, 0, `${cmd} ${args.join(" ")}: ${result.stderr}`);
    return result.stdout.trim();
  };
  const git = (args, cwd = upstream) =>
    run("git", ["-c", "user.name=t", "-c", "user.email=t@example.test", "-c", "commit.gpgsign=false", ...args], cwd);
  const stale = "0.8.12";

  git(["init", "--quiet", "-b", "main"]);
  const oldPackage = JSON.parse(readFileSync(join(source, "package.json"), "utf8"));
  oldPackage.dependencies["@armoriq/sdk-dev"] = stale;
  writeFileSync(join(upstreamPlugin, "package.json"), JSON.stringify(oldPackage, null, 2));
  run("npm", ["install", "--package-lock-only", "--no-audit", "--no-fund"], upstreamPlugin);
  git(["add", "-A"]);
  git(["commit", "--quiet", "-m", "old"]);
  const oldCommit = git(["rev-parse", "HEAD"]);

  for (const name of ["package.json", "package-lock.json"]) cpSync(join(source, name), join(upstreamPlugin, name));
  git(["commit", "--quiet", "-am", "new"]);
  const newCommit = git(["rev-parse", "HEAD"]);

  mkdirSync(join(home, ".armoriq"), { recursive: true });
  git(["clone", "--quiet", upstream, installHome], root);
  git(["reset", "--hard", "--quiet", oldCommit], installHome);
  saveCodexLogin(home);

  const result = spawnSync("bash", ["-s", "--", "--force-install"], {
    cwd: root,
    encoding: "utf8",
    env,
    input: readFileSync(installer, "utf8"),
  });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.doesNotMatch(result.stdout, /installing LOCAL checkout/);
  assert.equal(git(["rev-parse", "HEAD"], installHome), newCommit);
  const sdk = JSON.parse(
    readFileSync(join(installHome, "plugins", "armorcodex", "node_modules", "@armoriq", "sdk-dev", "package.json"), "utf8"),
  );
  const locked = JSON.parse(readFileSync(join(source, "package-lock.json"), "utf8"))
    .packages["node_modules/@armoriq/sdk-dev"].version;
  assert.notEqual(locked, stale);
  assert.equal(sdk.version, locked);
});

function git(cwd, ...args) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" } });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

function pluginRepo(root) {
  const work = join(root, "origin-work");
  mkdirSync(join(work, "plugins", "armorcodex", "scripts", "lib"), { recursive: true });
  git(root, "init", "--quiet", "--initial-branch=dev", work);
  git(work, "config", "user.email", "test@example.test");
  git(work, "config", "user.name", "test");
  git(work, "config", "commit.gpgsign", "false");
  writeFileSync(join(work, "plugins", "armorcodex", "scripts", "bootstrap.mjs"), "");
  writeFileSync(
    join(work, "plugins", "armorcodex", "scripts", "lib", "config.mjs"),
    'export const loadConfig = () => ({ apiKey: "ak_test_update" });\n'
  );
  const commit = (version) => {
    writeFileSync(join(work, "plugins", "armorcodex", "package.json"), JSON.stringify({ name: "armorcodex", version }));
    git(work, "add", "-A");
    git(work, "commit", "--quiet", "-m", version);
    return git(work, "rev-parse", "HEAD");
  };
  return { work, commit };
}

function runPipedInstaller(root, home, binDir, env) {
  const script = readFileSync(new URL("../install_armorcodex.sh", import.meta.url));
  return spawnSync("bash", ["-s", "--", "--update"], {
    cwd: root,
    input: script,
    encoding: "utf8",
    env: { ...process.env, HOME: home, PATH: `${binDir}${delimiter}${process.env.PATH}`, NO_COLOR: "1", ...env },
  });
}


test("the dev command's downloaded installer moves an existing dev install to the branch's latest commit", (t) => {
  const root = mkdtempSync(join(tmpdir(), "armorcodex-wrapper-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, "home");
  const binDir = join(root, "bin");
  mkdirSync(join(home, ".codex"), { recursive: true });
  mkdirSync(binDir, { recursive: true });
  stubTools(binDir);
  saveCodexLogin(home);
  const origin = pluginRepo(root);
  origin.commit("0.3.4");
  const installHome = join(home, ".armoriq", "armorCodex");
  git(root, "clone", "--quiet", "--depth", "1", "--branch", "dev", `file://${origin.work}`, installHome);
  const latest = origin.commit("0.3.5");
  const download = mkdtempSync(join(root, "download-"));
  const installer = join(download, "install_armorcodex.sh");
  writeFileSync(installer, readFileSync(new URL("../install_armorcodex.sh", import.meta.url)));

  const result = spawnSync("bash", [installer], {
    cwd: root,
    encoding: "utf8",
    env: {
      ...process.env,
      HOME: home,
      PATH: `${binDir}${delimiter}${process.env.PATH}`,
      ARMORCODEX_GIT_URL: origin.work,
      ARMORCODEX_GIT_REF: "dev",
      ARMORCODEX_INSTALL_HOME: installHome,
    },
  });

  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(git(installHome, "rev-parse", "HEAD"), latest);
  assert.doesNotMatch(result.stdout, /installing LOCAL checkout/);
});

for (const [installed, requested, command] of [
  ["main", "dev", "install_armorcodex.sh"],
  ["dev", "main", "install_armorcodex_dev.sh"],
]) {
  test(`the ${requested === "main" ? "stable" : requested} update command refuses an install on ${installed} and changes nothing`, (t) => {
    const root = mkdtempSync(join(tmpdir(), "armorcodex-channel-"));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const home = join(root, "home");
    const binDir = join(root, "bin");
    mkdirSync(join(home, ".codex"), { recursive: true });
    mkdirSync(binDir, { recursive: true });
    stubTools(binDir);
    saveCodexLogin(home);
    const origin = pluginRepo(root);
    origin.commit("0.3.4");
    git(origin.work, "branch", "main");
    const installHome = join(home, ".armoriq", "armorCodex");
    git(root, "clone", "--quiet", "--depth", "1", "--branch", installed, `file://${origin.work}`, installHome);
    const before = git(installHome, "rev-parse", "HEAD");
    origin.commit("0.3.5");
    git(origin.work, "branch", "-f", "main");

    const result = runPipedInstaller(root, home, binDir, {
      ARMORCODEX_GIT_URL: origin.work,
      ARMORCODEX_GIT_REF: requested,
      ARMORCODEX_INSTALL_HOME: installHome,
    });

    const out = (result.stdout + result.stderr).replace(/\x1b\[[0-9;]*m/g, "");
    assert.equal(result.status, 1, out);
    assert.match(out, new RegExp(`is on ${installed}, not ${requested}`));
    assert.match(out, new RegExp(command.replace(".", "\\.")));
    assert.equal(git(installHome, "rev-parse", "HEAD"), before);
    assert.deepEqual(readdirSync(join(home, ".codex")), []);
  });
}
