import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, fork } from "node:child_process";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { once } from "node:events";
import { appendFile, mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { auditLogin, createAuditWal } from "../plugins/armorcodex/scripts/lib/audit-wal.mjs";
import { createIapService } from "../plugins/armorcodex/scripts/lib/iap-service.mjs";
import { handlePostToolUse, handleUserPromptSubmit } from "../plugins/armorcodex/scripts/lib/engine.mjs";
import { probeBackend } from "../plugins/armorcodex/scripts/lib/backend-posture.mjs";

const login = { backend: "https://a.invalid", keyId: "key-a" };
const row = (n = 1) => ({ client_row_id: `11111111-1111-5111-8111-${String(n).padStart(12, "0")}`, tool: "Bash", action: "Bash", input: {} });
const accept = async ({ rows }) => ({ status: 200, body: { results: rows.map(({ client_row_id }) => ({ client_row_id, outcome: "accepted" })) } });

async function setup(t, options = {}) {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "armorcodex-outbox-storage-"));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const opts = { dataDir, login, ...options };
  return { dataDir, wal: createAuditWal(opts), reopen: () => createAuditWal(opts) };
}

test("legacy rows with no provable login remain undeliverable after a new login captures and drains", async (t) => {
  const { dataDir, wal, reopen } = await setup(t);
  await mkdir(path.join(dataDir, "audit"));
  await writeFile(path.join(dataDir, "audit", "current.jsonl"), [row(1), row(2)].map(JSON.stringify).join("\n") + "\n");
  await writeFile(path.join(dataDir, "audit", "shipped.offset"), String(Buffer.byteLength(JSON.stringify(row(1)) + "\n")));
  await wal.appendLine(row(3));
  await wal.drain(async (request) => {
    assert.deepEqual(request.rows, [row(3)]);
    return accept(request);
  });
  assert.deepEqual((await reopen().readPending()).map(({ row }) => row.client_row_id), [row(2).client_row_id]);
  assert.equal((await wal.status()).undeliverable, 1);
});

test("batch_oversize outcomes split only affected rows without spending split attempts", async (t) => {
  const { wal } = await setup(t);
  for (let n = 1; n <= 3; n++) await wal.appendLine(row(n));
  const sent = [];
  await wal.drain(async ({ rows }) => {
    sent.push(rows.map(({ client_row_id }) => client_row_id));
    if (rows.length > 1) return { status: 200, body: { results: rows.map(({ client_row_id }, i) => ({
      client_row_id, outcome: i === 0 ? "accepted" : "retryable", ...(i === 0 ? {} : { error: "batch_oversize" })
    })) } };
    return { status: 503, body: {} };
  });
  assert.deepEqual(sent.map((batch) => batch.length), [3, 1, 1]);
  assert.deepEqual((await wal.readPending()).map(({ attempts }) => attempts), [0, 0]);
});

for (const body of [{ results: null }, { failures: [{ index: 0, error: "busy" }, { index: 0, error: "again" }] }]) {
  test(`ambiguous response retains all rows without splitting: ${JSON.stringify(body)}`, async (t) => {
    const { wal } = await setup(t);
    await wal.appendLine(row(1));
    await wal.appendLine(row(2));
    let sends = 0;
    await wal.drain(async () => { sends++; return { status: Object.hasOwn(body, "results") ? 400 : 200, body }; });
    assert.equal(sends, 1);
    assert.deepEqual((await wal.readPending()).map(({ attempts }) => attempts), [0, 0]);
  });
}

for (const status of [400, 422]) {
  // regression: #0012
  test(`a legacy failures list is not delivery proof on HTTP ${status}`, async (t) => {
    const { wal } = await setup(t);
    await wal.appendLine(row());
    await wal.drain(async () => ({ status, body: { failures: [] } }));
    assert.deepEqual(await wal.readPending(), []);
    assert.equal((await wal.readDeadLetters())[0]?.attempts, 1);
  });
}

test("queue state and dead letters are private and contain no credential secret", async (t) => {
  const config = { backendEndpoint: "https://a.invalid", apiKey: "ak_test_secret_never_in_queue" };
  const { wal, dataDir } = await setup(t, { login: auditLogin(config) });
  await wal.appendLine(row());
  await wal.drain(async ({ rows }) => ({ status: 200, body: { results: rows.map(({ client_row_id }) => ({ client_row_id, outcome: "rejected", error: "invalid" })) } }));
  for (const file of await readdir(path.join(dataDir, "audit"), { recursive: true })) {
    const target = path.join(dataDir, "audit", file);
    if (!(await stat(target)).isFile()) continue;
    assert.equal((await stat(target)).mode & 0o777, 0o600);
    assert.ok(!(await readFile(target, "utf8")).includes(config.apiKey));
  }
  assert.equal((await wal.status()).deadLetters, 1);
});

