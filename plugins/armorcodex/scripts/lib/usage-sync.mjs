import { readdir, stat } from "node:fs/promises";
import path from "node:path";
import { readJson } from "./fs-store.mjs";
import { readRollout, rolloutUsageByDay, sumEntries, usageSignature } from "./token-usage.mjs";

const STATE_VERSION = 1;
const ROLLOUT_RE =
  /^rollout-.*-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i;

export async function loadSyncState(statePath) {
  const raw = await readJson(statePath, null);
  if (
    raw?.version === STATE_VERSION &&
    raw.files &&
    typeof raw.files === "object" &&
    raw.sessions &&
    typeof raw.sessions === "object"
  ) {
    return raw;
  }
  return { version: STATE_VERSION, files: {}, sessions: {} };
}

async function walk(dir, out) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) await walk(full, out);
    else if (entry.isFile()) out.push(full);
  }
}

/** Codex rollout files under `roots`, and every other file found there. */
export async function listRollouts(roots) {
  const files = [];
  for (const root of roots) await walk(root, files);
  const rollouts = [];
  const other = [];
  for (const file of files) (ROLLOUT_RE.test(path.basename(file)) ? rollouts : other).push(file);
  return { rollouts, other };
}

const rolloutId = (file) => path.basename(file).match(ROLLOUT_RE)[1];

const leading = (items, has) => {
  let n = 0;
  while (n < items.length && has(items[n])) n++;
  return n;
};

function copiedPrefix({ events, records }, originalPath) {
  const original = readRollout(originalPath);
  const totals = new Set(original.events.map((e) => usageSignature(e.totals)));
  const responses = new Set(original.records.map((r) => r.responseId).filter(Boolean));
  return {
    events: leading(events, (e) => totals.has(usageSignature(e.totals))),
    records: leading(records, (r) => responses.has(r.responseId)),
  };
}

/**
 * Parse one rollout into its state entry. A fork's copied history is found
 * once, by matching its leading token_count totals and token_usage_record
 * response ids against its original's, and kept as `copied` so later reads of
 * the fork skip reading the original.
 */
function readFileState(file, [size, mtimeMs], prev, rolloutsById, report) {
  const rollout = readRollout(file);
  const { meta } = rollout;
  const id = typeof meta?.id === "string" && meta.id ? meta.id : rolloutId(file);
  const sessionId =
    typeof meta?.session_id === "string" && meta.session_id ? meta.session_id : id;
  let copied = prev?.copied;
  const originalPath = rolloutsById.get(meta?.forked_from_id);
  if (meta?.forked_from_id && copied === undefined) {
    try {
      copied = copiedPrefix(rollout, originalPath);
    } catch {
      report.forksWithoutOriginal++;
    }
  }
  return {
    size,
    mtimeMs,
    id,
    sessionId,
    ...(typeof meta?.cwd === "string" && meta.cwd ? { cwd: meta.cwd } : {}),
    ...(copied !== undefined ? { copied } : {}),
    days: rolloutUsageByDay(rollout, copied),
  };
}

const entryTotal = (e) => e.inputTokens + e.outputTokens + e.cacheReadTokens + e.cacheWriteTokens;

const zeroEntry = (model) => ({
  model,
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  reasoningOutputTokens: 0,
});

function sessionDays(fileEntries) {
  const days = {};
  for (const entry of fileEntries) {
    for (const [usageDate, models] of Object.entries(entry.days)) {
      const day = (days[usageDate] ??= {});
      for (const [model, usage] of Object.entries(models)) day[model] = sumEntries(day[model], usage);
    }
  }
  return days;
}

/**
 * The rows to post for one session: every day whose per-model totals differ
 * from what was posted before. A model posted before but absent from a day now
 * is sent with zero tokens, since the backend replaces each (session, model,
 * day) row it receives and leaves the rest alone.
 */
