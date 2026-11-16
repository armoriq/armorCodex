import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync, renameSync, rmSync, statSync } from "node:fs";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseBoolean } from "./common.mjs";
import { UPDATE_COMMAND, checkForUpdate, isNewerVersion, runningVersion, updateNotice } from "./update-check.mjs";

export const STAGE_MARKER = ".armorcodex-staged.json";
export const DEFAULT_GIT_URL = "https://github.com/armoriq/armorCodex.git";

const PLUGIN_SUBDIR = path.join("plugins", "armorcodex");

/**
 * The marker lives under the gitignored node_modules so the tree stays clean
 * once it is swapped in. A marker tracked by git would show up as a local
 * modification and block every later swap.
 */
export function stageMarkerPath(root) {
  return path.join(root, PLUGIN_SUBDIR, "node_modules", STAGE_MARKER);
}
const GIT_STATUS_TIMEOUT_MS = 5000;
const CLONE_TIMEOUT_MS = 5 * 60 * 1000;
const INSTALL_TIMEOUT_MS = 10 * 60 * 1000;

/**
 * A staging directory left behind by a killed stager would otherwise block
 * every later attempt, so one older than this is treated as abandoned.
 */
const STALE_STAGING_MS = 60 * 60 * 1000;

export function autoUpdateDisabled(env = process.env) {
  return parseBoolean(env.ARMORCODEX_NO_AUTO_UPDATE, false);
}

export function defaultInstallHome(env = process.env) {
  return env.ARMORCODEX_INSTALL_HOME?.trim() || path.join(homedir(), ".armoriq", "armorCodex");
}

/** The repo root this running copy was loaded from: scripts/lib -> repo root. */
export function runningInstallRoot() {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");
}

export function stagePaths(installHome) {
  return {
    live: installHome,
    staged: `${installHome}.staged`,
    staging: `${installHome}.staging`,
    previous: `${installHome}.previous`
  };
}

/** The pin the release's installer would hand `npm install -g`. */
export function readSdkCliSpec(root) {
  try {
    const text = readFileSync(path.join(root, "install_armorcodex.sh"), "utf8");
    const match = /ARMORCODEX_SDK_CLI_SPEC:-([^}]+)\}/.exec(text) ?? /npm install -g "?(@armoriq\/[^"\s]+)/.exec(text);
    return match ? match[1].trim() : "";
  } catch {
    return "";
  }
}

/**
 * The marker of a staged tree that is complete enough to swap in, or null.
 * The marker is written last, so its presence plus the files the hooks
 * actually load is what makes a tree eligible.
 */
export function inspectStagedTree(staged) {
  let marker;
  try {
    marker = JSON.parse(readFileSync(stageMarkerPath(staged), "utf8"));
  } catch {
    return null;
  }
  if (typeof marker?.version !== "string" || !marker.version) return null;

  const pluginDir = path.join(staged, PLUGIN_SUBDIR);
  let dependencies;
  try {
    dependencies = Object.keys(JSON.parse(readFileSync(path.join(pluginDir, "package.json"), "utf8")).dependencies ?? {});
  } catch {
    return null;
  }
  const required = [
    path.join(pluginDir, "scripts", "bootstrap.mjs"),
    path.join(pluginDir, "scripts", "hook-router.mjs"),
    ...dependencies.map((name) => path.join(pluginDir, "node_modules", ...name.split("/"), "package.json"))
  ];
  return required.every((file) => existsSync(file)) ? marker : null;
}

export function isDevChannel(root) {
  try {
    return readFileSync(path.join(root, ".git", "HEAD"), "utf8").trim() === "ref: refs/heads/dev";
  } catch {
    return false;
  }
}

function isStaleStaging(staging, now = Date.now()) {
  try {
    return now - statSync(staging).mtimeMs > STALE_STAGING_MS;
  } catch {
    return false;
  }
}

function isCleanCheckout(dir, env) {
  if (!existsSync(path.join(dir, ".git"))) return false;
  const result = spawnSync("git", ["-C", dir, "status", "--porcelain"], {
    encoding: "utf8",
    env,
    timeout: GIT_STATUS_TIMEOUT_MS
  });
  if (result.error || result.status !== 0 || typeof result.stdout !== "string") return false;
  return result.stdout.trim() === "";
}

