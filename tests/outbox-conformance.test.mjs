import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createAuditWal } from "../plugins/armorcodex/scripts/lib/audit-wal.mjs";
import { requestWithRetry } from "../plugins/armorcodex/scripts/lib/plan-request.mjs";
import { defineOutboxConformance } from "./helpers/outbox-conformance.mjs";

const stores = [];
after(async () => {
  await Promise.all(stores.map((dir) => rm(dir, { recursive: true, force: true })));
});

async function makeAdapter({ login, clock, sizeLimits, timing }) {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "armorcodex-outbox-"));
  stores.push(dataDir);
  const context = { login, fault: null };
  const reopen = () => {
    const wal = createAuditWal({
      dataDir, clock, sizeLimits, timing,
      login: () => context.login,
      beforeCommit(point) {
        if (context.fault !== point) return;
        context.fault = null;
        throw new Error(`injected ${point} storage failure`);
      }
    });
    return {
      append: (row, options) => options?.loggedOut ? Promise.resolve() : wal.appendLine(row, options),
      drain: (send, options) => wal.drain(send, options),
      readPending: () => wal.readPending(),
      readDeadLetters: () => wal.readDeadLetters(),
      status: () => wal.status(),
      async switchLogin(next) {
        context.login = next;
        await wal.authenticationSucceeded(next);
      },
      authenticationSucceeded: (login) => wal.authenticationSucceeded(login),
      async failNext(point) { context.fault = point; },
      async restart() { return reopen(); },
      async secondDrainer() { return reopen(); }
    };
  };
  return reopen();
}

defineOutboxConformance({ describe, it, makeAdapter });

const runReport = (run_id = "prompt-1", report_seq = 1) => ({
  run_id, report_seq, session_id: "root", started_at: "2026-11-15T12:00:00.000Z",
  tool_calls: 0, gated_tool_calls: 0, plan_ids: []
});
const runReply = (rows, outcome = "accepted") => ({ status: 200, body: {
  results: rows.map(({ run_id, report_seq }) => ({ run_id, report_seq, outcome }))
} });

