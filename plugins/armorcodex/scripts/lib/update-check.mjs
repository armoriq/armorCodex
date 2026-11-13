import path from "node:path";
import { CLIENT } from "./client-identity.mjs";
import { nowEpochSeconds, parseBoolean } from "./common.mjs";
import { readJson, writeJson } from "./fs-store.mjs";

export const GITHUB_API_BASE = "https://api.github.com";
export const RELEASE_REPO = "armoriq/armorCodex";
export const CHECK_INTERVAL_SECONDS = 60 * 60 * 24;
export const CHECK_TIMEOUT_MS = 5000;
export const UPDATE_COMMAND = "curl -fsSL https://armoriq.ai/install_armorcodex.sh | bash";

/**
 * Its own file rather than a key in runtime.json: SessionStart would otherwise
 * read runtime state, spend up to CHECK_TIMEOUT_MS on the network, then write
 * it back over every session and tool mutation the PreToolUse hooks made in
 * that window.
 */
export const UPDATE_STATE_FILENAME = "update-check.json";

const SEMVER = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/;

export function parseVersion(value) {
  if (typeof value !== "string") return null;
  const match = SEMVER.exec(value.trim());
  if (!match) return null;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] ?? ""
  };
}

/** -1, 0 or 1 for an ordered pair; null when either side is not a semver. */
export function compareVersions(left, right) {
  const a = parseVersion(left);
  const b = parseVersion(right);
  if (!a || !b) return null;
  for (const field of ["major", "minor", "patch"]) {
    if (a[field] !== b[field]) return a[field] < b[field] ? -1 : 1;
  }
  if (a.prerelease === b.prerelease) return 0;
  // Semver 11: a prerelease ranks below the release sharing its triple.
  if (!a.prerelease) return 1;
  if (!b.prerelease) return -1;
  return a.prerelease < b.prerelease ? -1 : 1;
}

export function isNewerVersion(candidate, running) {
  return compareVersions(candidate, running) === 1;
}

/**
 * The plugin's own manifest version. `config.clientVersion` overrides it, and
 * `armorcodex/0.3.3` and `armorcodex-dev/0.3.3` both carry 0.3.3.
 */
export function runningVersion(config) {
  const raw = typeof config?.clientVersion === "string" ? config.clientVersion : "";
  if (!raw) return CLIENT.version;
  const slash = raw.lastIndexOf("/");
  return slash === -1 ? raw : raw.slice(slash + 1);
}

export function updateStateFile(config) {
  return path.join(config.dataDir, UPDATE_STATE_FILENAME);
}

function verdict({ checked, latest, running }) {
  const status = !latest || compareVersions(latest, running) === null
    ? "unknown"
    : isNewerVersion(latest, running)
      ? "update-available"
      : "current";
  return {
    checked,
    status,
    latestVersion: latest || "",
    runningVersion: running,
    command: UPDATE_COMMAND
  };
}

async function fetchLatestTag(baseUrl, repo, timeoutMs) {
  const url = `${baseUrl.replace(/\/+$/, "")}/repos/${repo}/releases/latest`;
  const response = await fetch(url, {
    headers: {
      Accept: "application/vnd.github+json",
      "User-Agent": "armorcodex-update-check"
    },
    signal: AbortSignal.timeout(timeoutMs)
  });
  if (!response.ok) return "";
  const body = await response.json();
  return typeof body?.tag_name === "string" ? body.tag_name : "";
}

/**
 * Never throws and never applies anything. The caller gets a verdict it may
 * show the user; applying an update mid-session is out of contract.
 */
export async function checkForUpdate(config, options = {}) {
  const {
    env = process.env,
    baseUrl = env.ARMORCODEX_RELEASE_API?.trim() || GITHUB_API_BASE,
    repo = env.ARMORCODEX_MARKETPLACE_REPO?.trim() || RELEASE_REPO,
    now = nowEpochSeconds(),
    intervalSeconds = CHECK_INTERVAL_SECONDS,
    timeoutMs = CHECK_TIMEOUT_MS
  } = options;

  const running = runningVersion(config);

  if (parseBoolean(env.ARMORCODEX_NO_AUTO_UPDATE, false)) {
    return { checked: false, status: "disabled", latestVersion: "", runningVersion: running, command: UPDATE_COMMAND };
  }

  try {
    const statePath = updateStateFile(config);
    const state = await readJson(statePath, {});
    const cached = typeof state?.latestVersion === "string" ? state.latestVersion : "";
    const lastCheckedAt = Number.isFinite(state?.lastCheckedAt) ? state.lastCheckedAt : 0;

    // `lastCheckedAt <= now` so a clock that jumped backwards cannot park the
    // timestamp in the future and suppress every check from then on.
    if (lastCheckedAt <= now && now - lastCheckedAt < intervalSeconds) {
      return verdict({ checked: false, latest: cached, running });
    }

    let latest = "";
    try {
      latest = await fetchLatestTag(baseUrl, repo, timeoutMs);
    } catch {
      latest = "";
    }

    // lastCheckedAt advances even on a failed fetch, so an offline machine
    // backs off for the full interval instead of retrying every session.
    await writeJson(statePath, { lastCheckedAt: now, latestVersion: latest || cached });
    return verdict({ checked: true, latest: latest || cached, running });
  } catch {
    return { checked: false, status: "unknown", latestVersion: "", runningVersion: running, command: UPDATE_COMMAND };
  }
}

export function updateNotice(result) {
  if (!result || result.status !== "update-available") return "";
  return `ArmorCodex ${result.latestVersion} is available (running ${result.runningVersion}). Update with: ${result.command}`;
}