async function releasedWal(dataDir) {
  const source = execFileSync("git", ["show", "origin/dev:plugins/armorcodex/scripts/lib/audit-wal.mjs"], { encoding: "utf8" });
  const dependency = new URL("../plugins/armorcodex/scripts/lib/fs-store.mjs", import.meta.url).href;
  const released = await import(`data:text/javascript,${encodeURIComponent(source.replace('"./fs-store.mjs"', JSON.stringify(dependency)))}`);
  return released.createAuditWal({ dataDir, rotateBytes: 1 });
}

const legacyLogin = (key = "ak_test_legacy") => ({
  backendEndpoint: login.backend, apiKey: key, userId: "user-a", loggedInAt: "2026-11-14T11:00:00.000Z",
  loginHistory: { id: "legacy-history", origin: "fresh", events: [{ sequence: 1, at: "2026-11-14T11:00:00.000Z", userId: "user-a" }] }
});

// regression: #0010
test("R15: released appends and rotation coexist with read only pickup and durable receipts", async (t) => {
  let config = legacyLogin();
  const { wal, dataDir, reopen } = await setup(t, { login: () => auditLogin(config) });
  const old = await releasedWal(dataDir);
  await old.appendLine({ ...row(1), executed_at: "2026-11-14T12:00:00.000Z" });
  const current = path.join(dataDir, "audit", "current.jsonl");
  const original = await readFile(current);
  const originalStat = await stat(current);
  await wal.appendLine(row(2));
  assert.deepEqual(await readFile(current), original);
  assert.equal((await stat(current)).ino, originalStat.ino);
  assert.deepEqual((await readdir(path.join(dataDir, "audit"))).sort(), ["archive", "current.jsonl", "outbox-v1"]);
  const stored = new Set();
  let appended = false;
  const send = async (request) => {
    assert.equal(request.login.keyId, auditLogin(legacyLogin()).keyId);
    for (const row of request.rows) stored.add(row.client_row_id);
    if (!appended) {
      appended = true;
      await Promise.all([
        old.appendLine({ ...row(3), executed_at: "2026-11-14T12:00:00.000Z" }),
        wal.appendLine(row(4))
      ]);
      const batch = await old.readBatch();
      for (const row of batch.rows) stored.add(row.client_row_id);
      await old.advanceOffset(batch.endOffset);
    }
    return accept(request);
  };
  await wal.drain(send);
  config = { ...legacyLogin("ak_test_different"), loggedInAt: "2026-11-14T13:00:00.000Z" };
  await reopen().drain(() => assert.fail("another login adopted a released row"));
  config = legacyLogin();
  await reopen().drain(send);
  await reopen().drain(() => assert.fail("a receipted legacy row was resent"));
  assert.equal(stored.size, 4);
  assert.deepEqual(await wal.readPending(), []);
  assert.equal((await old.readBatch()).rows.length, 0);
  await old.appendLine(row(5));
  assert.equal((await old.readBatch()).rows.length, 1);
});

// regression: #0010
test("R15: legacy pickup survives a crash after backend commit and keeps its login binding", async (t) => {
  let fail = true;
  let config = legacyLogin();
  const { wal, dataDir, reopen } = await setup(t, { login: () => auditLogin(config), beforeCommit(point) {
    if (point === "ack" && fail) { fail = false; throw new Error("injected legacy receipt failure"); }
  } });
  const old = await releasedWal(dataDir);
  await old.appendLine({ ...row(1), executed_at: "2026-11-14T12:00:00.000Z" });
  const original = await old.readBatch();
  const stored = new Set();
  const send = async (request) => { request.rows.forEach(({ client_row_id }) => stored.add(client_row_id)); return accept(request); };
  await assert.rejects(() => wal.drain(send), /injected legacy receipt failure/);
  config = { ...legacyLogin("ak_test_different"), backendEndpoint: "https://b.invalid", loggedInAt: "2026-11-14T13:00:00.000Z" };
  await reopen().drain(() => assert.fail("another backend adopted a released row"));
  config = legacyLogin();
  await reopen().drain(send);
  assert.equal(stored.size, 1);
  assert.deepEqual(await old.readBatch(), original);
  assert.deepEqual(await reopen().readPending(), []);
});

