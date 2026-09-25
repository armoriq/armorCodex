#!/usr/bin/env node
// Uploads token usage for every local Codex session, with or without
// ArmorCodex, one row per session-day to POST {backendEndpoint}/dashboard/token-usage.
// It is the only writer of those rows. The hook router launches it on
// SessionStart and after each Stop; it can also be run by hand.
//
//   node plugins/armorcodex/scripts/usage-sync.mjs [--dry-run] [--state <path>]
//
// --dry-run : print each row instead of posting it. Needs no API key, ignores
//             the observability and usage sync switches, and keeps its own
//             state file, so it never changes what a real run posts.
// --state   : state file to read and update.

import { homedir } from "node:os";
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { loadConfig } from "./lib/config.mjs";
import { deviceIdentity } from "./lib/device.mjs";
import { writeJson } from "./lib/fs-store.mjs";
import { getSdkClient } from "./lib/intent.mjs";
import { loadRuntimeState } from "./lib/runtime-state.mjs";
import { loadSyncState, syncUsage } from "./lib/usage-sync.mjs";
import { defaultStatePath, isAlive, requestedAt, syncPaths } from "./lib/usage-sync-launch.mjs";

const BUDGET_MS = 90_000;
const HARD_STOP_MS = BUDGET_MS + 30_000;
const DEBOUNCE_MS = 2_000;

const argv = process.argv.slice(2);
const DRY = argv.includes("--dry-run");
const stateIdx = argv.indexOf("--state");
const CODEX_HOME = process.env.CODEX_HOME?.trim() || path.join(homedir(), ".codex");
const ROOTS = [path.join(CODEX_HOME, "sessions"), path.join(CODEX_HOME, "archived_sessions")];

function log(message) {
  process.stderr.write(`[usage-sync] ${new Date().toISOString()} ${message}\n`);
}

async function acquireLock(lockPath) {
  await mkdir(path.dirname(lockPath), { recursive: true });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      await writeFile(lockPath, String(process.pid), { flag: "wx" });
      return () => unlink(lockPath).catch(() => {});
    } catch (err) {
      if (err?.code !== "EEXIST") throw err;
      const owner = Number((await readFile(lockPath, "utf8").catch(() => "")).trim());
      if (owner && isAlive(owner)) return null;
      await unlink(lockPath).catch(() => {});
    }
  }
  return null;
}

// Stops that land within DEBOUNCE_MS of the latest request share one pass.
async function debounce(requestPath, deadline) {
  const wait = Math.min(requestedAt(requestPath) + DEBOUNCE_MS, deadline) - Date.now();
  if (wait > 0) await sleep(wait);
}

async function syncPass({ config, statePath, deadline }) {
  const state = await loadSyncState(statePath);
  const runtime = await loadRuntimeState(config.runtimeFile);
  const { deviceId, deviceName } = deviceIdentity();
  const toBody = (row) => ({ product: config.productSlug, deviceId, deviceName, ...row });
  const client = DRY ? null : getSdkClient(config);
  const post = DRY
    ? async (row) => {
        process.stdout.write(`${JSON.stringify(toBody(row))}\n`);
        return { ok: true };
      }
    : (row) => client.recordTokenUsage(toBody(row));
  const started = Date.now();
  const report = await syncUsage({
    roots: ROOTS,
    state,
    post,
    isArmored: (sessionId) => Boolean(runtime.sessions[sessionId]),
    deadline,
  });
  const { notRead, ...counts } = report;
  state.lastRun = { at: new Date().toISOString(), dryRun: DRY, ...counts };
  await writeJson(statePath, state);
  for (const file of notRead) log(`not read ${file}`);
  const verb = DRY ? "would post" : "posted";
  log(
    `${report.rollouts} rollout(s) under ${ROOTS.join(", ")} (${report.other} other file(s)); ` +
      `${report.changed} changed, ${report.read} read, ${report.sessions} session(s); ` +
      `${verb} ${report.sessionDays} session-day(s) (${report.tokens} tokens), ` +
      `${report.failed} failed, ${report.left} left for the next run, ` +
      `${report.forksWithoutOriginal} fork(s) without their original, ${Date.now() - started}ms`
  );
  if (report.failed) process.exitCode = 1;
}

async function main() {
  const config = loadConfig(process.env);
  if (!DRY && !config.apiKey) {
    log("no API key, nothing synced");
    return;
  }
  if (!DRY && !config.usageSyncEnabled) {
    log("usage sync is off (observability disabled or disable_usage_sync set), nothing synced");
    return;
  }
  const statePath =
    stateIdx >= 0
      ? path.resolve(argv[stateIdx + 1])
      : DRY
        ? path.join(config.dataDir, "usage-sync-dry-run.json")
        : defaultStatePath(config.dataDir);
  const paths = syncPaths(statePath);
  const deadline = Date.now() + BUDGET_MS;
  const hardStop = setTimeout(() => {
    log(`still running after ${HARD_STOP_MS}ms, exiting`);
    process.exit(1);
  }, HARD_STOP_MS);
  hardStop.unref();
  try {
    let passStart = -Infinity;
    // A Stop can touch the request marker after the last pass began but see
    // the lock still held, so the marker is checked again once it is released.
    while (Date.now() < deadline) {
      const release = await acquireLock(paths.lock);
      if (!release) {
        if (passStart === -Infinity) log("another sync holds the lock, skipping");
        return;
      }
      try {
        do {
          await debounce(paths.request, deadline);
          passStart = Date.now();
          await syncPass({ config, statePath, deadline });
        } while (requestedAt(paths.request) >= passStart && Date.now() < deadline);
      } finally {
        await release();
      }
      if (requestedAt(paths.request) < passStart) return;
    }
  } finally {
    clearTimeout(hardStop);
  }
}

main().catch((err) => {
  log(`fatal: ${err?.stack ?? err}`);
  process.exit(1);
});