describe("runs stream conformance", () => {
  async function setup(options = {}) {
    const h = await healthStore();
    Object.assign(h.options, options);
    return { ...h, runs: () => createAuditWal({ ...h.options, stream: "runs" }) };
  }

  it("keeps run sequences distinct and replays each identity once across restarts", async () => {
    const h = await setup();
    for (const seq of [1, 2, 1]) await h.runs().appendLine(runReport("prompt-1", seq));
    assert.deepEqual((await h.runs().readPending()).map(({ row }) => row), [runReport(), runReport("prompt-1", 2)]);
    await h.runs().drain(async ({ rows }) => ({ status: 200, body: { results: [
      { run_id: rows[0].run_id, report_seq: 1, outcome: "stale" },
      { run_id: rows[1].run_id, report_seq: 2, outcome: "duplicate" }
    ] } }));
    await h.runs().appendLine(runReport());
    assert.deepEqual(await h.runs().readPending(), []);
  });

  it("retains missing and malformed outcomes and dead letters only rejected reports", async () => {
    const h = await setup();
    for (let seq = 1; seq <= 3; seq++) await h.runs().appendLine(runReport("prompt-1", seq));
    await h.runs().drain(async () => ({ status: 200, body: { results: [
      { run_id: "prompt-1", report_seq: 1, outcome: "accepted" },
      { run_id: "prompt-1", report_seq: 2, outcome: "rejected", error: "invalid_report" }
    ] } }));
    assert.deepEqual((await h.runs().readPending()).map(({ row }) => row.report_seq), [3]);
    assert.deepEqual((await h.runs().readDeadLetters()).map(({ row }) => row.report_seq), [2]);
    h.advance(300_001);
    await h.runs().drain(async () => ({ status: 200, body: { results: [{ run_id: "prompt-1", report_seq: 99, outcome: "accepted" }] } }));
    assert.equal((await h.runs().readPending()).length, 1);
    h.advance(300_001);
    await h.runs().drain(async ({ rows }) => runReply(rows));
    assert.deepEqual(await h.runs().readPending(), []);
  });

  it("pauses a 404 across restart, preserves attempts and stops remaining batches", async () => {
    const h = await setup({ sizeLimits: { maxRowBytes: 1024, maxBatchRows: 1, maxBatchBytes: 4096, truncationMarker: { truncated: true } } });
    for (const seq of [1, 2]) await h.runs().appendLine(runReport("prompt-1", seq));
    let sends = 0;
    await h.runs().drain(async () => { sends++; return { status: 404, body: {} }; });
    await h.runs().drain(async () => { sends++; return runReply([]); });
    assert.equal(sends, 1);
    assert.equal((await h.runs().status()).paused, true);
    assert.deepEqual((await h.runs().readPending()).map(({ attempts }) => attempts), [0, 0]);
    h.advance(30_000);
    await h.runs().drain(async ({ rows }) => runReply(rows));
    assert.deepEqual(await h.runs().readPending(), []);
  });

  it("pauses on logout, excludes another login and sends at most 200 reports per batch", async () => {
    const h = await setup();
    const originalLogin = h.options.login;
    for (let n = 0; n < 201; n++) await h.runs().appendLine(runReport(`prompt-${n}`));
    let sends = 0;
    h.options.login = null;
    await h.runs().drain(async () => { sends++; return runReply([]); });
    h.options.login = { backend: "https://a.invalid", keyId: "key-b" };
    await h.runs().drain(async () => { sends++; return runReply([]); });
    assert.equal(sends, 0);
    assert.equal((await h.runs().status()).undeliverable, 201);
    h.options.login = originalLogin;
    const batches = [];
    await h.runs().drain(async ({ rows, login }) => {
      assert.deepEqual(login, originalLogin);
      batches.push(rows.length);
      return runReply(rows);
    });
    assert.deepEqual(batches, [200, 1]);
  });

  it("retains an uncommitted acknowledgement and excludes a concurrent drainer", async () => {
    let failAck = false;
    const h = await setup({ beforeCommit: (point) => { if (failAck && point === "ack") throw new Error("injected ack failure"); } });
    await h.runs().appendLine(runReport());
    let release;
    let entered;
    const held = new Promise((resolve) => { release = resolve; });
    const sending = new Promise((resolve) => { entered = resolve; });
    const flight = h.runs().drain(async ({ rows }) => { entered(); await held; return runReply(rows); });
    try {
      await sending;
      let otherSends = 0;
      await h.runs().drain(async ({ rows }) => { otherSends++; return runReply(rows); });
      assert.equal(otherSends, 0);
      failAck = true;
    } finally { release(); }
    await assert.rejects(flight, /injected ack failure/);
    failAck = false;
    assert.equal((await h.runs().readPending()).length, 1);
    await h.runs().drain(async ({ rows }) => runReply(rows, "duplicate"));
    assert.deepEqual(await h.runs().readPending(), []);
  });
});

async function healthStore() {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "armorcodex-health-"));
  stores.push(dataDir);
  let now = Date.parse("2026-11-15T12:00:00Z");
  const login = { backend: "https://a.invalid", keyId: "key-a" };
  const options = { dataDir, login, clock: { now: () => now, random: () => 0 } };
  return {
    options,
    audit: () => createAuditWal(options),
    health: () => createAuditWal({ ...options, stream: "health" }),
    advance: (ms) => { now += ms; },
    now: () => now
  };
}

const auditRow = (n) => ({ client_row_id: `11111111-1111-4111-8111-${String(n).padStart(12, "0")}`, tool: "Bash", input: {} });
const healthReply = (rows, outcome = "accepted") => ({ status: 200, body: { results: rows.map(({ event_id }) => ({ event_id, outcome })) } });