/**
 * Swap a prepared tree in by rename so the install path never changes, which
 * is what keeps the absolute paths in ~/.codex/hooks.json valid. Synchronous
 * and never throws: a failure means "stay on the current version".
 */
export function swapStagedUpdate(options = {}) {
  const env = options.env ?? process.env;
  const installHome = options.installHome ?? defaultInstallHome(env);
  const running = options.running ?? "";

  if (autoUpdateDisabled(env)) return { swapped: false, reason: "disabled" };

  const paths = stagePaths(installHome);
  try {
    if (!existsSync(paths.staged)) return { swapped: false, reason: "nothing-staged" };

    const marker = inspectStagedTree(paths.staged);
    if (!marker) return { swapped: false, reason: "incomplete" };
    if (!isNewerVersion(marker.version, running)) return { swapped: false, reason: "not-newer" };
    if (!isCleanCheckout(paths.live, env)) return { swapped: false, reason: "dirty" };

    rmSync(paths.previous, { recursive: true, force: true });
    renameSync(paths.live, paths.previous);
    try {
      renameSync(paths.staged, paths.live);
    } catch (error) {
      renameSync(paths.previous, paths.live);
      throw error;
    }

    const stagedSpec = typeof marker.sdkCliSpec === "string" ? marker.sdkCliSpec : "";
    const livedSpec = readSdkCliSpec(paths.previous);
    return {
      swapped: true,
      version: marker.version,
      previousVersion: running,
      previousPath: paths.previous,
      sdkCliSpec: stagedSpec,
      sdkCliSpecChanged: Boolean(stagedSpec) && Boolean(livedSpec) && stagedSpec !== livedSpec
    };
  } catch {
    return { swapped: false, reason: "swap-failed" };
  }
}