// regression: #0010
test("R15: a released row from another user cannot be adopted by an older active login", async (t) => {
  const { wal, dataDir } = await setup(t, { login: auditLogin(legacyLogin()) });
  const old = await releasedWal(dataDir);
  await old.appendLine({ ...row(), user_id: "user-b", executed_at: "2026-11-14T12:00:00.000Z" });
  let sent = 0;
  await wal.drain(async (request) => { sent++; return accept(request); });
  assert.equal(sent, 0);
  assert.equal((await wal.status()).undeliverable, 1);
});

// regression: #0010
test("appends keep the queue inode and retire settled state and dead letters from the hot store", async (t) => {
  const { wal, dataDir, reopen } = await setup(t);
  await wal.appendLine(row(1));
  const store = path.join(dataDir, "audit", "outbox-v1");
  const segment = (await readdir(store)).find((name) => name.startsWith("queue."));
  const file = path.join(store, segment, "rows.jsonl");
  const inode = (await stat(file)).ino;
  await wal.appendLine(row(2));
  assert.equal((await stat(file)).ino, inode);
  await wal.drain(async ({ rows }) => ({ status: 200, body: { results: rows.map(({ client_row_id }, i) => ({ client_row_id, outcome: i ? "rejected" : "accepted" })) } }));
  assert.equal((await readdir(store)).filter((name) => name.startsWith("queue.")).length, 0);
  await wal.appendLine(row(3));
  const active = (await readdir(store)).find((name) => name.startsWith("queue."));
  const state = JSON.parse(await readFile(path.join(store, active, "state.json"), "utf8"));
  assert.deepEqual([state.settled, state.delivery, state.dead], [[], {}, []]);
  assert.equal((await reopen().status()).deadLetters, 1);
  assert.equal((await reopen().readDeadLetters())[0].row.client_row_id, row(2).client_row_id);
  await wal.appendLine(row(1));
  await wal.appendLine(row(2));
  assert.deepEqual((await reopen().readPending()).map(({ row }) => row.client_row_id), [row(3).client_row_id]);
  assert.equal((await reopen().status()).deadLetters, 1);
});

// regression: #0012
test("an audit append does not rewrite segment state and run appends do not reparse prior rows", async (t) => {
  const clock = { now: () => Date.parse("2026-11-15T12:00:00Z"), random: () => 0 };
  const { dataDir, wal, reopen } = await setup(t, { clock });
  await wal.appendLine(row(1));
  const store = path.join(dataDir, "audit", "outbox-v1");
  const segment = (await readdir(store)).find((name) => name.startsWith("queue."));
  const stateFile = path.join(store, segment, "state.json");
  const before = await stat(stateFile);
  await wal.appendLine(row(2));
  assert.equal((await stat(stateFile)).ino, before.ino);
  await wal.drain(async () => { throw new Error("offline"); });
  await wal.reportHealth();
  const runs = createAuditWal({ dataDir, login, clock, stream: "runs" });
  const report = { run_id: "prompt-1", report_seq: 1, started_at: "2026-11-15T12:00:00Z", session_id: "root", tool_calls: 0, gated_tool_calls: 0, plan_ids: [] };
  await runs.appendLine(report);
  const original = fs.readFileSync;
  const reading = t.mock.method(fs, "readFileSync", (file, ...args) => {
    assert.ok(!String(file).endsWith("rows.jsonl"), "routine work reparsed a queue journal");
    return original(file, ...args);
  });
  syncBuiltinESMExports();
  try {
    await runs.appendLine(report);
    await runs.appendLine({ ...report, report_seq: 2 });
    await wal.reportHealth();
    await reopen().reportHealth();
  } finally {
    reading.mock.restore();
    syncBuiltinESMExports();
  }
  assert.deepEqual((await runs.readPending()).map(({ row }) => row.report_seq), [1, 2]);
  const health = createAuditWal({ dataDir, login, clock, stream: "health" });
  assert.deepEqual(await health.readPending(), []);
  await wal.appendLine(row(3));
  await reopen().reportHealth();
  assert.deepEqual((await health.readPending()).map(({ row }) => row.count), [1]);
});