describe("health stream conformance", () => {
  for (const reason of ["rejected", "attempts_exhausted", "oversize"]) {
    it(`delivers one durable dead letter count after an outage: ${reason}`, async () => {
      const h = await healthStore();
      for (let n = 1; n <= 2; n++) await h.audit().appendLine({ ...auditRow(n), ...(reason === "oversize" ? { tool: "x".repeat(300_000) } : {}) });
      if (reason !== "oversize") {
        const attempts = reason === "attempts_exhausted" ? 10 : 1;
        for (let n = 0; n < attempts; n++) {
          await h.audit().drain(async ({ rows }) => reason === "rejected"
            ? { status: 200, body: { results: rows.map(({ client_row_id }) => ({ client_row_id, outcome: "rejected", error: "invalid" })) } }
            : { status: 410, body: {} });
          h.advance(300_001);
        }
      }
      await h.audit().reportHealth();
      const events = (await h.health().readPending()).map(({ row }) => row).filter(({ type }) => type === "dead_letter");
      assert.equal(events.reduce((count, event) => count + event.count, 0), 2);
      assert.ok(events.every((event) => event.queue === "audit" && event.reason_code === reason));
      await h.health().drain(async () => { throw new Error("offline"); });
      h.advance(300_001);
      await h.audit().reportHealth();
      const sent = [];
      await h.health().drain(async ({ rows }) => { sent.push(...rows); return healthReply(rows, "duplicate"); });
      assert.deepEqual(sent.filter(({ type }) => type === "dead_letter"), events);
      assert.equal((await h.health().readPending()).length, 0);
      await h.audit().reportHealth();
      assert.equal((await h.health().readPending()).filter(({ row }) => row.type === "dead_letter").length, 0);
    });
  }

  it("persists the hourly stall bookmark and first enqueue time across a restart", async () => {
    const h = await healthStore();
    await h.audit().appendLine(auditRow(1));
    await h.audit().appendLine(auditRow(2));
    await h.audit().drain(async () => { throw new Error("offline"); });
    h.advance(5000);
    await h.audit().reportHealth();
    let events = (await h.health().readPending()).map(({ row }) => row);
    assert.equal(events.length, 1);
    assert.deepEqual([events[0].type, events[0].count, events[0].oldest_pending_seconds, events[0].reason_code], ["queue_stalled", 2, 5, "backend_unreachable"]);
    h.advance(3_599_999);
    await h.audit().reportHealth();
    assert.equal((await h.health().readPending()).length, 1);
    h.advance(1);
    await h.audit().reportHealth();
    events = (await h.health().readPending()).map(({ row }) => row);
    assert.equal(events.length, 2);
    assert.equal(events[1].oldest_pending_seconds, 3605);
  });

  it("keeps a 404 pause across restarts, then probes and delivers the original event", async () => {
    const h = await healthStore();
    await h.audit().appendLine({ ...auditRow(1), tool: "x".repeat(300_000) });
    await h.audit().reportHealth();
    const original = (await h.health().readPending())[0].row;
    await h.health().drain(async () => ({ status: 404, body: {} }));
    assert.equal((await h.health().status()).paused, true);
    for (const entry of await h.health().readPending()) assert.equal(entry.attempts, 0);
    let sends = 0;
    await h.health().drain(async ({ rows }) => { sends++; return healthReply(rows); });
    assert.equal(sends, 0);
    h.advance(30_000);
    await h.health().drain(async () => { throw new Error("probe offline"); });
    assert.equal((await h.health().status()).paused, true);
    assert.equal((await h.health().readPending())[0].attempts, 0);
    h.advance(30_000);
    await h.health().drain(async () => ({ status: 503, body: {} }));
    assert.equal((await h.health().status()).paused, false);
    const [afterTransient] = await h.health().readPending();
    assert.deepEqual([afterTransient.attempts, afterTransient.retries], [0, 1]);
    h.advance(300_001);
    const sent = [];
    await h.health().drain(async ({ rows }) => { sent.push(...rows); return healthReply(rows, "duplicate"); });
    assert.deepEqual(sent, [original]);
    assert.equal((await h.health().status()).paused, false);
    assert.deepEqual(await h.health().readPending(), []);
  });

  it("stops the remaining health batches after a 404 without spending their attempts", async () => {
    const h = await healthStore();
    h.options.sizeLimits = { maxRowBytes: 1024, maxBatchBytes: 4096, maxBatchRows: 1, truncationMarker: { truncated: true } };
    for (let n = 1; n <= 2; n++) await h.audit().appendLine({ ...auditRow(n), tool: "x".repeat(2048) });
    await h.audit().reportHealth();
    let sends = 0;
    await h.health().drain(async () => { sends++; return { status: 404, body: {} }; });
    assert.equal(sends, 1);
    assert.deepEqual((await h.health().readPending()).map(({ attempts }) => attempts), [0, 0]);
  });

  it("keeps health events bound to the source login and excludes another drainer", async () => {
    const h = await healthStore();
    await h.audit().appendLine({ ...auditRow(1), tool: "x".repeat(300_000) });
    const original = h.options.login;
    h.options.login = { backend: "https://b.invalid", keyId: "key-b" };
    await h.audit().reportHealth();
    let sends = 0;
    const send = async ({ rows }) => { sends++; return healthReply(rows); };
    await h.health().drain(send);
    assert.equal(sends, 0);
    assert.equal((await h.health().status()).undeliverable, 1);
    h.options.login = original;
    let release;
    let entered;
    const held = new Promise((resolve) => { release = resolve; });
    const sending = new Promise((resolve) => { entered = resolve; });
    const first = h.health().drain(async (request) => { entered(); await held; return send(request); });
    try {
      await sending;
      await h.health().drain(send);
      assert.equal(sends, 0);
    } finally { release(); }
    await first;
    assert.equal(sends, 1);
    assert.deepEqual(await h.health().readPending(), []);
  });

  it("keeps the source receipt when health capture fails and replays it once", async () => {
    const h = await healthStore();
    await h.audit().appendLine({ ...auditRow(1), tool: "x".repeat(300_000) });
    let fail = true;
    h.options.beforeCommit = (point) => {
      if (fail && point === "append") { fail = false; throw new Error("health append failed"); }
    };
    await assert.rejects(() => h.audit().reportHealth(), /health append failed/);
    await h.audit().reportHealth();
    const pending = await h.health().readPending();
    assert.equal(pending.length, 1);
    assert.equal(pending[0].row.count, 1);
    await h.audit().reportHealth();
    assert.deepEqual((await h.health().readPending()).map(({ row }) => row), pending.map(({ row }) => row));
  });

  it("counts rejected health events locally without generating health about itself", async () => {
    const h = await healthStore();
    await h.audit().appendLine({ ...auditRow(1), tool: "x".repeat(300_000) });
    await h.audit().reportHealth();
    await h.health().drain(async ({ rows }) => healthReply(rows, "rejected"));
    await h.health().reportHealth();
    await h.audit().reportHealth();
    assert.equal((await h.health().status()).deadLetters, 1);
    assert.deepEqual(await h.health().readPending(), []);
  });

  for (const reason of ["timeout", "network", "rate_limited", "server_error", "request_in_progress", "rejected"]) {
    it(`reports one exhausted logical request, preserving deduplication across restart: ${reason}`, async () => {
      const h = await healthStore();
      const config = { dataDir: h.options.dataDir, backendEndpoint: h.options.login.backend, apiKey: "ak_test_health" };
      let attempts = 0;
      const send = async () => {
        attempts++;
        throw Object.assign(new Error("failed"), { retryable: reason !== "rejected", reasonCode: reason });
      };
      const request = () => requestWithRetry(send, {
        config, requestKey: `request-${reason}`, now: h.now, wait: async (ms) => h.advance(ms)
      });
      await assert.rejects(request);
      assert.ok(reason === "rejected" ? attempts === 1 : attempts > 1);
      let pending = await createAuditWal({ dataDir: config.dataDir, config, stream: "health" }).readPending();
      assert.equal(pending.length, 1);
      assert.deepEqual([pending[0].row.type, pending[0].row.count, pending[0].row.reason_code], ["plan_request_failed", 1, reason]);
      const event = pending[0].row;
      await assert.rejects(request);
      pending = await createAuditWal({ dataDir: config.dataDir, config, stream: "health" }).readPending();
      assert.deepEqual(pending.map(({ row }) => row), [event]);
      await createAuditWal({ dataDir: config.dataDir, config, stream: "health" }).drain(async ({ rows }) => healthReply(rows));
      await assert.rejects(request);
      assert.deepEqual(await createAuditWal({ dataDir: config.dataDir, config, stream: "health" }).readPending(), []);
    });
  }
});

