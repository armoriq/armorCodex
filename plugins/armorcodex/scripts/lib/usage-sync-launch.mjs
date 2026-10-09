import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ensurePrivateDirSync, openPrivateSync, writePrivateFileSync } from "./fs-store.mjs";

const LOG_MAX_BYTES = 1024 * 1024;
const SCRIPT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "usage-sync.mjs");

/**
 * The lock a running sync holds and the request marker a Stop touches to ask
 * for another pass. Hooks use the data dir's pair, whichever user's key is in
 * use; the marker holds the requesting key's fingerprint.
 */
export function syncPaths(base) {
  return { lock: `${base}.lock`, request: `${base}.request` };
}

export function syncBasePath(dataDir) {
  return path.join(dataDir, "usage-sync");
}

export function keyFingerprint(apiKey) {
  return createHash("sha256")
    .update(apiKey ?? "")
    .digest("hex")
    .slice(0, 16);
}

export function userStatePath(dataDir, { backend, product, userId }) {
  const id = createHash("sha256")
    .update(JSON.stringify([backend.replace(/\/+$/, ""), product, userId]))
    .digest("hex")
    .slice(0, 32);
  return path.join(syncBasePath(dataDir), `${id}.json`);
}

export function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err?.code === "EPERM";
  }
}

function lockHeld(lockPath) {
  try {
    const owner = Number(readFileSync(lockPath, "utf8").trim());
    return Boolean(owner) && isAlive(owner);
  } catch {
    return false;
  }
}

/** Last time a pass was requested, in epoch ms; 0 when none was. */
export function requestedAt(requestPath) {
  try {
    return statSync(requestPath).mtimeMs;
  } catch {
    return 0;
  }
}

/** requestedAt, or 0 when the latest request came from another key. */
export function requestedFor(requestPath, fingerprint) {
  try {
    if (readFileSync(requestPath, "utf8").trim() !== fingerprint) return 0;
  } catch {
    return 0;
  }
  return requestedAt(requestPath);
}

function logSize(logPath) {
  try {
    return statSync(logPath).size;
  } catch {
    return 0;
  }
}

/**
 * Start scripts/usage-sync.mjs as a detached process with this hook's
 * environment, and return without waiting for it. Its stderr goes to
 * usage-sync.log in the data dir. Starts nothing while a live sync holds the
 * lock. Returns false when the config disables the usage sync (no API key,
 * observability off, or `disable_usage_sync` set) or the process could not be
 * started.
 */
export function launchUsageSync(config) {
  if (!config?.usageSyncEnabled) return false;
  try {
    ensurePrivateDirSync(config.dataDir);
    if (lockHeld(syncPaths(syncBasePath(config.dataDir)).lock)) return true;
    const logPath = path.join(config.dataDir, "usage-sync.log");
    const logFd = openPrivateSync(logPath, logSize(logPath) > LOG_MAX_BYTES ? "w" : "a");
    try {
      const child = spawn(process.execPath, [SCRIPT], {
        detached: true,
        stdio: ["ignore", "ignore", logFd],
        cwd: config.dataDir,
      });
      child.once("error", (err) => {
        process.stderr.write(`[armorcodex] usage sync failed to start: ${err?.message ?? err}\n`);
      });
      child.unref();
    } finally {
      closeSync(logFd);
    }
    return true;
  } catch (err) {
    process.stderr.write(`[armorcodex] usage sync failed to start: ${err?.message ?? err}\n`);
    return false;
  }
}

/**
 * Ask for a sync pass that starts after now: touch the request marker, then
 * launch a sync unless one is running. A running sync checks the marker after
 * each pass and after releasing its lock, so it runs again instead.
 */
export function requestUsageSync(config) {
  if (!config?.usageSyncEnabled) return false;
  try {
    writePrivateFileSync(
      syncPaths(syncBasePath(config.dataDir)).request,
      keyFingerprint(config.apiKey)
    );
  } catch (err) {
    process.stderr.write(`[armorcodex] usage sync request failed: ${err?.message ?? err}\n`);
    return false;
  }
  return launchUsageSync(config);
}