// regression: #0012
test("concurrent health publishers retain staged events through unreported and archive", async (t) => {
  const { dataDir, wal } = await setup(t);
  await wal.appendLine(row());
  await wal.drain(async ({ rows }) => ({ status: 422, body: { results: rows.map(({ client_row_id }) => ({ client_row_id, outcome: "rejected" })) } }));
  const unreported = path.join(dataDir, "audit", "outbox-v1", "unreported");
  assert.equal((await readdir(unreported)).length, 1);
  await Promise.all([wal.reportHealth(), wal.reportHealth()]);
  assert.deepEqual(await readdir(unreported), []);
  const health = createAuditWal({ dataDir, login, stream: "health" });
  assert.equal((await health.readPending()).length, 1);
  assert.equal((await health.readPending())[0].row.count, 1);
  assert.equal((await wal.readDeadLetters()).length, 1);
});

// regression: #0012
test("released dead letters waiting for health are not imported again", async (t) => {
  const { wal, dataDir, reopen } = await setup(t, { login: auditLogin(legacyLogin()) });
  await mkdir(path.join(dataDir, "audit"));
  const original = JSON.stringify({ ...row(), executed_at: "2026-11-14T12:00:00Z" }) + "\n";
  await writeFile(path.join(dataDir, "audit", "current.jsonl"), original);
  await wal.drain(async ({ rows }) => ({ status: 422, body: { results: rows.map(({ client_row_id }) => ({ client_row_id, outcome: "rejected" })) } }));
  assert.deepEqual(await reopen().readPending(), []);
  await reopen().drain(accept);
  await reopen().reportHealth();
  assert.deepEqual(await readdir(path.join(dataDir, "audit", "outbox-v1", "unreported")), []);
  assert.equal((await wal.readDeadLetters()).length, 1);
  assert.equal(await readFile(path.join(dataDir, "audit", "current.jsonl"), "utf8"), original);
});

// regression: #0012
test("an audit storage failure does not stop run and health delivery", async (t) => {
  const { shipQueuedAudit } = await import("../plugins/armorcodex/scripts/lib/audit-delivery.mjs");
  const { dataDir } = await setup(t);
  const config = { ...legacyLogin(), dataDir, timeoutMs: 1000, runReportingEnabled: true };
  await writeFile(path.join(dataDir, "audit"), "unavailable");
  const runs = createAuditWal({ dataDir, config, stream: "runs" });
  await runs.appendLine({ run_id: "one", report_seq: 1, started_at: "2026-11-15T12:00:00Z" });
  const health = createAuditWal({ dataDir, config, stream: "health" });
  await health.appendLine({ event_id: row().client_row_id, type: "dead_letter", queue: "audit", count: 1, reason_code: "rejected", occurred_at: "2026-11-15T12:00:00Z" });
  t.mock.method(globalThis, "fetch", async (url, init) => {
    const body = JSON.parse(init.body);
    return new Response(JSON.stringify({ results: (body.reports ?? body.events ?? []).map((entry) => ({ ...entry, outcome: "accepted" })) }), { status: 200 });
  });
  await shipQueuedAudit(config);
  assert.deepEqual(await runs.readPending(), []);
  assert.deepEqual(await health.readPending(), []);
});

