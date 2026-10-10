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
  const taken = await captureSession({ dir: job.dir, transcript, sessionId, cutoff });
  const pending = (await queued(job.queueDir)).map((q) => q.batch);
  const known = knownDigests(state, generation, pending, sessionId);
  return { ...taken, snapshots: changedSnapshots({ capture: taken, sessionId, revision, known }) };
}

export const toItems = (snapshots, { generation, deviceName }) =>
  packBatches(snapshots).map((group) => ({
    batch: { generation, batchId: newBatchId(), deviceName, snapshots: group },
  }));

async function recordAcks(dir, { batch }) {
  const bySession = new Map();
  for (const s of batch.snapshots)
    bySession.set(s.sessionId, [...(bySession.get(s.sessionId) ?? []), s]);
  for (const [sessionId, snapshots] of bySession) {
    const file = sessionFile(dir, sessionId);
    await withFileLock(path.join(dir, `${sessionId}.ack.lock`), async () => {
      await writeJson(file, acknowledge(await readJson(file, {}), batch.generation, snapshots));
    });
  }
}

async function setAside(queueDir, { file, ...item }, result) {
  const refused = { status: result.status ?? null, reason: result.reason };
  await writeJson(path.join(queueDir, "refused", path.basename(file)), { ...item, refused });
  await settle(file);
}

export async function drain(job, dropped = () => false) {
  let sent = 0;
  const refused = [];
  for (const item of await queued(job.queueDir)) {
    const result = await job.client.recordTokenUsageBatch(item.batch);
    if (fenced(result)) return { outcome: "fenced", sent, refused, result };
    if (!result.ok && dropped(result, item)) {
      await settle(item.file);
      continue;
    }
    if (!result.ok && result.retryable === false) {
      await setAside(job.queueDir, item, result);
      refused.push(`${item.batch.snapshots.length} session-hour(s), ${describe(result)}`);
      continue;
    }
    if (!result.ok) return { outcome: "kept", sent, refused, result };
    await recordAcks(job.dir, item);
    await settle(item.file);
    sent += item.batch.snapshots.length;
  }
  return { outcome: "drained", sent, refused };
}

export async function clearQueue(queueDir) {
  for (const { file } of await queued(queueDir)) await settle(file);
}