for (const stream of ["health", "runs"]) {
  const sample = stream === "runs" ? runReport() : {
    event_id: "11111111-1111-4111-8111-111111111111", type: "dead_letter", queue: "audit",
    count: 1, reason_code: "rejected", occurred_at: "2026-11-15T12:00:00.000Z"
  };
  const reply = stream === "runs" ? runReply : healthReply;
  for (const failure of ["network", "timeout", 503, 429]) {
    // regression: #0012
    it(`${stream}: ten ${failure} failures leave the original row pending without charged attempts`, async () => {
      const h = await healthStore();
      const wal = () => createAuditWal({ ...h.options, stream });
      await wal().appendLine(sample);
      for (let attempt = 0; attempt < 10; attempt++) {
        await wal().drain(async () => {
          if (typeof failure === "string") throw new Error(failure);
          return { status: failure, body: reply([sample], "rejected").body };
        });
        h.advance(300_001);
      }
      const [pending] = await wal().readPending();
      assert.ok(pending, "a transient reply must leave the row pending");
      assert.deepEqual([pending.row, pending.attempts, pending.retries], [sample, 0, 10]);
      assert.deepEqual(await wal().readDeadLetters(), []);
      await wal().drain(async ({ rows }) => reply(rows));
      assert.deepEqual(await wal().readPending(), []);
    });
  }

  for (const status of [400, 422]) {
    // regression: #0012
    it(`${stream}: usable row outcomes settle directly on HTTP ${status}`, async () => {
      const h = await healthStore();
      const wal = createAuditWal({ ...h.options, stream });
      await wal.appendLine(sample);
      let sends = 0;
      await wal.drain(async ({ rows }) => { sends++; return { ...reply(rows, "duplicate"), status }; });
      assert.equal(sends, 1);
      assert.deepEqual(await wal.readPending(), []);
      assert.deepEqual(await wal.readDeadLetters(), []);
    });
  }

  // regression: #0012
  it(`${stream}: org_required holds locally without an authentication pause or an attempt`, async () => {
    const h = await healthStore();
    const wal = () => createAuditWal({ ...h.options, stream });
    await wal().appendLine(sample);
    await wal().drain(async () => ({ status: 403, body: { error: "org_required" } }));
    assert.equal((await wal().status()).hold, "org_required");
    assert.equal((await wal().status()).paused, false);
    assert.equal((await wal().readPending())[0].attempts, 0);
    let sent = 0;
    await wal().drain(async ({ rows }) => { sent++; return reply(rows); });
    assert.equal(sent, 0);
    h.advance(120_000);
    await wal().drain(async () => { sent++; return { status: 403, body: { error: "org_required" } }; });
    assert.equal(sent, 1);
    h.advance(120_000);
    await wal().drain(async ({ rows }) => { sent++; return reply(rows); });
    assert.equal(sent, 1);
    h.options.login = { ...h.options.login, credentialVersion: "restored" };
    await wal().drain(async ({ rows }) => { sent++; return reply(rows); });
    assert.deepEqual(await wal().readPending(), []);
    assert.equal((await wal().status()).hold, null);
  });
}

