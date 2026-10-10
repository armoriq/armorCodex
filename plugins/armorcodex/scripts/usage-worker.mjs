#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { readFileSync, unlinkSync } from "node:fs";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { pendingHistorySync } from "./lib/history-request.mjs";
import { readJson, writeJson } from "./lib/fs-store.mjs";
import { allSessions, sessionFingerprint, tryFileLock } from "./lib/live-usage.mjs";
import { prepareUsage } from "./lib/usage-context.mjs";
import { anySessionAnswers, liveSessions } from "./lib/usage-sessions.mjs";
import {
  captureChanges,
  clearQueue,
  describe,
  drain,
  enqueue,
  queued,
  sessionFile,
  settle,
  streamGeneration,
  toItems,
} from "./lib/usage-queue.mjs";

const SERVE = process.argv.includes("--serve");
const BUDGET_MS = 75_000;
const HARD_STOP_MS = 120_000;
const INTERVAL_MS = 60_000;
const RETRY_MIN_MS = 30_000;
const RETRY_MAX_MS = 15 * 60_000;
const WATCH_MS = 2_000;

function log(message) {
  process.stderr.write(`[usage-worker] ${new Date().toISOString()} ${message}\n`);
}

const cancelled = (r) => r.status === 409 && /no longer current/i.test(r.reason ?? "");
const hourOf = (s) => `${s.sessionId}|${s.usageDate}|${s.usageHour}`;
const newRun = (mode, requestId) => ({
  mode,
  runId: randomUUID(),
  ...(requestId ? { requestId } : {}),
  sequence: 0,
  hours: [],
  scanned: [],
  manifestDone: false,
});

async function report(job, run, phase, errorCode, retryAt) {
  run.sequence += 1;
  const res = await job.client.reportUsageRun(run.runId, {
    mode: run.mode,
    ...(run.requestId ? { requestId: run.requestId } : {}),
    sequence: run.sequence,
    phase,
    discovered: run.hours.length,
    ...(run.manifestDone ? { total: run.hours.length } : {}),
    ...(retryAt ? { retryAt } : {}),
    ...(errorCode ? { errorCode } : {}),
  });
  if (!res.ok) log(`could not report the ${run.mode} run (${describe(res)})`);
  return res;
}

async function flush(job, run, found, generation) {
  if (found.snapshots.length) {
    const opened = run.sequence === 0 ? await report(job, run, "discovering") : { ok: true };
    if (!opened.ok) return opened;
    const items = toItems(found.snapshots, { generation, ...job, runId: run.runId });
    await enqueue(
      job.queueDir,
      items.map((i) => ({ ...i, admits: run.mode === "history" }))
    );
    run.hours = [...new Set([...run.hours, ...found.snapshots.map(hourOf)])];
  }
  Object.assign(job.state.seen, found.seen);
  run.scanned.push(...found.scanned);
  return null;
}

async function capturedSince(job, session, history, awaitingHistory) {
  if (!history && awaitingHistory.has(session.sessionId)) return null;
  const { admitted } = await readJson(sessionFile(job.dir, session.sessionId), {});
  const seen = history ? null : sessionFingerprint(session, admitted || job.cutoff);
  if (seen && job.state.seen[session.sessionId] === seen) return null;
  return { seen, cutoff: history ? -Infinity : job.cutoff };
}

async function scan(job, run, sessions, generation, save) {
  const history = run.mode === "history";
  const awaitingHistory = new Set(
    (await queued(job.queueDir))
      .filter((i) => i.admits)
      .flatMap((i) => i.batch.snapshots.map((s) => s.sessionId))
  );
  const found = { snapshots: [], seen: {}, scanned: [] };
  let unread = 0;
  let finished = true;
  for (const session of sessions) {
    if (Date.now() > job.deadline) {
      finished = false;
      break;
    }
    const plan = await capturedSince(job, session, history, awaitingHistory);
    if (!plan) continue;
    const taken = await captureChanges(job, { ...session, cutoff: plan.cutoff, generation });
    for (const p of taken.problems) log(`not read ${p.path} (${p.reason})`);
    for (const w of taken.warnings) log(`counted ${w.path} in full (${w.reason})`);
    found.snapshots.push(...taken.snapshots);
    if (taken.problems.length) unread += 1;
    else if (plan.seen) found.seen[session.sessionId] = plan.seen;
    else if (history) found.scanned.push(session.sessionId);
  }
  const refused = await flush(job, run, found, generation);
  if (refused) return { unread, refused };
  run.manifestDone = finished;
  await save();
  return { unread, finished };
}

function phaseOf({ unread, finished }, left, outcome) {
  if (finished && !left && !unread) return ["complete"];
  const failed = outcome === "kept" ? "upload_failed" : undefined;
  return [failed ? "retrying" : "uploading", unread ? "source_unreadable" : failed];
}

const retryAtFor = (job, phase) =>
  job.serve && phase === "retrying" && job.retryInMs !== null
    ? new Date(Date.now() + job.retryInMs).toISOString()
    : undefined;

function logCompletion(run, res) {
  if (run.mode !== "history") return;
  log(
    res.value?.historyCompleted
      ? `completed the history request ${run.requestId}`
      : `the history request ${run.requestId} was replaced or cancelled before it completed`
  );
}

async function settleRun(job, run, scanned, outcome) {
  const left = (await queued(job.queueDir)).some((i) => i.batch.runId === run.runId);
  if (run.mode === "discovery" && run.sequence === 0 && !left) return;
  const [phase, errorCode] = phaseOf(scanned, left, outcome);
  const res = await report(job, run, phase, errorCode, retryAtFor(job, phase));
  if (!res.ok || phase !== "complete") return;
  logCompletion(run, res);
  job.state[run.mode] = null;
}

