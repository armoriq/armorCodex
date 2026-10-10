import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { appendFileSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadConfig } from "../plugins/armorcodex/scripts/lib/config.mjs";
import { liveTranscript } from "../plugins/armorcodex/scripts/lib/live-usage.mjs";
import { signIn, withHome } from "./helpers/login.mjs";
import {
  backend,
  closeBackend,
  count,
  env,
  GENERATION,
  home,
  isoAgo,
  KEY,
  meta,
  model,
  rolloutPath,
  run,
  WORKER,
  sessionBatches,
  settled,
  stop,
  total,
  until,
  writeRollout,
} from "./helpers/live-usage.mjs";

test("the live upload takes only the stopping session's own rollout under the sessions directory", () => {
  const root = "/home/u/.codex/sessions";
  const id = randomUUID();
  const own = `${root}/2026/10/10/rollout-2026-10-10T09-00-00-${id}.jsonl`;
  assert.equal(liveTranscript(root, id, own), own);
  for (const bad of [
    `/tmp/rollout-2026-10-10T09-00-00-${id}.jsonl`,
    `${root}/../rollout-2026-10-10T09-00-00-${id}.jsonl`,
    `${root}/2026/10/10/rollout-2026-10-10T09-00-00-${randomUUID()}.jsonl`,
    `${root}/2026/10/10/${id}.jsonl`,
    "relative.jsonl",
  ])
    assert.equal(liveTranscript(root, id, bad), null, bad);
  assert.equal(liveTranscript(root, "not-a-session", own), null);
});

async function withSession(loggedInAt, fn) {
  const b = await backend();
  const h = home(b.url, loggedInAt);
  try {
    await fn(b, h);
  } finally {
    await closeBackend(b);
    rmSync(h, { recursive: true, force: true });
  }
}

function session(h, at, lines) {
  const id = randomUUID();
  const file = rolloutPath(h, at, id);
  writeRollout(file, [meta(at, { id, session_id: id, cwd: "/work/repo" }), model(at, "gpt-5.5"), ...lines]);
  return { id, file };
}

const line = (record) => JSON.stringify(record) + "\n";
const entryOf = (e) => [e.model, e.inputTokens, e.outputTokens, e.cacheReadTokens, e.reasoningOutputTokens];
const modeOf = (file) => statSync(file).mode & 0o777;

test("a Stop posts its own session while the usage worker is held on a backlog", async () => {
  await withSession(isoAgo(3 * 3_600_000), async (b, h) => {
    const held = [];
    b.onBatch = (res, body) => Boolean(body.runId) && held.push(res) > 0;
    for (let i = 0; i < 30; i++) session(h, isoAgo(2 * 3_600_000 + i * 1000), [count(isoAgo(2 * 3_600_000), 3, 1)]);
    const scan = run(WORKER, env(h, b.url));
    await until(() => held.length > 0, "the worker's first held batch");
    const at = isoAgo(60_000);
    const target = session(h, at, [count(at, 20_000, 500, 12_000, 100), count(at, 50_000, 1790, 40_000, 400)]);
    await stop(h, b.url, target.id, target.file);
    await until(() => sessionBatches(b, target.id).length > 0, "the live session's batch");
    const [hour] = sessionBatches(b, target.id);
    assert.deepEqual([hour.usageDate, hour.usageHour, total(hour)], [at.slice(0, 10), Number(at.slice(11, 13)), 51_790]);
    assert.equal(b.batches[0].generation, GENERATION);
    assert.equal(b.batches.filter((x) => x.runId).flatMap((x) => x.snapshots).length, 30);
    for (const res of held) res.socket.destroy();
    await scan;
  });
});

test("a session's subagent rollouts count with its own, models and reasoning kept apart", async () => {
  await withSession(isoAgo(3 * 3_600_000), async (b, h) => {
    const at = isoAgo(60_000);
    const main = session(h, at, [count(at, 100, 40, 20, 15)]);
    const sub = randomUUID();
    writeRollout(rolloutPath(h, at, sub), [
      meta(at, { id: sub, session_id: main.id, source: { subagent: { thread_spawn: { parent_thread_id: main.id } } } }),
      model(at, "gpt-5.5-mini"),
      count(at, 7, 3),
    ]);
    await stop(h, b.url, main.id, main.file);
    await until(() => sessionBatches(b, main.id).length > 0, "the batch");
    const [hour] = sessionBatches(b, main.id);
    assert.deepEqual(hour.entries.map(entryOf), [
      ["gpt-5.5", 80, 40, 20, 15],
      ["gpt-5.5-mini", 7, 3, 0, 0],
    ]);
    assert.equal(hour.repo, "/work/repo");
    assert.equal(sessionBatches(b, sub).length, 0);
  });
});

test("a session that spans the login posts only the usage dated after it", async () => {
  await withSession(isoAgo(30 * 60_000), async (b, h) => {
    const s = session(h, isoAgo(45 * 60_000), [count(isoAgo(40 * 60_000), 10), count(isoAgo(20 * 60_000), 30)]);
    await stop(h, b.url, s.id, s.file);
    await until(() => sessionBatches(b, s.id).length > 0, "the batch");
    assert.deepEqual(sessionBatches(b, s.id).map(total), [20]);
  });
});

