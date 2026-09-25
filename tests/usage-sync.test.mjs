import { test } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadSyncState, syncUsage } from "../plugins/armorcodex/scripts/lib/usage-sync.mjs";
const S1 = "019e0000-0000-7000-8000-000000000001";
const S2 = "019e0000-0000-7000-8000-000000000002";
const S3 = "019e0000-0000-7000-8000-000000000003";
const A1 = "019e0000-0000-7000-8000-0000000000a1";

const meta = (timestamp, payload) => ({ timestamp, type: "session_meta", payload });
const model = (timestamp, name) => ({ timestamp, type: "turn_context", payload: { model: name } });
const count = (timestamp, input, output = 0) => ({
  timestamp,
  type: "event_msg",
  payload: {
    type: "token_count",
    info: { total_token_usage: { input_tokens: input, cached_input_tokens: 0, output_tokens: output } },
  },
});

const rolloutPath = (home, day, id, root = "sessions") =>
  path.join(home, ".codex", root, ...day.split("-"), `rollout-${day}T09-00-00-${id}.jsonl`);

function writeRollout(file, lines) {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, lines.map((l) => JSON.stringify(l)).join("\n"));
}

function append(file, line) {
  appendFileSync(file, "\n" + JSON.stringify(line));
}

const s1History = [
  meta("2026-09-20T09:00:00Z", { id: S1, session_id: S1, cwd: "/work/repo-a" }),
  model("2026-09-20T09:00:01Z", "gpt-5.5"),
  count("2026-09-20T09:01:00Z", 60, 10),
  count("2026-09-20T09:02:00Z", 90, 10),
];

function fixtureHome() {
  const home = mkdtempSync(path.join(tmpdir(), "acx-usage-sync-"));
  writeRollout(rolloutPath(home, "2026-09-20", S1), [
    ...s1History,
    count("2026-09-21T10:00:00Z", 140, 10),
  ]);
  writeRollout(rolloutPath(home, "2026-09-20", A1), [
    meta("2026-09-20T09:03:00Z", {
      id: A1,
      session_id: S1,
      cwd: "/work/repo-a",
      source: { subagent: { thread_spawn: { parent_thread_id: S1 } } },
    }),
    model("2026-09-20T09:03:01Z", "gpt-5.5-mini"),
    count("2026-09-20T09:04:00Z", 7),
  ]);
  writeRollout(rolloutPath(home, "2026-09-22", S2), [
    meta("2026-09-22T09:00:00Z", { id: S2, session_id: S2, forked_from_id: S1, cwd: "/work/repo-b" }),
    ...s1History.slice(1).map((l) => ({ ...l, timestamp: "2026-09-22T09:00:01Z" })),
    count("2026-09-22T09:05:00Z", 95, 10),
  ]);
  writeRollout(rolloutPath(home, "2026-09-19", S3, "archived_sessions"), [
    meta("2026-09-19T09:00:00Z", { id: S3, session_id: S3, cwd: "/work/repo-c" }),
    model("2026-09-19T09:00:01Z", "gpt-5.5"),
    count("2026-09-19T09:01:00Z", 30),
  ]);
  writeFileSync(path.join(home, ".codex", "sessions", "notes.txt"), "x");
  return home;
}

const rootsOf = (home) => [
  path.join(home, ".codex", "sessions"),
  path.join(home, ".codex", "archived_sessions"),
];

async function run(home, state, opts = {}) {
  const rows = [];
  const report = await syncUsage({
    roots: rootsOf(home),
    state,
    post: async (row) => {
      rows.push(row);
      return { ok: opts.fail ? !opts.fail(row) : true };
    },
    ...opts,
  });
  return { rows, report };
}

const total = (e) => e.inputTokens + e.outputTokens + e.cacheReadTokens + e.cacheWriteTokens;
const summary = (rows) =>
  rows
    .map((r) => [r.sessionId, r.usageDate, ...r.entries.map((e) => `${e.model}=${total(e)}`)])
    .sort();
const emptyState = (home) => loadSyncState(path.join(home, "none.json"));

const FIRST_ROWS = [
  [S1, "2026-09-20", "gpt-5.5=100", "gpt-5.5-mini=7"],
  [S1, "2026-09-21", "gpt-5.5=50"],
  [S2, "2026-09-22", "gpt-5.5=5"],
  [S3, "2026-09-19", "gpt-5.5=30"],
];

test("first run posts every session-day once, subagents folded in, forked history skipped", async () => {
  const home = fixtureHome();
  const { rows, report } = await run(home, await emptyState(home));
  assert.deepEqual(summary(rows), FIRST_ROWS);
  const s1 = rows.find((r) => r.sessionId === S1);
  assert.equal(s1.repo, "/work/repo-a");
  assert.equal(rows.find((r) => r.sessionId === S2).repo, "/work/repo-b");
  assert.equal(report.rollouts, 4);
  assert.equal(report.read, 4);
  assert.equal(report.sessions, 3);
  assert.equal(report.sessionDays, 4);
  assert.equal(report.tokens, 192);
  assert.deepEqual(
    report.notRead.map((f) => path.basename(f)),
    ["notes.txt"]
  );
});

