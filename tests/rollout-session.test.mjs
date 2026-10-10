import { test } from "node:test";
import assert from "node:assert/strict";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { captureCodexSession, listSessions } from "../plugins/armorcodex/scripts/lib/rollout-session.mjs";
import { sessionFingerprint } from "../plugins/armorcodex/scripts/lib/live-usage.mjs";

const S1 = "019e0000-0000-7000-8000-000000000001";
const S2 = "019e0000-0000-7000-8000-000000000002";
const S0 = "019e0000-0000-7000-8000-000000000000";
const A1 = "019e0000-0000-7000-8000-0000000000a1";
const F1 = "019e0000-0000-7000-8000-0000000000f1";

const meta = (timestamp, payload) => ({
  timestamp,
  type: "session_meta",
  payload: { timestamp, ...payload },
});
const model = (timestamp, name) => ({
  timestamp,
  type: "turn_context",
  payload: { model: name },
});
const count = (timestamp, input, output = 0, reasoning = 0) => ({
  timestamp,
  type: "event_msg",
  payload: {
    type: "token_count",
    info: {
      total_token_usage: {
        input_tokens: input,
        cached_input_tokens: 0,
        output_tokens: output,
        reasoning_output_tokens: reasoning,
      },
    },
  },
});

function codexHome() {
  const home = mkdtempSync(path.join(tmpdir(), "acx-rollout-session-"));
  assert.ok(home.startsWith(tmpdir()));
  return home;
}

const rolloutPath = (home, day, id, root = "sessions") =>
  path.join(
    home,
    root,
    ...day.split("-"),
    `rollout-${day}T09-00-00-${id}.jsonl`,
  );

function writeRollout(file, lines) {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, lines.map((l) => JSON.stringify(l)).join("\n"));
}

const capture = (home, transcript, sessionId, cutoff = 0) =>
  captureCodexSession({
    roots: [path.join(home, "sessions"), path.join(home, "archived_sessions")],
    transcript,
    sessionId,
    cutoff,
    indexPath: path.join(home, "index.json"),
  });

const totals = (snapshot) =>
  snapshot.entries.map((e) => [
    e.model,
    e.inputTokens,
    e.outputTokens,
    e.reasoningOutputTokens,
  ]);

test("a session counts its main rollout and its subagents' rollouts, and nothing else", async () => {
  const home = codexHome();
  const main = rolloutPath(home, "2026-09-20", S1);
  writeRollout(main, [
    meta("2026-09-20T09:00:00Z", {
      id: S1,
      session_id: S1,
      cwd: "/work/repo-a",
    }),
    model("2026-09-20T09:00:01Z", "gpt-5.5"),
    count("2026-09-20T09:01:00Z", 100, 40, 15),
  ]);
  writeRollout(rolloutPath(home, "2026-09-21", A1), [
    meta("2026-09-21T09:03:00Z", {
      id: A1,
      session_id: S1,
      source: { subagent: { thread_spawn: { parent_thread_id: S1 } } },
    }),
    model("2026-09-21T09:03:01Z", "gpt-5.5-mini"),
    count("2026-09-21T09:04:00Z", 7, 3),
  ]);
  writeRollout(rolloutPath(home, "2026-09-21", S2), [
    meta("2026-09-21T09:00:00Z", { id: S2, session_id: S2 }),
    count("2026-09-21T09:05:00Z", 999),
  ]);
  writeRollout(rolloutPath(home, "2026-09-19", S0), [
    meta("2026-09-19T09:00:00Z", { id: S0, session_id: S1 }),
    count("2026-09-19T09:05:00Z", 555),
  ]);

  const taken = await capture(home, main, S1);
  assert.deepEqual(taken.problems, []);
  assert.equal(taken.repo, "/work/repo-a");
  assert.deepEqual(
    taken.hours.map((h) => [h.usageDate, h.usageHour, totals(h)]),
    [
      ["2026-09-20", 9, [["gpt-5.5", 100, 40, 15]]],
      ["2026-09-21", 9, [["gpt-5.5-mini", 7, 3, 0]]],
    ],
  );
  const index = JSON.parse(readFileSync(path.join(home, "index.json"), "utf8"));
  assert.deepEqual(
    Object.keys(index)
      .map((f) => path.basename(f))
      .sort(),
    [
      path.basename(main),
      path.basename(rolloutPath(home, "2026-09-21", A1)),
      path.basename(rolloutPath(home, "2026-09-21", S2)),
    ].sort(),
  );
});

