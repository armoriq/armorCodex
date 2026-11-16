#!/usr/bin/env node
import { existsSync, unlinkSync } from "node:fs";
import path from "node:path";
import { prepareUsage } from "./lib/usage-context.mjs";
import { codexRoots, liveTranscript, tryFileLock } from "./lib/live-usage.mjs";
import {
  captureChanges,
  clearQueue,
  describe,
  drain,
  enqueue,
  streamGeneration,
  toItems,
} from "./lib/usage-queue.mjs";

const HARD_STOP_MS = 120_000;
const [sessionId, transcriptArg] = process.argv.slice(2);

function log(message) {
  process.stderr.write(`[usage-live] ${new Date().toISOString()} ${sessionId} ${message}\n`);
}

async function uploadOnce(job) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const generation = await streamGeneration(job, attempt > 0);
    const taken = await captureChanges(job, { ...job.session, cutoff: job.cutoff, generation });
    for (const p of taken.problems) log(`not read ${p.path} (${p.reason})`);
    for (const w of taken.warnings) log(`counted ${w.path} in full (${w.reason})`);
    await enqueue(job.queueDir, toItems(taken.snapshots, { generation, ...job }));
    const { outcome, sent, refused, result } = await drain(job);
    for (const reason of refused) log(`set aside a batch the backend refused: ${reason}`);
    if (sent) log(`sent ${sent} session-hour(s)`);
    if (outcome === "kept") log(`kept the rest for the next upload: ${describe(result)}`);
    if (outcome !== "fenced") return;
    await clearQueue(job.queueDir);
    log("the usage stream has a new generation, capturing the session again");
  }
}

async function main() {
  const transcript = liveTranscript(codexRoots()[0], sessionId, transcriptArg);
  if (!transcript) return log("not a Codex rollout of this session, nothing sent");
  const context = await prepareUsage(log);
  if (!context) return;
  const job = {
    ...context,
    session: { sessionId, transcript },
    queueDir: path.join(context.dir, `${sessionId}.queue`),
  };
  const lockPath = path.join(job.dir, `${sessionId}.lock`);
  const pendingPath = path.join(job.dir, `${sessionId}.pending`);
  for (;;) {
    const release = await tryFileLock(lockPath);
    if (!release) return;
    try {
      while (existsSync(pendingPath)) {
        unlinkSync(pendingPath);
        await uploadOnce(job);
      }
    } finally {
      await release();
    }
    if (!existsSync(pendingPath)) return;
  }
}

const hardStop = setTimeout(() => {
  log(`still running after ${HARD_STOP_MS}ms, exiting`);
  process.exit(1);
}, HARD_STOP_MS);
hardStop.unref();

main().catch((err) => {
  log(`failed: ${err?.message ?? err}`);
  process.exitCode = 1;
});
