import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import dns from "node:dns";
import net from "node:net";
import { loadConfig } from "../plugins/armorcodex/scripts/lib/config.mjs";
import { getSdkClient } from "../plugins/armorcodex/scripts/lib/intent.mjs";
import { loadSyncState, syncUsage } from "../plugins/armorcodex/scripts/lib/usage-sync.mjs";
import {
  launchUsageSync,
  requestUsageSync,
} from "../plugins/armorcodex/scripts/lib/usage-sync-launch.mjs";

const SCRIPTS = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "plugins",
  "armorcodex",
  "scripts"
);
const SYNC = path.join(SCRIPTS, "usage-sync.mjs");
const ROUTER = path.join(SCRIPTS, "hook-router.mjs");
const S1 = "019e0000-0000-7000-8000-000000000001";
const S2 = "019e0000-0000-7000-8000-000000000002";
const S3 = "019e0000-0000-7000-8000-000000000003";
const A1 = "019e0000-0000-7000-8000-0000000000a1";
const KEY = "ak_test_usage_sync_codex";

const meta = (timestamp, payload) => ({ timestamp, type: "session_meta", payload: { timestamp, ...payload } });
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

const turnId = (iso, n) => {
  const hex = Date.parse(iso).toString(16).padStart(12, "0");
  return `${hex.slice(0, 8)}-${hex.slice(8)}-7000-8000-${String(n).padStart(12, "0")}`;
};
const turn = (timestamp, id) => ({
  timestamp,
  type: "event_msg",
  payload: { type: "task_started", turn_id: id, started_at: Math.floor(Date.parse(timestamp) / 1000) },
});
const copyOf = (lines, timestamp) => lines.map((l) => ({ ...l, timestamp }));

const T1 = turnId("2026-09-20T09:00:30Z", 1);
const s1Turn = [
  turn("2026-09-20T09:00:30Z", T1),
  model("2026-09-20T09:00:31Z", "gpt-5.5"),
  count("2026-09-20T09:01:00Z", 60, 10),
  count("2026-09-20T09:02:00Z", 90, 10),
];
const s1History = [meta("2026-09-20T09:00:00Z", { id: S1, session_id: S1, cwd: "/work/repo-a" }), ...s1Turn];

const forkOf = (id, original, created, copied, own) => [
  meta(created, { id, session_id: id, forked_from_id: original, cwd: "/work/repo-b" }),
  ...copyOf(copied, created),
  ...own,
];
const s2Own = [turn("2026-09-22T09:04:00Z", turnId("2026-09-22T09:04:00Z", 2)), count("2026-09-22T09:05:00Z", 95, 10)];