function changedDays(usageByDay, prevDays = {}) {
  const days = {};
  for (const [usageDate, models] of Object.entries(usageByDay)) {
    days[usageDate] = Object.fromEntries(
      Object.entries(models).map(([model, e]) => [model, entryTotal(e)])
    );
  }
  const rows = [];
  for (const usageDate of new Set([...Object.keys(days), ...Object.keys(prevDays)])) {
    const now = days[usageDate] ?? {};
    const before = prevDays[usageDate] ?? {};
    const models = new Set([...Object.keys(now), ...Object.keys(before)]);
    if ([...models].every((m) => now[m] === before[m])) continue;
    const vanished = Object.keys(before).filter((m) => !Object.hasOwn(now, m));
    const entries = [...Object.values(usageByDay[usageDate] ?? {}), ...vanished.map(zeroEntry)];
    const tokens = Object.values(now).reduce((a, b) => a + b, 0);
    rows.push({ usageDate, entries, tokens });
  }
  return { days, rows };
}

/**
 * Post the session-days that changed since the last run.
 *
 * `state.files` caches each rollout's per-day totals under its size and mtime,
 * so only rollouts that changed are read. A session is every rollout whose
 * session_meta names it, subagent rollouts included. `state.sessions` keeps the
 * per-model totals last posted for each session-day, and a session's entry is
 * replaced only when all of its changed days posted, so a failed day is
 * retried on the next run. A run that reaches `deadline` while reading posts
 * nothing; the next run reads the rest. `state` is updated in place.
 */
export async function syncUsage({ roots, state, post, isArmored = () => false, deadline = Infinity }) {
  const { rollouts, other } = await listRollouts(roots);
  const stats = new Map();
  for (const file of rollouts) {
    try {
      const s = await stat(file);
      stats.set(file, [s.size, s.mtimeMs]);
    } catch {
      // removed between listing and stat
    }
  }
  for (const file of Object.keys(state.files)) {
    if (!stats.has(file)) delete state.files[file];
  }
  const rolloutsById = new Map([...stats.keys()].map((file) => [rolloutId(file), file]));
  const changed = [...stats.keys()]
    .filter((file) => {
      const [size, mtimeMs] = stats.get(file);
      return state.files[file]?.size !== size || state.files[file]?.mtimeMs !== mtimeMs;
    })
    .sort((a, b) => stats.get(a)[1] - stats.get(b)[1]);

  const report = {
    rollouts: stats.size,
    other: other.length,
    notRead: other,
    changed: changed.length,
    read: 0,
    sessions: 0,
    sessionDays: 0,
    tokens: 0,
    failed: 0,
    left: 0,
    forksWithoutOriginal: 0,
  };

  const unread = new Set();
  for (const [i, file] of changed.entries()) {
    if (Date.now() > deadline) {
      report.left = changed.length - i;
      return report;
    }
    try {
      state.files[file] = readFileState(
        file,
        stats.get(file),
        state.files[file],
        rolloutsById,
        report
      );
      report.read++;
    } catch {
      unread.add(file);
      report.failed++;
    }
  }

  const sessions = new Map();
  for (const [file, entry] of Object.entries(state.files)) {
    if (!sessions.has(entry.sessionId)) sessions.set(entry.sessionId, []);
    sessions.get(entry.sessionId).push({ file, entry });
  }
  for (const sessionId of Object.keys(state.sessions)) {
    if (!sessions.has(sessionId)) delete state.sessions[sessionId];
  }
  report.sessions = sessions.size;

  for (const [sessionId, files] of sessions) {
    if (files.some(({ file }) => unread.has(file))) continue;
    const prev = state.sessions[sessionId];
    const { days, rows } = changedDays(
      sessionDays(files.map(({ entry }) => entry)),
      prev?.days
    );
    if (!rows.length) continue;
    if (Date.now() > deadline) {
      report.left++;
      continue;
    }
    const armored = Boolean(prev?.armored) || isArmored(sessionId);
    const main = files.find(({ entry }) => entry.id === sessionId) ?? files[0];
    let ok = true;
    for (const row of rows) {
      const result = await post({
        sessionId,
        usageDate: row.usageDate,
        repo: main.entry.cwd,
        entries: row.entries,
        armored,
      });
      if (result?.ok) {
        report.sessionDays++;
        report.tokens += row.tokens;
      } else {
        ok = false;
        report.failed++;
      }
    }
    if (ok) state.sessions[sessionId] = { days, ...(armored ? { armored: true } : {}) };
  }
  return report;
}
