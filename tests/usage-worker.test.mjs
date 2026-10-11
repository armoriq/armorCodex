import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { appendFileSync, chmodSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  backend,
  closeBackend,
  count,
  env,
  home,
  meta,
  model,
  rolloutPath,
  run,
  sessionBatches,
  settled,
  stop,
  total,
  until,
  writeRollout,
} from "./helpers/live-usage.mjs";

const worker = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "plugins",
  "armorcodex",
  "scripts",
  "usage-worker.mjs"
);
const HOUR = 3_600_000;
const hourStart = Math.floor((Date.now() - 2 * HOUR) / HOUR) * HOUR;
const at = (minute) => new Date(hourStart + minute * 60_000).toISOString();

async function withBackend(loggedInAt, fn) {
  const b = await backend();
  b.release();
  const h = home(b.url, loggedInAt);
  try {
    await fn(b, h);
  } finally {
    await closeBackend(b);
    rmSync(h, { recursive: true, force: true });
  }
}

function session(h, startedAt, lines) {
  const id = randomUUID();
  const file = rolloutPath(h, startedAt, id);
  writeRollout(file, [meta(startedAt, { id, session_id: id, cwd: "/work/repo" }), model(startedAt, "gpt-5.5"), ...lines]);
  return { id, file };
}

const runWorker = async (h, b) => {
  const result = await run(worker, env(h, b.url));
  assert.equal(result.code, 0, result.stderr);
  return result;
};
const failSecondBatch = (b) => {
  let seen = 0;
  b.onBatch = (res) => {
    if (++seen !== 2) return false;
    b.onBatch = null;
    res.writeHead(503, { "content-type": "application/json" });
    res.end(JSON.stringify({ message: "busy" }));
    return true;
  };
};
const reportsOf = (b, mode) => b.reports.filter((r) => r.mode === mode);
const line = (record) => JSON.stringify(record) + "\n";

test("a session admits its usage from before the login only after a history upload of it is acknowledged (10 + 20 + 5 = 35)", async () => {
  await withBackend(at(30), async (b, h) => {
    const s = session(h, at(5), [count(at(10), 10), count(at(40), 30)]);
    await stop(h, b.url, s.id, s.file);
    await until(() => sessionBatches(b, s.id).length === 1, "the live batch");
    await settled(h, s.id);
    assert.deepEqual(sessionBatches(b, s.id).map(total), [20]);

    b.requestId = randomUUID();
    b.onBatch = (res, body) => {
      if (!body.runId) return false;
      res.writeHead(503, { "content-type": "application/json" });
      res.end(JSON.stringify({ message: "busy" }));
      return true;
    };
    await runWorker(h, b);
    appendFileSync(s.file, line(count(at(50), 35)));
    await stop(h, b.url, s.id, s.file);
    await until(() => sessionBatches(b, s.id).length === 3, "the live batch before the grant");
    await settled(h, s.id);
    assert.equal(total(sessionBatches(b, s.id).at(-1)), 25);

    b.onBatch = null;
    await runWorker(h, b);
    const history = b.batches.filter((x) => b.runs.get(x.runId)?.mode === "history");
    assert.deepEqual(history.at(-1).snapshots.map(total), [30]);
    assert.equal(reportsOf(b, "history").at(-1).phase, "complete");
    assert.equal(b.requestId, null);

    await stop(h, b.url, s.id, s.file);
    await until(() => sessionBatches(b, s.id).length === 5, "the live batch after the grant");
    await settled(h, s.id);
    assert.equal(total(sessionBatches(b, s.id).at(-1)), 35);
  });
});

