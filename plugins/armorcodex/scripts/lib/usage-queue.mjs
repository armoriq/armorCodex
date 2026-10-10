import { readdir, unlink } from "node:fs/promises";
import path from "node:path";
import { ensurePrivateDir, readJson, writeJson } from "./fs-store.mjs";
import {
  acknowledge,
  allocateRevision,
  captureSession,
  changedSnapshots,
  knownDigests,
  newBatchId,
  packBatches,
  refuse,
  setGeneration,
  storedGeneration,
  withFileLock,
} from "./live-usage.mjs";

const QUEUED = /^\d{16}-[0-9a-f-]{36}\.json$/;

export const describe = (r) => (r.status ? `HTTP ${r.status}: ${r.reason}` : r.reason);
export const fenced = (r) => r.status === 409 && /generation/i.test(r.reason ?? "");
export const sessionFile = (dir, sessionId) => path.join(dir, `${sessionId}.json`);

export async function streamGeneration({ config, client, dir }, refresh = false) {
  const stored = refresh ? null : await storedGeneration(dir);
  if (stored) return stored;
  const res = await client.initializeUsageStream();
  if (!res.ok) throw new Error(`could not open the usage stream (${describe(res)})`);
  await setGeneration(dir, res.value.generation);
  return res.value.generation;
}

export async function enqueue(queueDir, items) {
  await ensurePrivateDir(queueDir);
  const first = Date.now() * 1000;
  for (const [i, item] of items.entries()) {
    const order = String(first + i).padStart(16, "0");
    await writeJson(path.join(queueDir, `${order}-${item.batch.batchId}.json`), item);
  }
}

export async function queued(queueDir) {
  const names = (await readdir(queueDir).catch(() => [])).filter((n) => QUEUED.test(n)).sort();
  const items = [];
  for (const name of names) {
    const file = path.join(queueDir, name);
    const item = await readJson(file, null);
    if (item?.batch?.batchId && Array.isArray(item.batch.snapshots)) items.push({ ...item, file });
    else await unlink(file).catch(() => {});
  }
  return items;
}

export const settle = (file) => unlink(file).catch(() => {});

export async function captureChanges(job, { sessionId, transcript, cutoff, generation }) {
  const state = await readJson(sessionFile(job.dir, sessionId), {});
  const revision = await allocateRevision(job.dir);
  const taken = await captureSession({
    dir: job.dir,
    transcript,
    sessionId,
    cutoff: state.admitted ? -Infinity : cutoff,
  });
  const pending = (await queued(job.queueDir)).map((q) => q.batch);
  const known = knownDigests(state, generation, pending, sessionId);
  return { ...taken, snapshots: changedSnapshots({ capture: taken, sessionId, revision, known }) };
}

export const toItems = (snapshots, { generation, deviceName, runId }) =>
  packBatches(snapshots).map((group) => ({
    batch: {
      generation,
      batchId: newBatchId(),
      ...(runId ? { runId } : {}),
      deviceName,
      snapshots: group,
    },
  }));

async function updateSessions(dir, snapshots, change) {
  const bySession = new Map();
  for (const s of snapshots) bySession.set(s.sessionId, [...(bySession.get(s.sessionId) ?? []), s]);
  for (const [sessionId, own] of bySession) {
    const file = sessionFile(dir, sessionId);
    await withFileLock(path.join(dir, `${sessionId}.ack.lock`), async () => {
      await writeJson(file, change(await readJson(file, {}), own));
    });
  }
}

const recordAcks = (dir, { batch, admits }) =>
  updateSessions(dir, batch.snapshots, (state, own) => {
    const acked = acknowledge(state, batch.generation, own);
    return admits ? { ...acked, admitted: true } : acked;
  });

async function setAside(job, { file, ...item }, result) {
  const refused = { status: result.status ?? null, reason: result.reason };
  await writeJson(path.join(job.queueDir, "refused", path.basename(file)), { ...item, refused });
  await updateSessions(job.dir, item.batch.snapshots, refuse);
  await settle(file);
  return { note: `${item.batch.snapshots.length} session-hour(s), ${describe(result)}`, batch: item.batch };
}

async function retryAlone(job, { file, ...item }) {
  const singles = item.batch.snapshots.map((s) => ({
    ...item,
    batch: { ...item.batch, batchId: newBatchId(), snapshots: [s] },
  }));
  await enqueue(job.queueDir, singles);
  await settle(file);
  const ids = new Set(singles.map((s) => s.batch.batchId));
  const outcome = { sent: 0, refused: [] };
  for (const single of (await queued(job.queueDir)).filter((q) => ids.has(q.batch.batchId))) {
    const result = await job.client.recordTokenUsageBatch(single.batch);
    if (result.ok) {
      await recordAcks(job.dir, single);
      await settle(single.file);
      outcome.sent += 1;
    } else if (result.retryable === false)
      outcome.refused.push(await setAside(job, single, result));
  }
  return outcome;
}

async function refuseBatch(job, item, result) {
  if (item.batch.snapshots.length > 1) return retryAlone(job, item);
  return { sent: 0, refused: [await setAside(job, item, result)] };
}

export async function drain(job, dropped = () => false) {
  let sent = 0;
  const refused = [];
  const done = (outcome, result) => ({
    outcome,
    sent,
    refused: refused.map((r) => r.note),
    aside: refused.map((r) => r.batch),
    result,
  });
  for (const item of await queued(job.queueDir)) {
    const result = await job.client.recordTokenUsageBatch(item.batch);
    if (fenced(result)) return done("fenced", result);
    if (!result.ok && dropped(result, item)) {
      await settle(item.file);
      continue;
    }
    if (!result.ok && result.retryable === false) {
      const alone = await refuseBatch(job, item, result);
      sent += alone.sent;
      refused.push(...alone.refused);
      continue;
    }
    if (!result.ok) return done("kept", result);
    await recordAcks(job.dir, item);
    await settle(item.file);
    sent += item.batch.snapshots.length;
  }
  return done("drained");
}

export async function clearQueue(queueDir) {
  for (const { file } of await queued(queueDir)) await settle(file);
}