test("only usage dated at or after the cutoff counts, across the main rollout and its subagents", async () => {
  const home = codexHome();
  const main = rolloutPath(home, "2026-09-20", S1);
  writeRollout(main, [
    meta("2026-09-20T09:00:00Z", { id: S1, session_id: S1 }),
    count("2026-09-20T09:10:00Z", 10),
    count("2026-09-20T09:40:00Z", 30),
  ]);
  writeRollout(rolloutPath(home, "2026-09-20", A1), [
    meta("2026-09-20T09:00:00Z", { id: A1, session_id: S1 }),
    count("2026-09-20T09:20:00Z", 4),
    count("2026-09-20T09:50:00Z", 9),
  ]);
  const taken = await capture(
    home,
    main,
    S1,
    Date.parse("2026-09-20T09:30:00Z"),
  );
  assert.deepEqual(
    taken.hours.map((h) => h.entries.reduce((n, e) => n + e.inputTokens, 0)),
    [20 + 5],
  );
});

test("a fork without turn ids leaves out the history it copied, and reports a missing original", async () => {
  const home = codexHome();
  const original = [
    meta("2026-09-20T09:00:00Z", { id: S1, session_id: S1 }),
    count("2026-09-20T09:01:00Z", 50),
  ];
  writeRollout(
    rolloutPath(home, "2026-09-20", S1, "archived_sessions"),
    original,
  );
  const fork = rolloutPath(home, "2026-09-22", F1);
  writeRollout(fork, [
    meta("2026-09-22T09:00:00Z", {
      id: F1,
      session_id: F1,
      forked_from_id: S1,
    }),
    count("2026-09-22T09:00:00Z", 50),
    count("2026-09-22T09:05:00Z", 80),
  ]);
  const taken = await capture(home, fork, F1);
  assert.deepEqual(taken.problems, []);
  assert.deepEqual(
    taken.hours.map((h) => h.entries[0].inputTokens),
    [30],
  );

  const orphanHome = codexHome();
  const orphan = rolloutPath(orphanHome, "2026-09-22", F1);
  writeRollout(
    orphan,
    readFileSync(fork, "utf8")
      .split("\n")
      .map((l) => JSON.parse(l)),
  );
  const alone = await capture(orphanHome, orphan, F1);
  assert.deepEqual(alone.problems, []);
  assert.deepEqual(
    alone.warnings.map((w) => w.reason),
    ["fork_original_missing"],
  );
});

test("a subagent rollout that cannot be read is reported and the rest still counts", async () => {
  const home = codexHome();
  const main = rolloutPath(home, "2026-09-20", S1);
  writeRollout(main, [
    meta("2026-09-20T09:00:00Z", { id: S1, session_id: S1 }),
    count("2026-09-20T09:01:00Z", 12),
  ]);
  const sub = rolloutPath(home, "2026-09-20", A1);
  writeRollout(sub, [
    meta("2026-09-20T09:00:00Z", { id: A1, session_id: S1 }),
    count("2026-09-20T09:02:00Z", 5),
  ]);
  await capture(home, main, S1);
  chmodSync(sub, 0o000);
  const taken = await capture(home, main, S1);
  assert.deepEqual(taken.problems, [{ path: sub, reason: "unreadable" }]);
  assert.deepEqual(
    taken.hours.map((h) => h.entries[0].inputTokens),
    [12],
  );
});

test("one listing gives every session its subagent rollouts, so fingerprints read no index", async () => {
  const home = codexHome();
  const roots = [path.join(home, "sessions"), path.join(home, "archived_sessions")];
  const indexPath = path.join(home, "index.json");
  const ids = Array.from({ length: 40 }, (_, i) => `019e0000-0000-7000-8000-${String(i).padStart(12, "0")}`);
  for (const id of ids) {
    writeRollout(rolloutPath(home, "2026-09-20", id), [meta("2026-09-20T09:00:00Z", { id, session_id: id }), count("2026-09-20T09:01:00Z", 1)]);
  }
  const sub = rolloutPath(home, "2026-09-21", A1);
  writeRollout(sub, [meta("2026-09-21T09:00:00Z", { id: A1, session_id: ids[0] }), count("2026-09-21T09:01:00Z", 2)]);
  const sessions = await listSessions({ roots, indexPath });
  chmodSync(indexPath, 0o000);
  assert.equal(sessions.length, ids.length);
  assert.deepEqual(sessions.find((s) => s.sessionId === ids[0]).members.map((f) => path.basename(f)), [
    path.basename(rolloutPath(home, "2026-09-20", ids[0])),
    path.basename(sub),
  ]);
  const prints = new Set(sessions.map((s) => sessionFingerprint(s, 0)));
  assert.equal(prints.size, ids.length);
});
