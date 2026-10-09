import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "../plugins/armorcodex/scripts/lib/config.mjs";
import { signIn, withHome } from "./helpers/login.mjs";
import { loadSyncState, syncUsage } from "../plugins/armorcodex/scripts/lib/usage-sync.mjs";
import { observeHistory, ownedBy, ownedOrUnassigned } from "../plugins/armorcodex/scripts/lib/login-ownership.mjs";
import {
  launchUsageSync,
  requestUsageSync,
  syncBasePath,
  userStatePath,
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

const keyOf = (req) =>
  /^Bearer (.+)$/.exec(req.headers.authorization ?? "")?.[1] ?? req.headers["x-api-key"];
const userOf = (key) => `user-of-${key}`;

function fakeBackend(answer = async () => true) {
  const posts = [];
  const postedBy = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", async () => {
      const key = keyOf(req);
      let reply = { ok: true };
      let status = 200;
      if (req.method === "POST" && req.url === "/iap/validate-key") {
        [status, reply] = key?.startsWith("ak_test_unknown")
          ? [401, {}]
          : [200, key?.startsWith("ak_test_nouser") ? {} : { userId: userOf(key) }];
      } else if (req.method === "POST" && req.url === "/dashboard/token-usage") {
        posts.push(JSON.parse(body));
        postedBy.push(userOf(key));
        await answer(posts.at(-1));
      }
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(reply));
    });
  });
  return new Promise((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve({ server, posts, postedBy, port: server.address().port }))
  );
}

const userState = (dataDir, port, key) =>
  userStatePath(dataDir, {
    backend: `http://127.0.0.1:${port}`,
    product: "armorcodex",
    userId: userOf(key),
  });

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
    const home = mkdtempSync(path.join(tmpdir(), "acx-config-"));
    signIn(home, { backend: loadConfig({}).backendEndpoint, apiKey: KEY });
    const cfg = withHome(home, () => loadConfig(env));
    assert.equal(cfg.observabilityEnabled, observability, JSON.stringify(env));
    assert.equal(cfg.usageSyncEnabled, usageSync, JSON.stringify(env));
  }
});

test("the launcher starts no sync and writes no request while the usage sync is off", () => {
  for (const [name, toggles] of TOGGLES) {
    const dataDir = mkdtempSync(path.join(tmpdir(), "acx-sync-off-"));
    signIn(dataDir, { backend: loadConfig({}).backendEndpoint, apiKey: KEY });
    const cfg = withHome(dataDir, () => loadConfig({ ARMORCODEX_DATA_DIR: dataDir, ...toggles }));
    assert.equal(requestUsageSync(cfg), false, name);
    assert.equal(launchUsageSync(cfg), false, name);
    assert.equal(existsSync(`${syncBasePath(dataDir)}.request`), false, name);
    assert.equal(existsSync(path.join(dataDir, "usage-sync.log")), false, name);
  }
});