// regression: #0010
test("the production ship path probes a paused key and a successful authenticated call also resumes it", async (t) => {
  const { shipQueuedAudit } = await import("../plugins/armorcodex/scripts/lib/audit-delivery.mjs");
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
  const config = { ...legacyLogin(), timeoutMs: 1000 };
  const { wal, dataDir } = await setup(t, { login: () => auditLogin(config) });
  config.dataDir = dataDir;
  await wal.appendLine(row(1));
  const paths = [];
  let first = true;
  t.mock.method(globalThis, "fetch", async (url, init) => {
    paths.push(new URL(url).pathname);
    if (new URL(url).pathname === "/iap/client-events") {
      return new Response("{}", { status: 404 });
    }
    if (first) { first = false; return new Response("{}", { status: 401 }); }
    return new Response(JSON.stringify({ failures: [] }), { status: 200 });
  });
  await shipQueuedAudit(config);
  assert.equal((await wal.status()).undeliverable, 1);
  await shipQueuedAudit(config);
  assert.deepEqual(paths, ["/iap/audit/batch", "/iap/client-events"]);
  t.mock.timers.tick(120_000);
  await shipQueuedAudit(config);
  assert.deepEqual(paths, ["/iap/audit/batch", "/iap/client-events", "/iap/validate-key", "/iap/audit/batch", "/iap/client-events"]);
  assert.deepEqual(await wal.readPending(), []);
  await wal.appendLine(row(2));
  await wal.drain(async () => ({ status: 401, body: {} }));
  await createIapService({ ...config, csrgVerifyEnabled: true, verifyStepEndpoint: "https://b.invalid/iap/verify-step" })
    .verifyStep(JSON.stringify({ planId: row(2).client_row_id }), null, "Bash");
  assert.equal((await wal.status()).undeliverable, 1);
  await probeBackend(config);
  await shipQueuedAudit(config);
  assert.deepEqual(await wal.readPending(), []);
  await wal.appendLine(row(3));
  first = true;
  await shipQueuedAudit(config);
  await createIapService(config).createAuditLog({ ...row(4), status: "success" });
  await shipQueuedAudit(config);
  assert.deepEqual(await wal.readPending(), []);
  await wal.appendLine(row(5));
  first = true;
  await shipQueuedAudit(config);
  const { requestIntent } = await import("../plugins/armorcodex/scripts/lib/intent.mjs");
  await requestIntent({ ...config, mode: "enforce", intentEndpoint: config.backendEndpoint + "/iap/intent" }, { plan: { steps: [{ action: "Bash" }] } });
  await shipQueuedAudit(config);
  assert.deepEqual(await wal.readPending(), []);
});

for (const stream of ["health", "runs"]) {
  // regression: #0012
  test(`the production ${stream} stream lifts a 401 pause with an authenticated probe`, async (t) => {
    const { shipQueuedAudit } = await import("../plugins/armorcodex/scripts/lib/audit-delivery.mjs");
    t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
    const config = { ...legacyLogin(), timeoutMs: 1000, runReportingEnabled: stream === "runs" };
    const { dataDir } = await setup(t);
    config.dataDir = dataDir;
    const wal = () => createAuditWal({ dataDir, config, stream });
    const sample = stream === "runs" ? {
      run_id: "prompt-1", report_seq: 1, session_id: "root", started_at: new Date().toISOString(),
      tool_calls: 0, gated_tool_calls: 0, plan_ids: []
    } : { event_id: row().client_row_id, type: "dead_letter", queue: "audit", count: 1, reason_code: "rejected", occurred_at: new Date().toISOString() };
    await wal().appendLine(sample);
    const endpoint = stream === "runs" ? "/iap/runs/batch" : "/iap/client-events";
    const sent = [];
    let refuse = true;
    t.mock.method(globalThis, "fetch", async (url, init) => {
      const pathname = new URL(url).pathname;
      sent.push(pathname);
      if (stream === "runs" && pathname === "/iap/client-events") return new Response("{}", { status: 404 });
      if (pathname === endpoint && refuse) { refuse = false; return new Response("{}", { status: 401 }); }
      const body = JSON.parse(init.body);
      return new Response(JSON.stringify({ results: (body.events ?? body.reports ?? []).map((entry) => ({ ...entry, outcome: "accepted" })) }), { status: 200 });
    });
    await shipQueuedAudit(config);
    assert.equal((await wal().status()).paused, true);
    assert.equal((await wal().status()).undeliverable, 1);
    await shipQueuedAudit(config);
    assert.deepEqual(sent, stream === "runs" ? [endpoint, "/iap/client-events"] : [endpoint]);
    t.mock.timers.tick(120_000);
    await shipQueuedAudit(config);
    assert.deepEqual(sent, stream === "runs" ? [endpoint, "/iap/client-events", "/iap/validate-key", endpoint, "/iap/client-events"] : [endpoint, "/iap/validate-key", endpoint]);
    assert.deepEqual(await wal().readPending(), []);
    await wal().appendLine({ ...sample, ...(stream === "runs" ? { report_seq: 2 } : { event_id: row(2).client_row_id }) });
    await wal().drain(async () => ({ status: 401, body: {} }));
    await probeBackend(config);
    assert.equal((await wal().status()).undeliverable, 0);
    await wal().drain(async () => ({ status: 401, body: {} }));
    await createIapService(config)[stream === "runs" ? "shipRunBatch" : "shipHealthBatch"]([sample]);
    assert.equal((await wal().status()).undeliverable, 0);
  });
}