function fixtureHome() {
  const home = mkdtempSync(path.join(tmpdir(), "acx-usage-sync-"));
  writeRollout(rolloutPath(home, "2026-09-20", S1), [
    ...s1History,
    turn("2026-09-21T09:59:00Z", turnId("2026-09-21T09:59:00Z", 3)),
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
  writeRollout(rolloutPath(home, "2026-09-22", S2), forkOf(S2, S1, "2026-09-22T09:00:00Z", s1Turn, s2Own));
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
    .map((r) => [r.sessionId, r.usageDate, r.usageHour, ...r.entries.map((e) => `${e.model}=${total(e)}`)])
    .sort();
const emptyState = (home) => loadSyncState(path.join(home, "none.json"));

const FIRST_ROWS = [
  [S1, "2026-09-20", 9, "gpt-5.5=100", "gpt-5.5-mini=7"],
  [S1, "2026-09-21", 10, "gpt-5.5=50"],
  [S2, "2026-09-22", 9, "gpt-5.5=5"],
  [S3, "2026-09-19", 9, "gpt-5.5=30"],
];

test("first run posts every session-hour once, subagents folded in, forked history skipped", async () => {
  const home = fixtureHome();
  const { rows, report } = await run(home, await emptyState(home));
  assert.deepEqual(summary(rows), FIRST_ROWS);
  const s1 = rows.find((r) => r.sessionId === S1);
  assert.equal(s1.repo, "/work/repo-a");
  assert.equal(rows.find((r) => r.sessionId === S2).repo, "/work/repo-b");
  assert.equal(report.rollouts, 4);
  assert.equal(report.read, 4);
  assert.equal(report.sessions, 3);
  assert.equal(report.sessionHours, 4);
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

test("an appended rollout re-posts only its changed hour", async () => {
  const home = fixtureHome();
  const state = await emptyState(home);
  await run(home, state);
  append(rolloutPath(home, "2026-09-20", A1), count("2026-09-21T11:00:00Z", 12));
  append(rolloutPath(home, "2026-09-22", S2), count("2026-09-22T10:00:00Z", 105, 10));
  const { rows, report } = await run(home, state);
  assert.equal(report.read, 2);
  assert.deepEqual(summary(rows), [
    [S1, "2026-09-21", 11, "gpt-5.5-mini=5"],
    [S2, "2026-09-22", 10, "gpt-5.5=10"],
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

test("a model or hour that vanishes from a session is posted with zero tokens", async () => {
  const home = fixtureHome();
  const state = await emptyState(home);
  await run(home, state);
  rmSync(rolloutPath(home, "2026-09-20", A1));
  writeRollout(rolloutPath(home, "2026-09-20", S1), s1History);
  const { rows } = await run(home, state);
  assert.deepEqual(summary(rows), [
    [S1, "2026-09-20", 9, "gpt-5.5=100", "gpt-5.5-mini=0"],
    [S1, "2026-09-21", 10, "gpt-5.5=0"],
  ]);
  const again = await run(home, state);
  assert.deepEqual(again.rows, []);
});

test("a model that leaves one hour is zeroed in that hour only", async () => {
  const home = mkdtempSync(path.join(tmpdir(), "acx-usage-hour-zero-"));
  const S4 = "019e0000-0000-7000-8000-000000000004";
  const file = rolloutPath(home, "2026-09-20", S4);
  const head = [meta("2026-09-20T09:00:00Z", { id: S4, session_id: S4, cwd: "/work/repo-d" }), model("2026-09-20T09:00:01Z", "gpt-5.5")];
  writeRollout(file, [...head, count("2026-09-20T09:30:00Z", 40), count("2026-09-20T10:30:00Z", 70)]);
  const state = await emptyState(home);
  const first = await run(home, state);
  assert.deepEqual(summary(first.rows), [
    [S4, "2026-09-20", 10, "gpt-5.5=30"],
    [S4, "2026-09-20", 9, "gpt-5.5=40"],
  ]);
  writeRollout(file, [
    ...head,
    count("2026-09-20T09:30:00Z", 40),
    model("2026-09-20T10:00:00Z", "gpt-5.5-mini"),
    count("2026-09-20T10:30:00Z", 70),
  ]);
  const { rows } = await run(home, state);
  assert.deepEqual(summary(rows), [[S4, "2026-09-20", 10, "gpt-5.5-mini=30", "gpt-5.5=0"]]);
  assert.deepEqual((await run(home, state)).rows, []);
});

test("a fork counts a copied turn once in the hour its original turn started, across UTC midnight", async () => {
  const home = mkdtempSync(path.join(tmpdir(), "acx-usage-fork-hour-"));
  const S4 = "019e0000-0000-7000-8000-000000000004";
  const S5 = "019e0000-0000-7000-8000-000000000005";
  const late = turnId("2026-09-20T23:59:30Z", 5);
  const copied = [turn("2026-09-20T23:59:30Z", late), model("2026-09-20T23:59:31Z", "gpt-5.5"), count("2026-09-21T00:00:10Z", 80, 8)];
  for (const [id, created] of [[S5, "2026-09-22T09:00:00Z"], ["019e0000-0000-7000-8000-000000000006", "2026-09-23T14:00:00Z"]]) {
    writeRollout(rolloutPath(home, created.slice(0, 10), id), forkOf(id, S4, created, copied, []));
  }
  const state = await emptyState(home);
  const { rows, report } = await run(home, state);
  assert.deepEqual(summary(rows), [[S4, "2026-09-20", 23, "gpt-5.5=88"]]);
  assert.equal(report.copiedTurns, 1);
  assert.deepEqual((await run(home, state)).rows, []);
});

test("a re-run from lost state posts the same hourly rows again, which the backend replaces", async () => {
  const home = fixtureHome();
  const first = await run(home, await emptyState(home));
  const again = await run(home, await emptyState(home));
  assert.deepEqual(again.rows, first.rows);
});

test("a fork keeps skipping its copied history after its original is gone", async () => {
  const home = fixtureHome();
  const state = await emptyState(home);
  await run(home, state);
  rmSync(rolloutPath(home, "2026-09-20", S1));
  rmSync(rolloutPath(home, "2026-09-20", A1));
  append(rolloutPath(home, "2026-09-22", S2), count("2026-09-22T10:00:00Z", 105, 10));
  const { rows, report } = await run(home, state);
  assert.deepEqual(summary(rows), [[S2, "2026-09-22", 10, "gpt-5.5=10"]]);
  assert.equal(report.forksWithoutOriginal, 0);
});

test("a fork whose original is gone counts the copied turn once, in the hour it started, under the original", async () => {
  const home = fixtureHome();
  rmSync(rolloutPath(home, "2026-09-20", S1));
  const { rows, report } = await run(home, await emptyState(home));
  assert.deepEqual(summary(rows), [
    [S1, "2026-09-20", 9, "gpt-5.5-mini=7", "gpt-5.5=100"],
    [S2, "2026-09-22", 9, "gpt-5.5=5"],
    [S3, "2026-09-19", 9, "gpt-5.5=30"],
  ]);
  assert.equal(report.copiedTurns, 1);
  assert.equal(report.forksWithoutOriginal, 0);
});

test("two forks of a missing original count its copied turn once, from the longest copy", async () => {
  const home = fixtureHome();
  const S4 = "019e0000-0000-7000-8000-000000000004";
  rmSync(rolloutPath(home, "2026-09-20", S1));
  rmSync(rolloutPath(home, "2026-09-20", A1));
  writeRollout(rolloutPath(home, "2026-09-23", S4), forkOf(S4, S1, "2026-09-23T09:00:00Z", s1Turn.slice(0, 3), []));
  const { rows, report } = await run(home, await emptyState(home));
  assert.deepEqual(summary(rows), [
    [S1, "2026-09-20", 9, "gpt-5.5=100"],
    [S2, "2026-09-22", 9, "gpt-5.5=5"],
    [S3, "2026-09-19", 9, "gpt-5.5=30"],
  ]);
  assert.equal(report.copiedTurns, 1);
});

test("a fork of a missing fork counts each copied turn under the session that ran it", async () => {
  const home = fixtureHome();
  const S4 = "019e0000-0000-7000-8000-000000000004";
  rmSync(rolloutPath(home, "2026-09-22", S2));
  writeRollout(
    rolloutPath(home, "2026-09-24", S4),
    forkOf(S4, S2, "2026-09-24T09:00:00Z", [...s1Turn, ...s2Own], [
      turn("2026-09-24T09:10:00Z", turnId("2026-09-24T09:10:00Z", 4)),
      count("2026-09-24T09:11:00Z", 125, 11),
    ])
  );
  const { rows, report } = await run(home, await emptyState(home));
  assert.deepEqual(summary(rows), [
    [S1, "2026-09-20", 9, "gpt-5.5=100", "gpt-5.5-mini=7"],
    [S1, "2026-09-21", 10, "gpt-5.5=50"],
    [S2, "2026-09-22", 9, "gpt-5.5=5"],
    [S3, "2026-09-19", 9, "gpt-5.5=30"],
    [S4, "2026-09-24", 9, "gpt-5.5=31"],
  ]);
  assert.equal(report.copiedTurns, 1);
});

test("copies that name different originals count the turn under the oldest one", async () => {
  const home = fixtureHome();
  const S4 = "019e0000-0000-7000-8000-000000000004";
  rmSync(rolloutPath(home, "2026-09-20", S1));
  rmSync(rolloutPath(home, "2026-09-20", A1));
  writeRollout(
    rolloutPath(home, "2026-09-24", S4),
    forkOf(S4, S2, "2026-09-24T09:00:00Z", [...s1Turn, ...s2Own], [])
  );
  const { rows, report } = await run(home, await emptyState(home));
  assert.deepEqual(summary(rows), [
    [S1, "2026-09-20", 9, "gpt-5.5=100"],
    [S2, "2026-09-22", 9, "gpt-5.5=5"],
    [S3, "2026-09-19", 9, "gpt-5.5=30"],
  ]);
  assert.equal(report.copiedTurns, 1);
});

test("an original that turns up later takes its turn back from the copy", async () => {
  const home = fixtureHome();
  const original = readFileSync(rolloutPath(home, "2026-09-20", S1), "utf8");
  rmSync(rolloutPath(home, "2026-09-20", S1));
  const state = await emptyState(home);
  await run(home, state);
  writeFileSync(rolloutPath(home, "2026-09-20", S1), original);
  const { rows, report } = await run(home, state);
  assert.deepEqual(summary(rows), [[S1, "2026-09-21", 10, "gpt-5.5=50"]]);
  assert.equal(report.copiedTurns, 0);
});

test("a fork without turn ids counts all of its history when its original was never seen", async () => {
  const home = mkdtempSync(path.join(tmpdir(), "acx-usage-turnless-"));
  const S4 = "019e0000-0000-7000-8000-000000000004";
  writeRollout(rolloutPath(home, "2026-09-22", S4), [
    meta("2026-09-22T09:00:00Z", { id: S4, session_id: S4, forked_from_id: S1, cwd: "/work/repo-b" }),
    ...copyOf(s1History.slice(2), "2026-09-22T09:00:01Z"),
    count("2026-09-22T09:05:00Z", 95, 10),
  ]);
  const { rows, report } = await run(home, await emptyState(home));
  assert.deepEqual(summary(rows), [[S4, "2026-09-22", 9, "gpt-5.5=105"]]);
  assert.equal(report.forksWithoutOriginal, 1);
});

test("a failed hour is retried on the next run", async () => {
  const home = fixtureHome();
  const state = await emptyState(home);
  const first = await run(home, state, { fail: (row) => row.sessionId === S3 });
  assert.equal(first.report.failed, 1);
  const { rows } = await run(home, state);
  assert.deepEqual(summary(rows), [[S3, "2026-09-19", 9, "gpt-5.5=30"]]);
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

const usageRecord = (timestamp, responseId, input, output = 0) => ({
  timestamp,
  type: "token_usage_record",
  payload: { response_id: responseId, usage: { input_tokens: input, output_tokens: output } },
});

test("a fork's copied token_usage_records count nothing", async () => {
  const home = mkdtempSync(path.join(tmpdir(), "acx-usage-records-"));
  const S4 = "019e0000-0000-7000-8000-000000000004";
  const S5 = "019e0000-0000-7000-8000-000000000005";
  const original = [
    model("2026-09-08T09:00:01Z", "gpt-5.5"),
    usageRecord("2026-09-08T09:01:00Z", "resp-1", 50, 5),
    usageRecord("2026-09-08T09:02:00Z", "resp-2", 20, 2),
  ];
  writeRollout(rolloutPath(home, "2026-09-08", S4), [
    meta("2026-09-08T09:00:00Z", { id: S4, session_id: S4, cwd: "/work/repo-d" }),
    ...original,
  ]);
  writeRollout(rolloutPath(home, "2026-09-09", S5), [
    meta("2026-09-09T09:00:00Z", { id: S5, session_id: S5, forked_from_id: S4, cwd: "/work/repo-d" }),
    ...original,
    usageRecord("2026-09-09T09:05:00Z", "resp-3", 9, 1),
  ]);
  const { rows } = await run(home, await emptyState(home));
  assert.deepEqual(summary(rows), [
    [S4, "2026-09-08", 9, "gpt-5.5=77"],
    [S5, "2026-09-09", 9, "gpt-5.5=10"],
  ]);
});

function fakeBackend() {
  const posts = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      if (req.method === "POST" && req.url === "/dashboard/token-usage") {
        posts.push(JSON.parse(body));
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end('{"ok":true}');
    });
  });
  return new Promise((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve({ server, posts, port: server.address().port }))
  );
}

function baseEnv(home, port) {
  return {
    PATH: process.env.PATH,
    HOME: home,
    CODEX_HOME: path.join(home, ".codex"),
    ARMORCODEX_DATA_DIR: path.join(home, "data"),
    ARMORIQ_DEVICE_ID_PATH: path.join(home, "device-id"),
    ARMORIQ_ENV: "local",
    ARMORCODEX_USE_PRODUCTION: "false",
    ...(port ? { ARMORCODEX_BACKEND_ENDPOINT: `http://127.0.0.1:${port}`, IAP_ENDPOINT: `http://127.0.0.1:${port}`, PROXY_ENDPOINT: `http://127.0.0.1:${port}` } : {}),
  };
}

function node(args, env, stdin) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, args, { env });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("close", (status) => resolve({ status, stdout, stderr }));
    child.stdin.end(stdin ?? "");
  });
}

test("usage-sync --dry-run prints each row, then finds nothing changed", async () => {
  const home = fixtureHome();
  const first = await node([SYNC, "--dry-run"], baseEnv(home));
  assert.equal(first.status, 0, first.stderr);
  const rows = first.stdout
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l));
  assert.deepEqual(summary(rows), FIRST_ROWS);
  for (const row of rows) {
    assert.equal(row.product, "armorcodex");
    assert.ok(Number.isInteger(row.usageHour) && row.usageHour >= 0 && row.usageHour <= 23);
  }
  assert.match(first.stderr, /4 rollout\(s\) under .*\(1 other file\(s\)\)/);
  assert.match(first.stderr, /4 changed, 4 read, 3 session\(s\); would post 4 session-hour\(s\) \(192 tokens\)/);

  const second = await node([SYNC, "--dry-run"], baseEnv(home));
  assert.equal(second.status, 0, second.stderr);
  assert.equal(second.stdout, "");
  assert.match(second.stderr, /0 changed, 0 read, 3 session\(s\); would post 0 session-hour\(s\)/);
});

test("usage-sync without an API key posts nothing", async () => {
  const res = await node([SYNC], baseEnv(fixtureHome()));
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stderr, /no API key, nothing synced/);
});

const OBS_OFF = { CODEX_PLUGIN_OPTION_DISABLE_OBSERVABILITY: "true" };
const SYNC_OFF = { CODEX_PLUGIN_OPTION_DISABLE_USAGE_SYNC: "true" };
const TOGGLES = [
  ["observability off", OBS_OFF],
  ["usage sync off", SYNC_OFF],
  ["both off", { ...OBS_OFF, ...SYNC_OFF }],
];

test("usageSyncEnabled needs observability on and disable_usage_sync unset", () => {
  const cases = [
    [{}, true, true],
    [
      {
        CODEX_PLUGIN_OPTION_DISABLE_OBSERVABILITY: "false",
        CODEX_PLUGIN_OPTION_DISABLE_USAGE_SYNC: "false",
      },
      true,
      true,
    ],
    [OBS_OFF, false, false],
    [SYNC_OFF, true, false],
    [{ ...OBS_OFF, ...SYNC_OFF }, false, false],
    [{ ARMORCODEX_USAGE_SYNC_DISABLED: "1" }, true, false],
    [{ ARMORCODEX_OBSERVABILITY_DISABLED: "yes" }, false, false],
  ];
  for (const [env, observability, usageSync] of cases) {
    const cfg = loadConfig({ CODEX_PLUGIN_OPTION_API_KEY: KEY, ...env });
    assert.equal(cfg.observabilityEnabled, observability, JSON.stringify(env));
    assert.equal(cfg.usageSyncEnabled, usageSync, JSON.stringify(env));
  }
});

test("the launcher starts no sync and writes no request while the usage sync is off", () => {
  for (const [name, toggles] of TOGGLES) {
    const dataDir = mkdtempSync(path.join(tmpdir(), "acx-sync-off-"));
    const cfg = loadConfig({
      CODEX_PLUGIN_OPTION_API_KEY: KEY,
      ARMORCODEX_DATA_DIR: dataDir,
      ...toggles,
    });
    assert.equal(requestUsageSync(cfg), false, name);
    assert.equal(launchUsageSync(cfg), false, name);
    assert.equal(existsSync(path.join(dataDir, "usage-sync-state.json.request")), false, name);
    assert.equal(existsSync(path.join(dataDir, "usage-sync.log")), false, name);
  }
});

test("usage-sync posts nothing while observability or the usage sync is off", async () => {
  const { server, posts, port } = await fakeBackend();
  try {
    for (const [name, toggles] of TOGGLES) {
      const home = fixtureHome();
      const res = await node([SYNC], {
        ...baseEnv(home, port),
        CODEX_PLUGIN_OPTION_API_KEY: KEY,
        ...toggles,
      });
      assert.equal(res.status, 0, res.stderr);
      assert.match(res.stderr, /usage sync is off .*nothing synced/, name);
      assert.equal(existsSync(path.join(home, "data", "usage-sync-state.json")), false, name);
    }
    assert.equal(posts.length, 0);

    const res = await node([SYNC], {
      ...baseEnv(fixtureHome(), port),
      CODEX_PLUGIN_OPTION_API_KEY: KEY,
      CODEX_PLUGIN_OPTION_DISABLE_OBSERVABILITY: "false",
      CODEX_PLUGIN_OPTION_DISABLE_USAGE_SYNC: "false",
    });
    assert.equal(res.status, 0, res.stderr);
    assert.equal(posts.length, 4);
  } finally {
    server.close();
  }
});

async function until(check, what, timeoutMs = 20_000) {
  const start = Date.now();
  while (!(await check())) {
    if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

const readLastRun = (statePath) => {
  try {
    return JSON.parse(readFileSync(statePath, "utf8")).lastRun?.at;
  } catch {
    return undefined;
  }
};

test("SessionStart and Stop hooks run the sync, which posts each session-hour with its date and hour", async () => {
  const home = fixtureHome();
  const statePath = path.join(home, "data", "usage-sync-state.json");
  const { server, posts, port } = await fakeBackend();
  const env = { ...baseEnv(home, port), CODEX_PLUGIN_OPTION_API_KEY: KEY };
  const hook = (event, toggles = {}) =>
    node(
      [ROUTER],
      { ...env, ...toggles },
      JSON.stringify({
        hook_event_name: event,
        session_id: S2,
        cwd: "/work/repo-b",
        transcript_path: rolloutPath(home, "2026-09-22", S2),
      })
    );
  const settled = (after) => () =>
    readLastRun(statePath) !== after && !existsSync(`${statePath}.lock`);
  try {
    for (const [name, toggles] of TOGGLES) {
      await hook("SessionStart", toggles);
      await hook("Stop", toggles);
      assert.equal(existsSync(`${statePath}.request`), false, name);
      assert.equal(existsSync(`${statePath}.lock`), false, name);
    }
    await new Promise((r) => setTimeout(r, 3000));
    assert.equal(posts.length, 0);
    assert.equal(existsSync(statePath), false);

    await hook("SessionStart");
    await until(settled(undefined), "the SessionStart pass");
    const rows = (list) =>
      list.map((p) => [p.sessionId, p.usageDate, p.usageHour, p.product, p.repo, p.entries.length]).sort();
    const expected = [
      [S1, "2026-09-20", 9, "armorcodex", "/work/repo-a", 2],
      [S1, "2026-09-21", 10, "armorcodex", "/work/repo-a", 1],
      [S2, "2026-09-22", 9, "armorcodex", "/work/repo-b", 1],
      [S3, "2026-09-19", 9, "armorcodex", "/work/repo-c", 1],
    ];
    assert.deepEqual(rows(posts), expected);

    const firstRun = readLastRun(statePath);
    append(rolloutPath(home, "2026-09-22", S2), count("2026-09-22T10:00:00Z", 105, 10));
    await hook("Stop");
    await until(settled(firstRun), "the Stop pass");
    assert.deepEqual(
      rows(posts),
      [...expected, [S2, "2026-09-22", 10, "armorcodex", "/work/repo-b", 1]].sort()
    );
    assert.equal(posts.at(-1).entries[0].inputTokens, 10);
  } finally {
    server.close();
  }
});

test("the hooks leave the usage sync log, request marker, lock and state owner-only (#106)", async () => {
  process.umask(0o022);
  const modeOf = (file) => statSync(file).mode & 0o777;
  const home = fixtureHome();
  const dataDir = path.join(home, "data");
  const statePath = path.join(dataDir, "usage-sync-state.json");
  const logPath = path.join(dataDir, "usage-sync.log");
  mkdirSync(dataDir, { mode: 0o755 });
  chmodSync(dataDir, 0o755);
  for (const file of [logPath, `${statePath}.request`]) {
    writeFileSync(file, "old");
    chmodSync(file, 0o644);
  }

  const posts = [];
  let release;
  const held = new Promise((resolve) => (release = resolve));
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", async () => {
      if (req.method === "POST" && req.url === "/dashboard/token-usage") {
        posts.push(JSON.parse(body));
        await held;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end('{"ok":true}');
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const stop = await node(
      [ROUTER],
      { ...baseEnv(home, server.address().port), CODEX_PLUGIN_OPTION_API_KEY: KEY },
      JSON.stringify({
        hook_event_name: "Stop",
        session_id: S2,
        cwd: "/work/repo-b",
        transcript_path: rolloutPath(home, "2026-09-22", S2),
      })
    );
    assert.equal(stop.status, 0, stop.stderr);
    await until(() => posts.length > 0, "the first post");
    assert.equal(modeOf(`${statePath}.lock`), 0o600);
    release();
    await until(() => readLastRun(statePath) !== undefined && !existsSync(`${statePath}.lock`), "the pass");
    assert.equal(modeOf(dataDir), 0o700);
    for (const file of [statePath, logPath, `${statePath}.request`]) {
      assert.equal(modeOf(file), 0o600, file);
    }
  } finally {
    release();
    server.close();
  }
});

const isLoopback = (host) =>
  !host || host === "localhost" || host === "::1" || /^127\./.test(host) || /^::ffff:127\./.test(host);

const OFF_BOX_GUARD = (log) => `
const net = require("net"), dns = require("dns"), fs = require("fs");
const loop = ${isLoopback.toString()};
const note = (h) => fs.appendFileSync(${JSON.stringify(log)}, h + "\\n");
const connect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (...args) {
  const o = Array.isArray(args[0]) ? args[0][0] : args[0];
  const host = typeof o === "object" && o ? (o.path ? "" : o.host) : typeof args[1] === "string" ? args[1] : "";
  if (!loop(host)) { note(host); const s = this; process.nextTick(() => s.destroy(new Error("off-box " + host))); return this; }
  return connect.apply(this, args);
};
const lookup = dns.lookup;
dns.lookup = function (h, ...rest) { if (!loop(h)) note(h); return lookup.call(this, h, ...rest); };
`;

test("a custom backend with no proxy or IAP still syncs usage, and the first proxy use names PROXY_ENDPOINT (R4-3)", async (t) => {
  const home = fixtureHome();
  const offBox = path.join(home, "off-box.log");
  const guard = path.join(home, "guard.cjs");
  writeFileSync(guard, OFF_BOX_GUARD(offBox));
  const { server, posts, port } = await fakeBackend();
  const env = { ...baseEnv(home, port), CODEX_PLUGIN_OPTION_API_KEY: KEY };
  try {
    const config = loadConfig(env);
    assert.equal(config.backendEndpoint, `http://127.0.0.1:${port}`);
    assert.equal(config.proxyEndpoint, "");
    assert.equal(config.iapEndpoint, "");

    const res = await node([SYNC], { ...env, NODE_OPTIONS: `--require ${guard}` });
    assert.equal(res.status, 0, res.stderr);
    assert.equal(posts.length, 4, res.stderr);
    assert.ok(posts.every((p) => p.product === "armorcodex" && Number.isInteger(p.usageHour)));

    const attempts = [];
    t.mock.method(net.Socket.prototype, "connect", function (...args) {
      const o = Array.isArray(args[0]) ? args[0][0] : args[0];
      attempts.push(typeof o === "object" && o ? o.host : args[1]);
      process.nextTick(() => this.destroy(new Error("connect refused in test")));
      return this;
    });
    t.mock.method(dns, "lookup", (host, ...rest) => {
      attempts.push(host);
      rest.at(-1)(new Error("lookup refused in test"));
    });
    const client = getSdkClient(config);
    assert.throws(() => client.proxyEndpoint, /PROXY_ENDPOINT/);
    assert.throws(() => client.iapEndpoint, /IAP_ENDPOINT/);
    const now = Date.now() / 1000;
    const token = {
      tokenId: "t",
      planHash: "h",
      signature: "sig",
      issuedAt: now,
      expiresAt: now + 3600,
      policy: {},
      compositeIdentity: "c",
      stepProofs: [[]],
      totalSteps: 1,
      rawToken: { token: {}, plan: { steps: [{ action: "read_file", mcp: "fs" }] } },
    };
    await assert.rejects(client.invoke("fs", "read_file", token, {}), /PROXY_ENDPOINT/);
    assert.deepEqual(attempts.filter((h) => !isLoopback(h)), []);
    assert.equal(existsSync(offBox) ? readFileSync(offBox, "utf8") : "", "");
  } finally {
    server.close();
  }
});