test("a second run with no file changes reads and posts nothing", async () => {
  const home = fixtureHome();
  const state = await emptyState(home);
  await run(home, state);
  const { rows, report } = await run(home, state);
  assert.deepEqual(rows, []);
  assert.equal(report.changed, 0);
  assert.equal(report.read, 0);
});

test("an appended rollout re-posts only its changed day", async () => {
  const home = fixtureHome();
  const state = await emptyState(home);
  await run(home, state);
  append(rolloutPath(home, "2026-09-20", A1), count("2026-09-21T11:00:00Z", 12));
  append(rolloutPath(home, "2026-09-22", S2), count("2026-09-22T10:00:00Z", 105, 10));
  const { rows, report } = await run(home, state);
  assert.equal(report.read, 2);
  assert.deepEqual(summary(rows), [
    [S1, "2026-09-21", "gpt-5.5=50", "gpt-5.5-mini=5"],
    [S2, "2026-09-22", "gpt-5.5=15"],
  ]);
});

test("a changed rollout whose totals did not change posts nothing", async () => {
  const home = fixtureHome();
  const state = await emptyState(home);
  await run(home, state);
  append(rolloutPath(home, "2026-09-20", S1), model("2026-09-23T09:00:00Z", "gpt-5.5"));
  const { rows, report } = await run(home, state);
  assert.equal(report.read, 1);
  assert.deepEqual(rows, []);
});

test("a model or day that vanishes from a session is posted with zero tokens", async () => {
  const home = fixtureHome();
  const state = await emptyState(home);
  await run(home, state);
  rmSync(rolloutPath(home, "2026-09-20", A1));
  writeRollout(rolloutPath(home, "2026-09-20", S1), s1History);
  const { rows } = await run(home, state);
  assert.deepEqual(summary(rows), [
    [S1, "2026-09-20", "gpt-5.5=100", "gpt-5.5-mini=0"],
    [S1, "2026-09-21", "gpt-5.5=0"],
  ]);
  const again = await run(home, state);
  assert.deepEqual(again.rows, []);
});

test("a fork keeps skipping its copied history after its original is gone", async () => {
  const home = fixtureHome();
  const state = await emptyState(home);
  await run(home, state);
  rmSync(rolloutPath(home, "2026-09-20", S1));
  rmSync(rolloutPath(home, "2026-09-20", A1));
  append(rolloutPath(home, "2026-09-22", S2), count("2026-09-22T10:00:00Z", 105, 10));
  const { rows, report } = await run(home, state);
  assert.deepEqual(summary(rows), [[S2, "2026-09-22", "gpt-5.5=15"]]);
  assert.equal(report.forksWithoutOriginal, 0);
});

test("a fork whose original was never seen counts all of its history", async () => {
  const home = fixtureHome();
  rmSync(rolloutPath(home, "2026-09-20", S1));
  const { rows, report } = await run(home, await emptyState(home));
  assert.deepEqual(
    summary(rows.filter((r) => r.sessionId === S2)),
    [[S2, "2026-09-22", "gpt-5.5=105"]]
  );
  assert.equal(report.forksWithoutOriginal, 1);
});

test("a failed day is retried on the next run", async () => {
  const home = fixtureHome();
  const state = await emptyState(home);
  const first = await run(home, state, { fail: (row) => row.sessionId === S3 });
  assert.equal(first.report.failed, 1);
  const { rows } = await run(home, state);
  assert.deepEqual(summary(rows), [[S3, "2026-09-19", "gpt-5.5=30"]]);
});

test("sessions the plugin saw post armored, and stay armored", async () => {
  const home = fixtureHome();
  const state = await emptyState(home);
  const first = await run(home, state, { isArmored: (id) => id === S2 });
  assert.deepEqual(
    first.rows.filter((r) => r.armored).map((r) => r.sessionId),
    [S2]
  );
  append(rolloutPath(home, "2026-09-22", S2), count("2026-09-22T10:00:00Z", 105, 10));
  const { rows } = await run(home, state);
  assert.equal(rows[0].armored, true);
});

test("a run past its deadline posts nothing and the next run posts everything", async () => {
  const home = fixtureHome();
  const state = await emptyState(home);
  const late = await run(home, state, { deadline: Date.now() - 1 });
  assert.deepEqual(late.rows, []);
  assert.equal(late.report.left, 4);
  const next = await run(home, state);
  assert.deepEqual(summary(next.rows), FIRST_ROWS);
});
