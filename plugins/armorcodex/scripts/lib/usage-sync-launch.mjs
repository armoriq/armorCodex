import { spawn } from "node:child_process";
import { closeSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { deviceIdentity } from "./device.mjs";
import { ensurePrivateDirSync, openPrivateSync, writePrivateFileSync } from "./fs-store.mjs";
import { codexRoots, isSessionId, liveDir, liveTranscript } from "./live-usage.mjs";
import { anySessionAnswers, endSession, harnessProcess, registerSession } from "./usage-sessions.mjs";

const LOG_MAX_BYTES = 1024 * 1024;
const LIVE_SCRIPT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "usage-live.mjs");
const WORKER_SCRIPT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "usage-worker.mjs");

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

function logSize(logPath) {
  try {
    return statSync(logPath).size;
  } catch {
    return 0;
  }
}

function spawnDetached(config, args) {
  const logPath = path.join(config.dataDir, "usage-sync.log");
  const logFd = openPrivateSync(logPath, logSize(logPath) > LOG_MAX_BYTES ? "w" : "a");
  try {
    const child = spawn(process.execPath, args, {
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
}

const usageDir = (config) =>
  liveDir(config.dataDir, {
    backend: config.backendEndpoint,
    product: config.productSlug,
    userId: config.userId,
    deviceId: deviceIdentity().deviceId,
  });

function ensureWorker(config, dir) {
  if (!lockHeld(path.join(dir, "worker.lock"))) spawnDetached(config, [WORKER_SCRIPT, "--serve"]);
}

async function startSession(config, sessionId) {
  const harness = harnessProcess();
  if (!harness) return;
  const dir = usageDir(config);
  await registerSession(dir, sessionId, harness);
  ensureWorker(config, dir);
}

const TRACKED = new Set(["SessionStart", "SessionEnd"]);

export async function trackUsageSession(event, input, config) {
  if (!TRACKED.has(event) || !config?.usageSyncEnabled || !isSessionId(input?.session_id)) return;
  try {
    await (event === "SessionEnd"
      ? endSession(usageDir(config), input.session_id)
      : startSession(config, input.session_id));
  } catch (err) {
    process.stderr.write(`[armorcodex] usage session tracking failed: ${err?.message ?? err}\n`);
  }
}

export function launchLiveUsage(config, input) {
  if (!config?.usageSyncEnabled) return false;
  const sessionId = input?.session_id;
  const transcript = liveTranscript(codexRoots()[0], sessionId, input?.transcript_path);
  if (!transcript) return false;
  try {
    const dir = usageDir(config);
    ensurePrivateDirSync(dir);
    writePrivateFileSync(path.join(dir, `${sessionId}.pending`), "");
    spawnDetached(config, [LIVE_SCRIPT, sessionId, transcript]);
    if (anySessionAnswers(dir)) ensureWorker(config, dir);
    return true;
  } catch (err) {
    process.stderr.write(`[armorcodex] usage upload failed to start: ${err?.message ?? err}\n`);
    return false;
  }
}