// regression: #0013
test("reporting off leaves existing run reports and their health events untouched", async (t) => {
  const { shipQueuedAudit } = await import("../plugins/armorcodex/scripts/lib/audit-delivery.mjs");
  const { dataDir } = await setup(t);
  const config = { ...legacyLogin(), dataDir, timeoutMs: 1000, runReportingEnabled: false };
  const runs = createAuditWal({ dataDir, config, stream: "runs" });
  const health = createAuditWal({ dataDir, config, stream: "health" });
  await runs.appendLine({ run_id: "prompt-1", report_seq: 1, session_id: "root", started_at: new Date().toISOString(), tool_calls: 0, gated_tool_calls: 0, plan_ids: [] });
  await health.appendLine({ event_id: row().client_row_id, type: "queue_stalled", queue: "runs", count: 1, reason_code: "server_error", occurred_at: new Date().toISOString() });
  const sent = [];
  t.mock.method(globalThis, "fetch", async (url, init) => {
    const body = JSON.parse(init.body);
    sent.push(new URL(url).pathname);
    return new Response(JSON.stringify({ results: (body.reports ?? body.events).map((row) => ({ ...row, outcome: "accepted" })) }), { status: 200 });
  });
  await shipQueuedAudit(config);
  assert.deepEqual(sent, []);
  assert.equal((await runs.readPending()).length, 1);
  assert.equal((await health.readPending()).length, 1);
  config.runReportingEnabled = true;
  await shipQueuedAudit(config);
  assert.deepEqual(sent, ["/iap/runs/batch", "/iap/client-events"]);
  assert.deepEqual(await runs.readPending(), []);
  assert.deepEqual(await health.readPending(), []);
});

// regression: #0010
test("a backlog renews its lease before every batch", async (t) => {
  let now = 1000;
  const { wal } = await setup(t, { clock: { now: () => now, random: () => 0.5 }, timing: { lockTtlMs: 100 }, sizeLimits: { maxRowBytes: 1024, maxBatchBytes: 4096, maxBatchRows: 1, truncationMarker: { truncated: true } } });
  for (let i = 1; i <= 3; i++) await wal.appendLine(row(i));
  const sent = [];
  await wal.drain(async (request) => { now += 75; sent.push(...request.rows.map(({ client_row_id }) => client_row_id)); return accept(request); });
  assert.equal(sent.length, 3);
  assert.deepEqual(await wal.readPending(), []);
});

// regression: #0010
test("a torn append preserves prior rows and starts the next append in a separate segment", async (t) => {
  const { wal, dataDir, reopen } = await setup(t);
  await wal.appendLine(row(1));
  const store = path.join(dataDir, "audit", "outbox-v1");
  const name = (await readdir(store)).find((name) => name.startsWith("queue."));
  const partial = path.join(store, name, "rows.jsonl");
  await appendFile(partial, '{"input":"unfinished');
  await reopen().appendLine(row(2));
  assert.deepEqual((await wal.readPending()).map(({ row }) => row.client_row_id).sort(), [row(1).client_row_id, row(2).client_row_id]);
  await wal.drain(accept);
  assert.deepEqual(await reopen().readPending(), []);
  assert.ok((await readFile(path.join(store, "archive", name, "rows.jsonl"), "utf8")).endsWith('{"input":"unfinished'));
});

// regression: #0010
test("a failed tenth refusal commit retries the dead letter without an eleventh send", async (t) => {
  let now = 1000;
  let fail = true;
  const { wal, reopen } = await setup(t, {
    clock: { now: () => now, random: () => 0.5 },
    beforeCommit(point) { if (point === "deadLetter" && fail) { fail = false; throw new Error("injected tenth refusal failure"); } }
  });
  await wal.appendLine(row());
  const refuse = async () => ({ status: 413, body: {} });
  for (let i = 1; i <= 9; i++) {
    await wal.drain(refuse);
    now = (await wal.readPending())[0].nextAttemptAt;
  }
  await assert.rejects(() => wal.drain(refuse), /injected tenth refusal failure/);
  assert.equal((await reopen().readPending())[0].attempts, 10);
  let sent = 0;
  await reopen().drain(async () => { sent++; return refuse(); });
  assert.equal(sent, 0);
  assert.equal((await reopen().readDeadLetters())[0].attempts, 10);
  assert.deepEqual(await reopen().readPending(), []);
});