test("usage-sync posts nothing while observability or the usage sync is off", async () => {
  const { server, posts, port } = await fakeBackend();
  try {
    for (const [name, toggles] of TOGGLES) {
      const home = signIn(fixtureHome(), { backend: `http://127.0.0.1:${port}`, apiKey: KEY });
      const res = await node([SYNC], { ...baseEnv(home, port), ...toggles });
      assert.equal(res.status, 0, res.stderr);
      assert.match(res.stderr, /usage sync is off .*nothing synced/, name);
      assert.equal(existsSync(syncBasePath(path.join(home, "data"))), false, name);
    }
    assert.equal(posts.length, 0);

    const res = await node([SYNC], {
      ...baseEnv(signIn(fixtureHome(), { backend: `http://127.0.0.1:${port}`, apiKey: KEY }), port),
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
  const { server, posts, port } = await fakeBackend();
  const statePath = userState(path.join(home, "data"), port, KEY);
  const base = syncBasePath(path.join(home, "data"));
  signIn(home, { backend: `http://127.0.0.1:${port}`, apiKey: KEY, userId: userOf(KEY) });
  const env = baseEnv(home, port);
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
    readLastRun(statePath) !== after && !existsSync(`${base}.lock`);
  try {
    for (const [name, toggles] of TOGGLES) {
      await hook("SessionStart", toggles);
      await hook("Stop", toggles);
      assert.equal(existsSync(`${base}.request`), false, name);
      assert.equal(existsSync(`${base}.lock`), false, name);
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
  const base = syncBasePath(dataDir);
  const logPath = path.join(dataDir, "usage-sync.log");
  mkdirSync(dataDir, { mode: 0o755 });
  chmodSync(dataDir, 0o755);
  for (const file of [logPath, `${base}.request`]) {
    writeFileSync(file, "old");
    chmodSync(file, 0o644);
  }

  let release;
  const held = new Promise((resolve) => (release = resolve));
  const { server, posts, port } = await fakeBackend(() => held);
  const statePath = userState(dataDir, port, KEY);
  try {
    const stop = await node(
      [ROUTER],
      baseEnv(signIn(home, { backend: `http://127.0.0.1:${port}`, apiKey: KEY, userId: userOf(KEY) }), port),
      JSON.stringify({
        hook_event_name: "Stop",
        session_id: S2,
        cwd: "/work/repo-b",
        transcript_path: rolloutPath(home, "2026-09-22", S2),
      })
    );
    assert.equal(stop.status, 0, stop.stderr);
    await until(() => posts.length > 0, "the first post");
    assert.equal(modeOf(`${base}.lock`), 0o600);
    release();
    await until(() => readLastRun(statePath) !== undefined && !existsSync(`${base}.lock`), "the pass");
    assert.equal(modeOf(dataDir), 0o700);
    assert.equal(modeOf(path.dirname(statePath)), 0o700);
    for (const file of [statePath, logPath, `${base}.request`]) {
      assert.equal(modeOf(file), 0o600, file);
    }
  } finally {
    release();
    server.close();
  }
});

const KEY_A = "ak_test_codex_user_a";
const KEY_B = "ak_test_codex_user_b";
const syncAs = (home, port, key) =>
  node([SYNC], baseEnv(signIn(home, { backend: `http://127.0.0.1:${port}`, apiKey: key, userId: userOf(key) }), port));

function stateFiles(home) {
  const dir = syncBasePath(path.join(home, "data"));
  if (!existsSync(dir)) return {};
  return Object.fromEntries(
    readdirSync(dir)
      .filter((f) => f.endsWith(".json"))
      .map((f) => [f, readFileSync(path.join(dir, f), "utf8")])
  );
}

test("each API key's user keeps its own sync state and leaves the other's untouched", async () => {
  const { server, port } = await fakeBackend();
  try {
    const home = fixtureHome();
    const a = await syncAs(home, port, KEY_A);
    assert.equal(a.status, 0, a.stderr);
    const afterA = stateFiles(home);
    assert.deepEqual(Object.keys(afterA), [path.basename(userState(path.join(home, "data"), port, KEY_A))]);
    const b = await syncAs(home, port, KEY_B);
    assert.equal(b.status, 0, b.stderr);
    const afterB = stateFiles(home);
    for (const [file, text] of Object.entries(afterA)) assert.equal(afterB[file], text, file);
    assert.ok(afterB[path.basename(userState(path.join(home, "data"), port, KEY_B))]);
  } finally {
    server.close();
  }
});

test("a key whose user the backend cannot resolve syncs nothing and writes no state", async () => {
  const { server, posts, port } = await fakeBackend();
  try {
    for (const [key, reason] of [
      ["ak_test_unknown_codex", "validate-key returned 401"],
      ["ak_test_nouser_codex", "validate-key returned no userId"],
    ]) {
      const home = fixtureHome();
      const res = await syncAs(home, port, key);
      assert.equal(res.status, 1, key);
      assert.ok(res.stderr.includes(`could not resolve the API key's user (${reason}), nothing synced`), res.stderr);
      assert.deepEqual(stateFiles(home), {}, key);
    }
    assert.equal(posts.length, 0);
  } finally {
    server.close();
  }
});

test("a sync running for one key leaves a pass requested with another key to that key", async () => {
  let release;
  const gate = new Promise((resolve) => (release = resolve));
  const { server, posts, port } = await fakeBackend(() => (posts.length === 1 ? gate : true));
  try {
    const home = fixtureHome();
    const a = syncAs(home, port, KEY_A);
    await until(() => posts.length === 1, "user A's first post");
    signIn(home, { backend: `http://127.0.0.1:${port}`, apiKey: KEY_B, userId: userOf(KEY_B) });
    const asB = withHome(home, () => loadConfig(baseEnv(home, port)));
    assert.equal(requestUsageSync(asB), true);
    release();
    const done = await a;
    assert.equal(done.status, 0, done.stderr);
    assert.match(done.stderr, /a pass was requested for another API key/);
    assert.ok(existsSync(`${syncBasePath(path.join(home, "data"))}.request`));
  } finally {
    release();
    server.close();
  }
});

test("a backend URL with a trailing slash keys the same state", () => {
  const who = { product: "armorcodex", userId: "user-1" };
  assert.equal(
    userStatePath("/data", { ...who, backend: "http://127.0.0.1:9/" }),
    userStatePath("/data", { ...who, backend: "http://127.0.0.1:9" })
  );
});

const T = (hhmm) => `2026-10-09T${hhmm}:00.000Z`;
const loginHistory = (events, { id = "h-1", origin = "fresh" } = {}) => ({
  id,
  origin,
  events: events.map(([at, userId], i) => ({ sequence: i + 1, at, userId }))
});
const anchorsOf = (h, observedAt = T("23:00")) => observeHistory(null, h, observedAt).anchors;

function switchHome() {
  const home = mkdtempSync(path.join(tmpdir(), "acx-login-owner-"));
  writeRollout(rolloutPath(home, "2026-10-09", S1), [
    meta(T("09:00"), { id: S1, session_id: S1, cwd: "/work/repo-a" }),
    model(T("09:00"), "gpt-5.5"),
    count(T("09:10"), 7),
    count(T("10:20"), 18),
    count(T("10:45"), 31),
    count(T("11:30"), 48)
  ]);
  return home;
}

const hoursOf = (rows) => rows.map((r) => [r.usageHour, total(r.entries[0])]).sort((a, b) => a[0] - b[0]);

test("a mid-hour login splits a session-hour by event time, and the next owned event counts only its growth", async () => {
  const anchors = anchorsOf(loginHistory([[T("09:00"), "A"], [T("10:37"), "B"]]));
  const home = switchHome();
  const asB = await run(home, await emptyState(home), { owns: ownedBy(anchors, "B") });
  assert.deepEqual(hoursOf(asB.rows), [[10, 13], [11, 17]]);
  const asA = await run(home, await emptyState(home), { owns: ownedBy(anchors, "A") });
  assert.deepEqual(hoursOf(asA.rows), [[9, 7], [10, 11]]);
});

test("A -> B -> A with no sync while B was logged in keeps B's interval for B", async () => {
  const anchors = anchorsOf(loginHistory([[T("09:00"), "A"], [T("10:37"), "B"], [T("11:05"), "A"]]));
  const home = switchHome();
  const asA = await run(home, await emptyState(home), { owns: ownedBy(anchors, "A") });
  assert.deepEqual(hoursOf(asA.rows), [[9, 7], [10, 11], [11, 17]]);
  const asB = await run(home, await emptyState(home), { owns: ownedBy(anchors, "B") });
  assert.deepEqual(hoursOf(asB.rows), [[10, 13]]);
});

test("A's rows that failed before a switch are posted when A syncs again", async () => {
  const anchors = anchorsOf(loginHistory([[T("09:00"), "A"], [T("10:37"), "B"], [T("11:05"), "A"]]));
  const home = switchHome();
  const state = await emptyState(home);
  const failed = await run(home, state, { owns: ownedBy(anchors, "A"), fail: () => true });
  assert.ok(failed.report.failed > 0);
  const again = await run(home, state, { owns: ownedBy(anchors, "A") });
  assert.deepEqual(hoursOf(again.rows), [[9, 7], [10, 11], [11, 17]]);
});

test("a dashboard history request claims only unassigned time and its own, never another user's", async () => {
  const seen = anchorsOf(loginHistory([[T("09:00"), "A"]]), T("09:30"));
  const { anchors } = observeHistory(seen, loginHistory([[T("11:00"), "B"]], { id: "h-2", origin: "unknown" }), T("11:40"));
  const home = switchHome();
  const claimed = await run(home, await emptyState(home), { owns: ownedOrUnassigned(anchors, "B") });
  assert.deepEqual(hoursOf(claimed.rows), [[10, 24], [11, 17]]);
});