test("a batch the backend committed is sent again once with the same id and bytes when its reply is lost", async () => {
  await withSession(isoAgo(3 * 3_600_000), async (b, h) => {
    b.onBatch = (res) => {
      b.onBatch = null;
      res.socket.destroy();
      return true;
    };
    const s = session(h, isoAgo(120_000), [count(isoAgo(120_000), 7)]);
    await stop(h, b.url, s.id, s.file);
    await until(() => b.batches.length === 1, "the first batch");
    assert.equal((await settled(h, s.id)).queued().length, 1);
    appendFileSync(s.file, line(count(isoAgo(60_000), 10)));
    await stop(h, b.url, s.id, s.file);
    await until(() => b.batches.length === 3, "the replay and the next capture");
    const files = await settled(h, s.id);
    assert.deepEqual(b.batches[1], b.batches[0]);
    assert.ok(b.batches[2].snapshots[0].revision > b.batches[0].snapshots[0].revision);
    assert.deepEqual(files.queued(), []);
  });
});

test("a batch the backend refuses for good is set aside with its reason and the next capture is sent", async () => {
  await withSession(isoAgo(3 * 3_600_000), async (b, h) => {
    let refusedId;
    b.onBatch = (res, body) => {
      refusedId ??= body.batchId;
      if (body.batchId !== refusedId) return false;
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ message: "usageHour must be a UTC hour" }));
      return true;
    };
    const s = session(h, isoAgo(120_000), [count(isoAgo(120_000), 7)]);
    await stop(h, b.url, s.id, s.file);
    await until(() => b.batches.length === 1, "the refused batch");
    await settled(h, s.id);
    appendFileSync(s.file, line(count(isoAgo(60_000), 10)));
    await stop(h, b.url, s.id, s.file);
    await until(() => b.batches.some((x) => x.batchId !== refusedId), "the next capture");
    const files = await settled(h, s.id);
    assert.deepEqual(files.queued(), []);
    const [aside] = files.refused();
    assert.deepEqual([aside.batch.batchId, aside.refused], [refusedId, { status: 400, reason: "usageHour must be a UTC hour" }]);
  });
});

test("after the usage stream is reset every hour of the session is sent again under the new generation", async () => {
  await withSession(isoAgo(3 * 3_600_000), async (b, h) => {
    const earlier = isoAgo(2 * 3_600_000);
    const s = session(h, earlier, [count(earlier, 4), count(isoAgo(60_000), 10)]);
    await stop(h, b.url, s.id, s.file);
    await until(() => b.batches.length === 1, "the first batch");
    await settled(h, s.id);
    b.generation = randomUUID();
    appendFileSync(s.file, line(count(isoAgo(30_000), 15)));
    await stop(h, b.url, s.id, s.file);
    await until(() => b.batches.length === 2, "the batch under the new generation");
    await settled(h, s.id);
    assert.equal(b.batches[1].generation, b.generation);
    assert.deepEqual(b.batches[1].snapshots.map(total).sort((x, y) => x - y), [4, 11]);
  });
});

test("a Stop uploads nothing while the usage sync is off, and keeps its state and log owner-only once on", async () => {
  await withSession(isoAgo(3 * 3_600_000), async (b, h) => {
    const s = session(h, isoAgo(60_000), [count(isoAgo(60_000), 5)]);
    for (const off of [{ CODEX_PLUGIN_OPTION_DISABLE_USAGE_SYNC: "true" }, { CODEX_PLUGIN_OPTION_DISABLE_OBSERVABILITY: "true" }]) {
      const res = await stop(h, b.url, s.id, s.file, off);
      assert.equal(res.code, 0, res.stderr);
    }
    await new Promise((r) => setTimeout(r, 1000));
    assert.equal(b.batches.length, 0);
    await stop(h, b.url, s.id, s.file);
    await until(() => b.batches.length === 1, "the batch");
    const files = await settled(h, s.id);
    assert.equal(modeOf(files.dir), 0o700);
    for (const file of [path.join(files.dir, `${s.id}.json`), path.join(h, "data", "usage-sync.log")])
      assert.equal(modeOf(file), 0o600, file);
  });
});

test("a batch refused for good is retried hour by hour, only the refused hour is set aside, and it is sent again only once it changes", async () => {
  await withSession(isoAgo(3 * 3_600_000), async (b, h) => {
    const bad = isoAgo(2 * 3_600_000);
    const isBad = (s) => s.usageDate === bad.slice(0, 10) && s.usageHour === Number(bad.slice(11, 13));
    b.onBatch = (res, body) => {
      if (!body.snapshots.some(isBad)) return false;
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ message: "usageHour must be a UTC hour" }));
      return true;
    };
    const s = session(h, bad, [count(bad, 4), count(isoAgo(60_000), 10)]);
    await stop(h, b.url, s.id, s.file);
    const alone = (x) => x.snapshots.length === 1 && !isBad(x.snapshots[0]);
    await until(() => b.batches.some(alone), "the good hour alone");
    const files = await settled(h, s.id);
    assert.deepEqual(files.refused().map((r) => r.batch.snapshots.map(total)), [[4]]);
    const sentBefore = b.batches.length;
    appendFileSync(s.file, line(count(isoAgo(30_000), 15)));
    await stop(h, b.url, s.id, s.file);
    await until(() => b.batches.length > sentBefore, "the next capture");
    await settled(h, s.id);
    assert.deepEqual(b.batches.slice(sentBefore).flatMap((x) => x.snapshots).map(total), [11]);
  });
});

const OBS_OFF = { CODEX_PLUGIN_OPTION_DISABLE_OBSERVABILITY: "true" };
const SYNC_OFF = { CODEX_PLUGIN_OPTION_DISABLE_USAGE_SYNC: "true" };

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