test("real processes exclude a second drainer, preserve concurrent appends and recover a killed owner", async (t) => {
  const { wal, dataDir } = await setup(t, { clock: { now: () => 1000, random: () => 0.5 } });
  await wal.appendLine(row());
  const children = [];
  t.after(() => { for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); });
  const start = (operation, now = 1000) => {
    const child = fork(new URL("./helpers/outbox-process.mjs", import.meta.url), [dataDir, operation, String(now)], { stdio: ["ignore", "ignore", "inherit", "ipc"] });
    children.push(child);
    return child;
  };
  const first = start("drain");
  const firstExit = once(first, "exit");
  assert.equal((await once(first, "message"))[0].type, "sending");
  const second = start("drain");
  let secondSends = 0;
  second.on("message", () => secondSends++);
  assert.equal((await once(second, "exit"))[0], 0);
  assert.equal(secondSends, 0);
  await Promise.all(Array.from({ length: 3 }, async () => {
    assert.equal((await once(start("append"), "exit"))[0], 0);
  }));
  first.kill("SIGKILL");
  await firstExit;
  assert.equal((await wal.readPending()).length, 4);
  const recovered = start("drain", 31_001);
  const recoveredExit = once(recovered, "exit");
  assert.equal((await once(recovered, "message"))[0].count, 4);
  recovered.send("finish");
  assert.equal((await recoveredExit)[0], 0);
  assert.deepEqual(await wal.readPending(), []);
});

test("batch transport preserves HTTP row outcomes and Retry-After for outbox settlement", async (t) => {
  const config = { backendEndpoint: "https://a.invalid", apiKey: "ak_test_transport", timeoutMs: 1000 };
  t.mock.method(globalThis, "fetch", async (url, init) => {
    assert.equal(url, `${config.backendEndpoint}/iap/audit/batch`);
    assert.equal(init.headers.Authorization, `Bearer ${config.apiKey}`);
    assert.deepEqual(JSON.parse(init.body), { rows: [row()] });
    return new Response(JSON.stringify({ results: [{ client_row_id: row().client_row_id, outcome: "retryable" }] }), { status: 422, headers: { "Retry-After": "120" } });
  });
  const reply = await createIapService(config).shipAuditBatch([row()]);
  assert.equal(reply.status, 422);
  assert.equal(reply.headers["retry-after"], "120");
  assert.equal(reply.body.results[0].outcome, "retryable");
});

test("health transport sends event ids and preserves per event outcomes", async (t) => {
  const config = { backendEndpoint: "https://a.invalid", apiKey: "ak_test_transport", timeoutMs: 1000 };
  const event = { event_id: row().client_row_id, type: "dead_letter", queue: "audit", count: 2, reason_code: "rejected", occurred_at: "2026-11-15T12:00:00Z" };
  t.mock.method(globalThis, "fetch", async (url, init) => {
    assert.equal(url, `${config.backendEndpoint}/iap/client-events`);
    assert.equal(init.headers.Authorization, `Bearer ${config.apiKey}`);
    assert.deepEqual(JSON.parse(init.body), { events: [event] });
    return new Response(JSON.stringify({ results: [{ event_id: event.event_id, outcome: "duplicate" }] }), { status: 200 });
  });
  const reply = await createIapService(config).shipHealthBatch([event]);
  assert.equal(reply.body.results[0].outcome, "duplicate");
});

