import { spawn } from "node:child_process";
import { closeSync, mkdirSync, openSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const LOG_MAX_BYTES = 1024 * 1024;
const SCRIPT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "usage-sync.mjs");

export function syncPaths(statePath) {
  return { lock: `${statePath}.lock`, request: `${statePath}.request` };
}

export function defaultStatePath(dataDir) {
  return path.join(dataDir, "usage-sync-state.json");
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

export function requestedAt(requestPath) {
  try {
    return statSync(requestPath).mtimeMs;
  } catch {
    return 0;
  }
}

function logSize(logPath) {
  try {
    return statSync(logPath).size;
  } catch {
    return 0;
  }
}

export function launchUsageSync(config) {
  if (!config?.usageSyncEnabled) return false;
  try {
    mkdirSync(config.dataDir, { recursive: true });
    if (lockHeld(syncPaths(defaultStatePath(config.dataDir)).lock)) return true;
    const logPath = path.join(config.dataDir, "usage-sync.log");
    const logFd = openSync(logPath, logSize(logPath) > LOG_MAX_BYTES ? "w" : "a");
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

export function requestUsageSync(config) {
  if (!config?.usageSyncEnabled) return false;
  try {
    mkdirSync(config.dataDir, { recursive: true });
    writeFileSync(syncPaths(defaultStatePath(config.dataDir)).request, String(Date.now()));
  } catch (err) {
    process.stderr.write(`[armorcodex] usage sync request failed: ${err?.message ?? err}\n`);
    return false;
  }
  return launchUsageSync(config);
}
