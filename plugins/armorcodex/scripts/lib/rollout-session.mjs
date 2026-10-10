import { closeSync, openSync, readdirSync, readSync } from "node:fs";
import path from "node:path";
import { readJson, writeJson } from "./fs-store.mjs";
import {
  readRollout,
  rolloutUsage,
  sumEntries,
  usageSignature,
} from "./token-usage.mjs";

export const ROLLOUT_RE =
  /^rollout-(\d{4}-\d{2}-\d{2})T.*-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i;
const DATE_PARTS = [/^\d{4}$/, /^\d{2}$/, /^\d{2}$/];
const FIRST_LINE_MAX = 1 << 20;

export const rolloutOf = (file) => {
  const m = ROLLOUT_RE.exec(path.basename(file));
  return m ? { date: m[1], id: m[2].toLowerCase() } : null;
};

function entries(dir) {
  try {
    return readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

function walk(dir, since, prefix, out) {
  for (const entry of entries(dir)) {
    const full = path.join(dir, entry.name);
    if (entry.isFile() && rolloutOf(full)) out.push(full);
    if (!entry.isDirectory()) continue;
    const depth = prefix.length;
    const dated = depth < 3 && DATE_PARTS[depth].test(entry.name);
    const parts = dated ? [...prefix, entry.name] : prefix;
    const day = parts.join("-");
    if (since && dated && day < since.slice(0, day.length)) continue;
    walk(full, since, parts, out);
  }
  return out;
}

export const listRollouts = (root, since) => walk(root, since, [], []);

function firstLine(file) {
  const fd = openSync(file, "r");
  try {
    const buf = Buffer.alloc(64 * 1024);
    const chunks = [];
    for (let read = 0; read < FIRST_LINE_MAX;) {
      const n = readSync(fd, buf, 0, buf.length, read);
      if (n === 0) break;
      const end = buf.subarray(0, n).indexOf(0x0a);
      chunks.push(Buffer.from(buf.subarray(0, end === -1 ? n : end)));
      if (end !== -1) break;
      read += n;
    }
    return Buffer.concat(chunks).toString("utf8");
  } finally {
    closeSync(fd);
  }
}

function indexEntry(file) {
  try {
    const line = JSON.parse(firstLine(file));
    const meta = line?.type === "session_meta" ? line.payload : null;
    const id =
      typeof meta?.id === "string" && meta.id ? meta.id : rolloutOf(file).id;
    const sessionId =
      typeof meta?.session_id === "string" && meta.session_id
        ? meta.session_id
        : id;
    return { id, sessionId };
  } catch {
    return null;
  }
}

export async function sessionRollouts({
  sessionsRoot,
  transcript,
  sessionId,
  indexPath,
}) {
  const index = await readJson(indexPath, {});
  let added = false;
  const members = [];
  for (const file of listRollouts(sessionsRoot, rolloutOf(transcript).date)) {
    if (!Object.hasOwn(index, file)) {
      index[file] = indexEntry(file);
      added = true;
    }
    if (file !== transcript && index[file]?.sessionId === sessionId)
      members.push(file);
  }
  if (added) await writeJson(indexPath, index);
  return [transcript, ...members];
}

export async function listSessions({ roots, indexPath }) {
  const index = await readJson(indexPath, {});
  let added = false;
  const sessions = [];
  for (const file of roots.flatMap((root) => listRollouts(root))) {
    if (!Object.hasOwn(index, file)) {
      index[file] = indexEntry(file);
      added = true;
    }
    const entry = index[file];
    if (entry && entry.id === entry.sessionId) sessions.push({ sessionId: entry.id, transcript: file });
  }
  if (added) await writeJson(indexPath, index);
  const subagents = new Map();
  for (const [file, entry] of Object.entries(index))
    if (entry && entry.id !== entry.sessionId)
      subagents.set(entry.sessionId, [...(subagents.get(entry.sessionId) ?? []), file]);
  return sessions.map((s) => ({
    ...s,
    members: [s.transcript, ...(subagents.get(s.sessionId) ?? []).sort()],
  }));
}

const leading = (items, has) => {
  let n = 0;
  while (n < items.length && has(items[n])) n++;
  return n;
};

const hasTurnIds = ({ events, records }) =>
  [...events, ...records].some((item) => item.turn);

function copiedPrefix({ events, records }, originalPath) {
  const original = readRollout(originalPath);
  const totals = new Set(original.events.map((e) => usageSignature(e.totals)));
  const responses = new Set(
    original.records.map((r) => r.responseId).filter(Boolean),
  );
  return {
    events: leading(events, (e) => totals.has(usageSignature(e.totals))),
    records: leading(records, (r) => responses.has(r.responseId)),
  };
}

function forkCopied(rollout, roots, problems, file) {
  const forkedFrom = rollout.meta?.forked_from_id;
  if (typeof forkedFrom !== "string" || !forkedFrom || hasTurnIds(rollout))
    return {};
  const id = forkedFrom.toLowerCase();
  const original = roots
    .flatMap((root) => listRollouts(root))
    .find((f) => rolloutOf(f).id === id);
  if (original) return copiedPrefix(rollout, original);
  problems.push({ path: file, reason: "fork_original_missing" });
  return {};
}

const readProblem = (file, err) => ({
  path: file,
  reason: err?.code === "ENOENT" ? "missing" : "unreadable",
});

function addHours(hours, usage) {
  for (const [key, models] of Object.entries(usage)) {
    const hour = (hours[key] ??= {});
    for (const [model, entry] of Object.entries(models))
      hour[model] = sumEntries(hour[model], entry);
  }
}

export async function captureCodexSession({
  roots,
  transcript,
  sessionId,
  cutoff,
  indexPath,
}) {
  const problems = [];
  const hours = {};
  let repo;
  const files = await sessionRollouts({
    sessionsRoot: roots[0],
    transcript,
    sessionId,
    indexPath,
  });
  for (const file of files) {
    let rollout;
    try {
      rollout = readRollout(file);
    } catch (err) {
      problems.push(readProblem(file, err));
      continue;
    }
    if (file === transcript && typeof rollout.meta?.cwd === "string")
      repo = rollout.meta.cwd;
    const copied = forkCopied(rollout, roots, problems, file);
    addHours(hours, rolloutUsage(rollout, copied, (t) => t >= cutoff).hours);
  }
  const snapshots = Object.keys(hours)
    .sort()
    .map((key) => ({
      usageDate: key.slice(0, 10),
      usageHour: Number(key.slice(11, 13)),
      entries: Object.values(hours[key]),
    }));
  return { hours: snapshots, ...(repo ? { repo } : {}), problems };
}
