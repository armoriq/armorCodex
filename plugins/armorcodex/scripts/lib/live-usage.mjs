import { createHash, randomUUID } from "node:crypto";
import { statSync } from "node:fs";
import { readFile, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import armoriqSdk from "@armoriq/sdk-dev";
import { ensurePrivateDir, PRIVATE_FILE_MODE, readJson, writeJson } from "./fs-store.mjs";
import { validHistory } from "./login-ownership.mjs";
import { isAlive } from "./usage-sync-launch.mjs";
import { captureCodexSession, listSessions, rolloutOf } from "./rollout-session.mjs";

const { MAX_BATCH_BYTES, MAX_BATCH_ENTRIES, MAX_BATCH_SNAPSHOTS, usageCallRecords } = armoriqSdk;
const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const LOCK_WAIT_MS = 5_000;


export const codexHome = () => process.env.CODEX_HOME?.trim() || path.join(homedir(), ".codex");

export const codexRoots = () => [path.join(codexHome(), "sessions"), path.join(codexHome(), "archived_sessions")];

export function loginCutoff(config) {
  const history = config.loginHistory;
  const last = history?.events?.at(-1);
  const accepted =
    validHistory(history) && last.userId === config.userId && last.at === config.loggedInAt;
  return accepted ? Date.parse(config.loggedInAt) : null;
}

export const isSessionId = (id) => typeof id === "string" && SESSION_ID.test(id);

export function liveTranscript(sessionsRoot, sessionId, transcriptPath) {
  if (!isSessionId(sessionId)) return null;
  if (typeof transcriptPath !== "string" || !path.isAbsolute(transcriptPath)) return null;
  const resolved = path.resolve(transcriptPath);
  const inside = resolved.startsWith(path.resolve(sessionsRoot) + path.sep);
  return inside && rolloutOf(resolved)?.id === sessionId.toLowerCase() ? resolved : null;
}

export function liveDir(dataDir, { backend, product, userId, deviceId }) {
  const id = createHash("sha256")
    .update(JSON.stringify([backend.replace(/\/+$/, ""), product, userId, deviceId]))
    .digest("hex")
    .slice(0, 32);
  return path.join(dataDir, "usage-live", id);
}

export async function tryFileLock(lockPath) {
  await ensurePrivateDir(path.dirname(lockPath));
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      await writeFile(lockPath, String(process.pid), { flag: "wx", mode: PRIVATE_FILE_MODE });
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

export async function withFileLock(lockPath, fn, waitMs = LOCK_WAIT_MS) {
  const until = Date.now() + waitMs;
  let release = await tryFileLock(lockPath);
  while (!release) {
    if (Date.now() > until) throw new Error(`${lockPath} is held by another process`);
    await sleep(25);
    release = await tryFileLock(lockPath);
  }
  try {
    return await fn();
  } finally {
    await release();
  }
}

export function allocateRevision(dir) {
  const file = path.join(dir, "stream.json");
  return withFileLock(path.join(dir, "stream.lock"), async () => {
    const stream = await readJson(file, {});
    const revision = (Number.isSafeInteger(stream.revision) ? stream.revision : 0) + 1;
    await writeJson(file, { ...stream, revision });
    return revision;
  });
}

export function setGeneration(dir, generation) {
  const file = path.join(dir, "stream.json");
  return withFileLock(path.join(dir, "stream.lock"), async () => {
    await writeJson(file, { ...(await readJson(file, {})), generation });
  });
}

export async function storedGeneration(dir) {
  return (await readJson(path.join(dir, "stream.json"), {})).generation ?? null;
}

const hourKey = (h) => `${h.usageDate}T${String(h.usageHour).padStart(2, "0")}`;
const digest = (entries) => createHash("sha256").update(JSON.stringify(entries)).digest("hex");

const indexPath = (dir) => path.join(dir, "rollout-index.json");

export const captureSession = ({ dir, transcript, sessionId, cutoff }) =>
  captureCodexSession({ roots: codexRoots(), transcript, sessionId, cutoff, indexPath: indexPath(dir) });

export const allSessions = (dir) => listSessions({ roots: codexRoots(), indexPath: indexPath(dir) });

export function sessionFingerprint({ members }, key) {
  const stats = members.map((file) => {
    const st = statSync(file, { throwIfNoEntry: false });
    return [file, st?.size ?? null, st?.mtimeMs ?? null];
  });
  return digest([key, stats]);
}

const acknowledgedIn = (state, generation) =>
  state.generation === generation ? (state.acknowledged ?? {}) : {};

export function knownDigests(state, generation, pendingBatches, sessionId) {
  const known = { ...state.refused, ...acknowledgedIn(state, generation) };
  for (const batch of pendingBatches.filter((b) => b.generation === generation))
    for (const s of batch.snapshots)
      if (s.sessionId === sessionId) known[hourKey(s)] = digest(s.entries);
  return known;
}

export function changedSnapshots({ capture, sessionId, revision, known = {} }) {
  return capture.hours
    .filter((h) => known[hourKey(h)] !== digest(h.entries))
    .map((h) => ({
      sessionId,
      usageDate: h.usageDate,
      usageHour: h.usageHour,
      revision,
      armored: true,
      ...(capture.repo ? { repo: capture.repo.slice(0, 200) } : {}),
      entries: h.entries,
      calls: h.calls ?? [],
    }));
}

export function acknowledge(state, generation, snapshots) {
  const acknowledged = { ...acknowledgedIn(state, generation) };
  for (const s of snapshots) acknowledged[hourKey(s)] = digest(s.entries);
  return { ...state, generation, acknowledged };
}

export function refuse(state, snapshots) {
  const refused = { ...state.refused };
  for (const s of snapshots) refused[hourKey(s)] = digest(s.entries);
  return { ...state, refused };
}

const encoded = (value) => Buffer.byteLength(JSON.stringify(value));

function parts(snapshot) {
  const { calls = [], ...sent } = snapshot;
  const session = { sessionId: sent.sessionId, repo: sent.repo, armored: sent.armored };
  const records = usageCallRecords(calls);
  const chunks = [];
  for (let i = 0; i < records.length; i += MAX_BATCH_ENTRIES) chunks.push(records.slice(i, i + MAX_BATCH_ENTRIES));
  return [
    { snapshot: sent, session, records: chunks[0] ?? [] },
    ...chunks.slice(1).map((records) => ({ snapshot: null, session, records })),
  ];
}

function batchOf(group) {
  const bySession = new Map();
  for (const { session, records } of group) {
    if (!records.length) continue;
    const entry = bySession.get(session.sessionId) ?? { ...session, records: [] };
    entry.records.push(...records);
    bySession.set(session.sessionId, entry);
  }
  const calls = [...bySession.values()].map(({ repo, ...rest }) => (repo ? { repo, ...rest } : rest));
  return { snapshots: group.flatMap((p) => (p.snapshot ? [p.snapshot] : [])), ...(calls.length ? { calls } : {}) };
}

export function packBatches(snapshots, overheadBytes = 512) {
  const batches = [];
  let current = [];
  let count = { snapshots: 0, entries: 0, records: 0, bytes: overheadBytes };
  for (const part of snapshots.flatMap(parts)) {
    const size = encoded(part.snapshot) + encoded(part.records) + 1;
    const entries = part.snapshot?.entries.length ?? 0;
    const full =
      count.snapshots + (part.snapshot ? 1 : 0) > MAX_BATCH_SNAPSHOTS ||
      count.entries + entries > MAX_BATCH_ENTRIES ||
      count.records + part.records.length > MAX_BATCH_ENTRIES ||
      count.bytes + size > MAX_BATCH_BYTES;
    if (full && current.length) {
      batches.push(batchOf(current));
      current = [];
      count = { snapshots: 0, entries: 0, records: 0, bytes: overheadBytes };
    }
    current.push(part);
    count = {
      snapshots: count.snapshots + (part.snapshot ? 1 : 0),
      entries: count.entries + entries,
      records: count.records + part.records.length,
      bytes: count.bytes + size,
    };
  }
  if (current.length) batches.push(batchOf(current));
  return batches;
}

const inHour = (occurredAt, s) =>
  occurredAt.slice(0, 10) === s.usageDate && Number(occurredAt.slice(11, 13)) === s.usageHour;

export function snapshotBatch(batch, snapshot) {
  const calls = (batch.calls ?? [])
    .filter((c) => c.sessionId === snapshot.sessionId)
    .map((c) => ({ ...c, records: c.records.filter((r) => inHour(r.occurredAt, snapshot)) }))
    .filter((c) => c.records.length);
  const { calls: _all, ...rest } = batch;
  return { ...rest, snapshots: [snapshot], ...(calls.length ? { calls } : {}) };
}

export const newBatchId = () => randomUUID();