function planRetry(job, outcome, result) {
  if (outcome !== "kept") {
    job.failures = 0;
    job.retryInMs = null;
    return;
  }
  job.retryInMs = result?.retryAfterMs ?? Math.min(RETRY_MIN_MS * 2 ** job.failures, RETRY_MAX_MS);
  job.failures += 1;
}

async function replaceHistory(job, requestId) {
  const old = job.state.history;
  if ((old?.requestId ?? null) === requestId) return;
  for (const item of await queued(job.queueDir))
    if (old && item.batch.runId === old.runId) await settle(item.file);
  job.state.history = requestId ? newRun("history", requestId) : null;
}

async function openRuns(job) {
  const { state } = job;
  const request = await pendingHistorySync(job.config, job.deviceId);
  if (!request.ok) log(`could not read the history request (${request.reason})`);
  const requestId = request.ok ? request.requestId : (state.history?.requestId ?? null);
  await replaceHistory(job, requestId);
  state.discovery = { ...(state.discovery ?? newRun("discovery")), manifestDone: false };
  return [state.discovery, state.history].filter(Boolean);
}

function forgetRefused(job, batches) {
  for (const batch of batches) {
    const run = [job.state.discovery, job.state.history].find((r) => r?.runId === batch.runId);
    const refused = new Set(batch.snapshots.map(hourOf));
    if (run) run.hours = run.hours.filter((hour) => !refused.has(hour));
  }
}

async function drainRuns(job, historyRefused) {
  let dropped = cancelled(historyRefused ?? {});
  const result = await drain(job, (res, item) => {
    const current = item.batch.runId === job.state.history?.runId;
    dropped ||= current && cancelled(res);
    return cancelled(res) || (current && dropped);
  });
  for (const reason of result.refused) log(`set aside a batch the backend refused: ${reason}`);
  forgetRefused(job, result.aside);
  if (result.sent) log(`sent ${result.sent} session-hour(s)`);
  if (result.outcome === "kept") log(`kept the rest for the next run: ${describe(result.result)}`);
  if (dropped) job.state.history = null;
  planRetry(job, result.outcome, result.result);
  return result.outcome;
}

async function pass(job, generation) {
  const save = () => writeJson(job.statePath, job.state);
  const sessions = await allSessions(job.dir);
  const scans = new Map();
  for (const run of await openRuns(job)) {
    const todo = sessions.filter((s) => !run.scanned.includes(s.sessionId));
    scans.set(run, await scan(job, run, todo, generation, save));
  }
  const outcome = await drainRuns(job, scans.get(job.state.history)?.refused);
  if (outcome === "fenced") return outcome;
  for (const [run, scanned] of scans)
    if (job.state[run.mode] === run) await settleRun(job, run, scanned, outcome);
  await save();
  return outcome;
}

async function runPasses(job) {
  job.deadline = Date.now() + BUDGET_MS;
  for (let attempt = 0; attempt < 2; attempt++) {
    const outcome = await pass(job, await streamGeneration(job, attempt > 0));
    if (outcome !== "fenced") return;
    await clearQueue(job.queueDir);
    job.state = { seen: {} };
    await writeJson(job.statePath, job.state);
    log("the usage stream has a new generation, starting over");
  }
}

async function tick(job) {
  try {
    await runPasses(job);
  } catch (err) {
    log(`pass failed: ${err?.message ?? err}`);
    planRetry(job, "kept");
  }
  return job.retryInMs ?? INTERVAL_MS;
}

function exitWhenClosed(job, lockPath) {
  if (anySessionAnswers(job.dir)) return;
  log("the last session closed, exiting");
  try {
    if (readFileSync(lockPath, "utf8").trim() === String(process.pid)) unlinkSync(lockPath);
  } finally {
    process.exit(0);
  }
}

async function sameLogin(job) {
  const current = await prepareUsage(log);
  if (current?.dir !== job.dir) return false;
  Object.assign(job, { config: current.config, client: current.client, cutoff: current.cutoff });
  return true;
}

async function serve(job, lockPath) {
  const watch = setInterval(() => exitWhenClosed(job, lockPath), WATCH_MS);
  try {
    for (;;) {
      if (!(await liveSessions(job.dir))) return log("no live session left, exiting");
      if (!(await sameLogin(job))) return log("the login changed, exiting");
      await sleep(await tick(job));
    }
  } finally {
    clearInterval(watch);
  }
}

async function main() {
  const context = await prepareUsage(log);
  if (!context) return;
  const lockPath = path.join(context.dir, "worker.lock");
  const release = await tryFileLock(lockPath);
  if (!release) return log("another usage worker is running");
  try {
    const statePath = path.join(context.dir, "worker.json");
    const state = { seen: {}, ...(await readJson(statePath, {})) };
    const queueDir = path.join(context.dir, "worker.queue");
    const job = {
      ...context,
      state,
      statePath,
      queueDir,
      serve: SERVE,
      failures: 0,
      retryInMs: null,
    };
    await (SERVE ? serve(job, lockPath) : runPasses(job));
  } finally {
    await release();
  }
}

if (!SERVE) {
  setTimeout(() => {
    log(`still running after ${HARD_STOP_MS}ms, exiting`);
    process.exit(1);
  }, HARD_STOP_MS).unref();
}

main().catch((err) => {
  log(`failed: ${err?.message ?? err}`);
  process.exitCode = 1;
});