test("a run keeps every acknowledged batch when a later one fails, and the next run sends only the rest", async () => {
  await withBackend(at(0), async (b, h) => {
    for (let i = 0; i < 101; i++) session(h, at(10), [count(at(20), 1)]);
    failSecondBatch(b);
    await runWorker(h, b);
    assert.deepEqual(b.batches.map((x) => x.snapshots.length), [100, 1]);
    assert.deepEqual(
      reportsOf(b, "discovery").map((r) => [r.phase, r.errorCode]),
      [
        ["discovering", undefined],
        ["retrying", "upload_failed"],
      ]
    );
    await runWorker(h, b);
    assert.equal(b.batches.length, 3);
    assert.equal(b.batches[2].batchId, b.batches[1].batchId);
    const done = reportsOf(b, "discovery").at(-1);
    assert.deepEqual([done.phase, done.total], ["complete", 101]);

    await runWorker(h, b);
    assert.equal(b.batches.length, 3);
    assert.equal(b.reports.length, 3);
  });
});

test("a history request cancelled before its upload is acknowledged sends nothing more and admits nothing", async () => {
  await withBackend(at(30), async (b, h) => {
    const s = session(h, at(5), [count(at(10), 10), count(at(40), 30)]);
    b.requestId = randomUUID();
    failSecondBatch(b);
    await runWorker(h, b);
    assert.deepEqual(
      b.batches.map((x) => [b.runs.get(x.runId).mode, x.snapshots.map(total)]),
      [
        ["discovery", [20]],
        ["history", [30]],
      ]
    );
    b.requestId = null;
    await runWorker(h, b);
    assert.equal(b.batches.length, 2);
    assert.equal(b.reports.at(-1).phase, "retrying");
    appendFileSync(s.file, line(count(at(50), 35)));
    await stop(h, b.url, s.id, s.file);
    await until(() => sessionBatches(b, s.id).length === 3, "the live batch");
    await settled(h, s.id);
    assert.equal(total(sessionBatches(b, s.id).at(-1)), 25);
  });
});

test("a history request stays open while one of its sessions cannot be read, and completes once it is read", async () => {
  await withBackend(at(30), async (b, h) => {
    const s = session(h, at(5), [count(at(10), 10)]);
    const sub = rolloutPath(h, at(6), randomUUID());
    writeRollout(sub, [meta(at(6), { id: path.basename(sub).slice(-41, -5), session_id: s.id }), count(at(12), 4)]);
    await runWorker(h, b);
    chmodSync(sub, 0o000);
    b.requestId = randomUUID();
    for (let pass = 0; pass < 2; pass++) {
      await runWorker(h, b);
      const last = reportsOf(b, "history").at(-1);
      assert.deepEqual([last.phase, last.errorCode], ["uploading", "source_unreadable"]);
      assert.notEqual(b.requestId, null);
    }
    chmodSync(sub, 0o600);
    await runWorker(h, b);
    assert.equal(reportsOf(b, "history").at(-1).phase, "complete");
    assert.equal(b.requestId, null);
    assert.equal(total(sessionBatches(b, s.id).at(-1)), 14);
  });
});

test("a history run with one hour the backend refuses for good completes with the remaining hours", async () => {
  await withBackend(at(30), async (b, h) => {
    const kept = session(h, at(5), [count(at(10), 10)]);
    const refused = session(h, at(6), [count(at(12), 7)]);
    b.onBatch = (res, body) => {
      if (!body.snapshots.some((s) => s.sessionId === refused.id)) return false;
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ message: "entries are invalid" }));
      return true;
    };
    b.requestId = randomUUID();
    await runWorker(h, b);
    const done = reportsOf(b, "history").at(-1);
    assert.deepEqual([done.phase, done.total], ["complete", 1]);
    assert.equal(b.requestId, null);
    assert.equal(sessionBatches(b, kept.id).length > 0, true);
  });
});