// regression: #0012
it("each stalled queue reports its whole depth once an hour, including another login", async () => {
  const h = await healthStore();
  h.options.sizeLimits = { maxRowBytes: 1024, maxBatchBytes: 4096, maxBatchRows: 1, truncationMarker: { truncated: true } };
  await h.audit().appendLine({ ...auditRow(1), input: { text: "x".repeat(800) } });
  await h.audit().appendLine({ ...auditRow(3), input: { text: "x".repeat(800) } });
  await h.audit().appendLine(auditRow(4));
  await h.audit().drain(async () => { throw new Error("offline"); });
  h.options.login = { ...h.options.login, keyId: "key-b" };
  await h.audit().appendLine(auditRow(2));
  await h.audit().drain(async () => { throw new Error("offline"); });
  await h.audit().reportHealth();
  const events = (await h.health().readPending()).map(({ row }) => row);
  assert.equal(events.length, 2);
  assert.deepEqual(events.map(({ count }) => count).sort(), [1, 3]);
  await h.audit().reportHealth();
  assert.equal((await h.health().readPending()).length, 2);
  h.advance(3_600_000);
  await h.audit().reportHealth();
  assert.equal((await h.health().readPending()).length, 4);
});

// regression: #0012
it("run retries keep the final report enqueue time for stall age", async () => {
  const h = await healthStore();
  const runs = createAuditWal({ ...h.options, stream: "runs" });
  await runs.appendLine({ ...runReport(), started_at: "2026-11-14T12:00:00Z", report_seq: 2 });
  await runs.drain(async () => ({ status: 503, body: {} }));
  h.advance(30_000);
  await runs.reportHealth();
  assert.equal((await h.health().readPending())[0].row.oldest_pending_seconds, 30);
});

// regression: #0012
it("answered retryable rows report server_error rather than an unreachable backend", async () => {
  const h = await healthStore();
  await h.audit().appendLine(auditRow(1));
  await h.audit().drain(async () => ({ status: 200, body: { results: [{ client_row_id: auditRow(1).client_row_id, outcome: "retryable" }] } }));
  await h.audit().reportHealth();
  assert.equal((await h.health().readPending())[0].row.reason_code, "server_error");
});