export function swapNotice(swap) {
  if (!swap?.swapped) return "";
  const lines = [
    `ArmorCodex updated to ${swap.version} (was ${swap.previousVersion || "an earlier build"}).` +
      ` The replaced version is kept at ${swap.previousPath}.`
  ];
  if (swap.sdkCliSpecChanged) {
    // The plugin now runs ahead of the globally installed CLI that writes
    // ~/.armoriq/credentials.json. Auto-apply deliberately does not touch a
    // machine-wide npm install, so the skew is announced instead of hidden.
    lines.push(
      `This release expects the ArmorIQ CLI at ${swap.sdkCliSpec}, which is not installed automatically.` +
        ` Run: ${UPDATE_COMMAND}`
    );
  }
  return lines.join("\n");
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: "utf8", ...options });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} exited ${result.status}: ${result.stderr || ""}`.trim());
  }
}

/**
 * Prepare the release named by `tag` in a sibling directory. Runs in a
 * detached child so a session never waits on a clone or a dependency install,
 * and never touches the live tree.
 */
export async function stageUpdate(options = {}) {
  const env = options.env ?? process.env;
  const installHome = options.installHome ?? defaultInstallHome(env);
  const tag = (options.tag ?? "").trim();
  const gitUrl = options.gitUrl ?? env.ARMORCODEX_GIT_URL?.trim() ?? "";
  if (!tag) return { staged: false, reason: "no-tag" };

  const paths = stagePaths(installHome);
  await mkdir(path.dirname(installHome), { recursive: true });

  try {
    await mkdir(paths.staging);
  } catch (error) {
    if (error?.code !== "EEXIST") return { staged: false, reason: "claim-failed" };
    if (!isStaleStaging(paths.staging)) return { staged: false, reason: "in-progress" };
    await rm(paths.staging, { recursive: true, force: true });
    await mkdir(paths.staging);
  }

  try {
    run("git", ["clone", "--quiet", "--depth", "1", "--branch", tag, gitUrl || DEFAULT_GIT_URL, paths.staging], {
      env,
      timeout: CLONE_TIMEOUT_MS
    });

    const pluginDir = path.join(paths.staging, PLUGIN_SUBDIR);
    if (!existsSync(path.join(pluginDir, "scripts", "bootstrap.mjs"))) {
      throw new Error("staged tree has no plugins/armorcodex/scripts/bootstrap.mjs");
    }

    // `npm ci`, not `npm install`: it installs exactly the lockfile and never
    // rewrites it. A rewritten lockfile is a tracked modification, which would
    // leave the swapped-in tree dirty and block every later swap.
    run("npm", ["ci", "--omit=dev", "--silent", "--no-audit", "--no-fund"], {
      cwd: pluginDir,
      env,
      timeout: INSTALL_TIMEOUT_MS
    });

    const version = JSON.parse(readFileSync(path.join(pluginDir, "package.json"), "utf8")).version;
    if (typeof version !== "string" || !version) throw new Error("staged plugin package.json has no version");

    await writeFile(
      stageMarkerPath(paths.staging),
      `${JSON.stringify({ version, tag, stagedAt: new Date().toISOString(), sdkCliSpec: readSdkCliSpec(paths.staging) }, null, 2)}\n`,
      "utf8"
    );

    await rm(paths.staged, { recursive: true, force: true });
    await rename(paths.staging, paths.staged);
    return { staged: true, version, tag };
  } catch (error) {
    await rm(paths.staging, { recursive: true, force: true }).catch(() => {});
    return { staged: false, reason: error instanceof Error ? error.message : String(error) };
  }
}

function stagerScript() {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "stage-update.mjs");
}

/** Start staging out of band. Returns as soon as the child is spawned. */
export function scheduleStaging(options = {}) {
  const env = options.env ?? process.env;
  if (autoUpdateDisabled(env)) return { started: false, reason: "disabled" };

  const installHome = options.installHome ?? defaultInstallHome(env);
  const tag = (options.tag ?? "").trim();
  const running = options.running ?? "";
  if (!tag || !isNewerVersion(tag, running)) return { started: false, reason: "not-newer" };

  const paths = stagePaths(installHome);
  try {
    if (!existsSync(path.join(paths.live, ".git"))) return { started: false, reason: "not-managed" };

    const staged = inspectStagedTree(paths.staged);
    if (staged && !isNewerVersion(tag, staged.version)) return { started: false, reason: "already-staged" };
    if (existsSync(paths.staging) && !isStaleStaging(paths.staging)) return { started: false, reason: "in-progress" };

    const child = spawn(process.execPath, [stagerScript()], {
      detached: true,
      stdio: "ignore",
      env: {
        ...env,
        ARMORCODEX_STAGE_INSTALL_HOME: installHome,
        ARMORCODEX_STAGE_TAG: tag
      }
    });
    child.unref();
    return { started: true, tag };
  } catch {
    return { started: false, reason: "spawn-failed" };
  }
}

/**
 * The whole auto-update step for SessionStart. Swallows everything: this runs
 * on the fail-closed enforcement path, where a throw becomes a denied tool
 * call, so a broken updater must degrade to "stay on the current version".
 */
export async function autoUpdate(config, options = {}) {
  try {
    const env = options.env ?? process.env;
    const installHome = options.installHome ?? defaultInstallHome(env);
    const liveRoot = options.liveRoot ?? runningInstallRoot();

    // Releases are cut from main. A dev-channel install tracks the dev branch
    // and must be neither told about nor moved onto a stable release.
    if (isDevChannel(liveRoot)) return { notice: "", swapped: false, reason: "dev-channel" };

    const running = runningVersion(config);
    const check = options.check ?? (await checkForUpdate(config, { env }));

    // A developer checkout run in place is not the managed install, and must
    // never be renamed out from under its owner.
    if (path.resolve(liveRoot) !== path.resolve(installHome)) {
      return { notice: updateNotice(check), swapped: false, reason: "not-managed" };
    }

    const swap = swapStagedUpdate({ installHome, running, env });
    if (swap.swapped) return { notice: swapNotice(swap), swapped: true, version: swap.version };

    const latest = check?.status === "update-available" ? check.latestVersion : "";
    scheduleStaging({ installHome, tag: latest, running, env });
    return { notice: updateNotice(check), swapped: false, reason: swap.reason };
  } catch {
    return { notice: "", swapped: false, reason: "error" };
  }
}