test("a history request completes when a session is a fork whose original is gone, counting the fork in full", async () => {
  await withBackend(at(30), async (b, h) => {
    const id = randomUUID();
    const file = rolloutPath(h, at(5), id);
    writeRollout(file, [
      meta(at(5), { id, session_id: id, forked_from_id: randomUUID() }),
      model(at(5), "gpt-5.5"),
      count(at(5), 50),
      count(at(10), 80),
    ]);
    b.requestId = randomUUID();
    const { stderr } = await runWorker(h, b);
    assert.equal(reportsOf(b, "history").at(-1).phase, "complete");
    assert.equal(b.requestId, null);
    assert.deepEqual(sessionBatches(b, id).map(total), [80]);
    assert.match(stderr, /fork_original_missing/);
  });
});

const turnDone = (startIso, durationMs, turnId = randomUUID()) => ({
  timestamp: new Date(Date.parse(startIso) + durationMs).toISOString(),
  type: "event_msg",
  payload: {
    type: "task_complete",
    turn_id: turnId,
    duration_ms: durationMs,
    started_at: Date.parse(startIso) / 1000,
    completed_at: (Date.parse(startIso) + durationMs) / 1000,
  },
});
const latencyOf = (b, sessionId) => b.latency.filter((p) => p.sessionId === sessionId);
const day = (iso) => iso.slice(0, 10);

test("the worker sends each session-day's turn latency from Codex's task_complete records, replacing the day after another turn", async () => {
  await withBackend(at(1), async (b, h) => {
    const s = session(h, at(2), [turnDone(at(3), 1_200), turnDone(at(5), 5_000), turnDone(at(8), 30_000)]);
    await runWorker(h, b);
    assert.deepEqual(
      latencyOf(b, s.id).map(({ product, usageDate, sampleCount, totalMs, maxMs, buckets }) => ({
        product, usageDate, sampleCount, totalMs, maxMs, samples: buckets.reduce((a, n) => a + n, 0),
      })),
      [{ product: "armorcodex", usageDate: day(at(3)), sampleCount: 3, totalMs: 36_200, maxMs: 30_000, samples: 3 }],
    );
    assert.ok(latencyOf(b, s.id)[0].deviceId);

    await runWorker(h, b);
    assert.equal(latencyOf(b, s.id).length, 1, "an unchanged session is not sent again");

    appendFileSync(s.file, line(turnDone(at(20), 800)));
    await runWorker(h, b);
    assert.deepEqual(latencyOf(b, s.id).map((p) => [p.sampleCount, p.totalMs]), [[3, 36_200], [4, 37_000]]);
  });
});

test("turn latency leaves out turns from before the login and turns a fork copied from its original", async () => {
  await withBackend(at(10), async (b, h) => {
    const original = session(h, at(1), [turnDone(at(2), 4_000), turnDone(at(12), 2_000)]);
    const forkId = randomUUID();
    const fork = rolloutPath(h, at(20), forkId);
    writeRollout(fork, [
      meta(at(20), { id: forkId, session_id: forkId, forked_from_id: original.id, cwd: "/work/repo" }),
      model(at(20), "gpt-5.5"),
      turnDone(at(12), 2_000),
      turnDone(at(25), 9_000),
    ]);
    await runWorker(h, b);
    assert.deepEqual(latencyOf(b, original.id).map((p) => [p.sampleCount, p.totalMs]), [[1, 2_000]]);
    assert.deepEqual(latencyOf(b, forkId).map((p) => [p.sampleCount, p.totalMs]), [[1, 9_000]]);
  });
});

test("a turn latency post the backend refuses is sent again on the next run", async () => {
  await withBackend(at(1), async (b, h) => {
    const s = session(h, at(2), [turnDone(at(3), 1_500)]);
    b.onLatency = (res) => {
      res.writeHead(503, { "content-type": "application/json" });
      res.end(JSON.stringify({ message: "busy" }));
      return true;
    };
    const first = await runWorker(h, b);
    assert.match(first.stderr, /could not send the turn latency/);
    assert.equal(latencyOf(b, s.id).length, 0);
    b.onLatency = null;
    await runWorker(h, b);
    assert.deepEqual(latencyOf(b, s.id).map((p) => p.sampleCount), [1]);
  });
});