// regression: #0012
test("local status shows undeliverable rows, dead letters and capture failures", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
  const { wal, dataDir } = await setup(t, { sizeLimits: { maxRowBytes: 1024, maxBatchBytes: 4096, maxBatchRows: 10, truncationMarker: { truncated: true } } });
  await wal.appendLine(row(1));
  await wal.appendLine({ ...row(2), error_message: "x".repeat(2048) });
  await wal.appendLine({ ...row(2), error_message: "x".repeat(2048) });
  await wal.recordCaptureFailure(row(3));
  await wal.reportHealth();
  await createAuditWal({ dataDir, login, stream: "health" }).drain(async () => ({ status: 404, body: {} }));
  const config = { dataDir, runtimeFile: path.join(dataDir, "runtime.json"), apiKey: "", backendEndpoint: "https://b.invalid" };
  const reply = await handleUserPromptSubmit({ session_id: "status", prompt: "/armor status" }, config);
  assert.match(JSON.stringify(reply), /Undeliverable audit rows: 1/);
  assert.match(JSON.stringify(reply), /Dead letter audit rows: 1/);
  assert.match(JSON.stringify(reply), /Audit capture failures: 1/);
  assert.match(JSON.stringify(reply), /Health events waiting to upload: 1/);
  assert.match(JSON.stringify(reply), /Health reporting paused: yes/);
  const health = createAuditWal({ dataDir, login, stream: "health" });
  const runs = createAuditWal({ dataDir, login, stream: "runs" });
  t.mock.timers.tick(30_000);
  await health.drain(async ({ rows }) => ({ status: 422, body: { results: rows.map(({ event_id }) => ({ event_id, outcome: "rejected" })) } }));
  await runs.appendLine({ run_id: "rejected-run", report_seq: 1 });
  await runs.drain(async ({ rows }) => ({ status: 422, body: { results: rows.map((entry) => ({ ...entry, outcome: "rejected" })) } }));
  const status = await handleUserPromptSubmit({ session_id: "status", prompt: "/armor status" }, { ...config, runReportingEnabled: true });
  assert.match(status.reason, /Dead letter health events: 1/);
  assert.match(status.reason, /Dead letter run reports: 1/);
});

test("a hook reports a capture storage failure instead of returning success", async (t) => {
  const { dataDir } = await setup(t);
  const config = {
    dataDir, runtimeFile: path.join(dataDir, "runtime.json"), auditEnabled: true,
    apiKey: "ak_test_hook", backendEndpoint: "https://a.invalid", sanitize: { maxChars: 2000, maxDepth: 4, maxKeys: 50, maxItems: 50 }
  };
  await writeFile(path.join(dataDir, "audit"), "not a directory");
  await assert.rejects(() => handlePostToolUse({ session_id: "s", tool_name: "Bash", tool_input: {}, tool_response: {} }, config), /EEXIST|ENOTDIR/);
});

for (const point of ["ack", "deadLetter"]) {
  test(`a mixed settlement storage failure at ${point} retains the entire batch`, async (t) => {
    let failure;
    const { wal, reopen } = await setup(t, { beforeCommit(at) {
      if (failure === at) { failure = null; throw new Error("injected mixed settlement failure"); }
    } });
    await wal.appendLine(row(1));
    await wal.appendLine(row(2));
    failure = point;
    const settle = async () => ({ status: 200, body: { results: [
      { client_row_id: row(1).client_row_id, outcome: "duplicate" },
      { client_row_id: row(2).client_row_id, outcome: "rejected", error: "invalid" }
    ] } });
    await assert.rejects(() => wal.drain(settle), /injected/);
    assert.equal((await reopen().readPending()).length, 2);
    assert.deepEqual(await reopen().readDeadLetters(), []);
    await reopen().drain(settle);
    assert.deepEqual(await wal.readPending(), []);
    assert.equal((await wal.readDeadLetters()).length, 1);
  });
}

test("a normal restart keeps an authentication pause until the same credential is explicitly restored", async (t) => {
  let config = { backendEndpoint: login.backend, apiKey: "ak_test_restore", loggedInAt: "2026-11-14T12:00:00.000Z" };
  const { wal, reopen } = await setup(t, { login: () => auditLogin(config) });
  await wal.appendLine(row());
  await wal.drain(async () => ({ status: 401, body: {} }));
  await reopen().drain(() => assert.fail("restart resumed a paused login"));
  config = { ...config, apiKey: "ak_test_other", loggedInAt: "2026-11-14T12:01:00.000Z" };
  await reopen().drain(() => assert.fail("another login adopted the queue"));
  config = { ...config, apiKey: "ak_test_restore" };
  await reopen().drain(accept);
  assert.deepEqual(await wal.readPending(), []);
});

for (const point of ["ack", "deadLetter"]) {
  test(`lease expiry during ${point} commit fences the owner`, async (t) => {
    let now = 1000;
    const { wal } = await setup(t, {
      clock: { now: () => now, random: () => 0.5 },
      timing: { lockTtlMs: 100 },
      beforeCommit(at) { if (at === point) now += 101; }
    });
    await wal.appendLine(row());
    await wal.drain(async () => ({ status: 200, body: { results: [{
      client_row_id: row().client_row_id, outcome: point === "ack" ? "accepted" : "rejected"
    }] } }));
    assert.equal((await wal.readPending()).length, 1);
    assert.deepEqual(await wal.readDeadLetters(), []);
  });
}
