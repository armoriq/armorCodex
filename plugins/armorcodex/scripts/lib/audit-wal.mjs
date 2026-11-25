import {
  closeSync, existsSync, fchmodSync, fsyncSync, openSync, fstatSync, readSync,
  readFileSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync, mkdirSync, rmSync
} from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { ensurePrivateDirSync } from "./fs-store.mjs";
import { SIZE_LIMITS } from "./audit-contract.mjs";
import { validHistory } from "./login-ownership.mjs";
import { CLIENT_EVENTS, clientEvent } from "./client-events.mjs";
import { RUNS } from "./runs-contract.mjs";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

// conmap-auto mirrors this namespace in docs/contracts/block-capture-v1.json.
const ACTION_NAMESPACE = Buffer.from("38e3839fd44e5317b41fb2738b0a247a", "hex");

export function auditRowId(rootSessionId, toolCallId, phase) {
  const bytes = createHash("sha1").update(ACTION_NAMESPACE)
    .update(`${rootSessionId}:${toolCallId}:${phase}`).digest().subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function createAuditEnvelope(input, allocatedToolCallId = randomUUID()) {
  const sessionId = typeof input.session_id === "string" ? input.session_id : "";
  const rootSessionId = typeof input.root_session_id === "string" && input.root_session_id
    ? input.root_session_id : sessionId;
  const toolCallId = typeof input.tool_use_id === "string" && input.tool_use_id
    ? input.tool_use_id : allocatedToolCallId;
  return {
    sessionId,
    toolCallId,
    decisionId: auditRowId(rootSessionId, toolCallId, "decision"),
    resultId: auditRowId(rootSessionId, toolCallId, "result"),
    executedAt: new Date().toISOString(),
    link: {},
    plan: null
  };
}

export function snapshotAuditContext(envelope, session) {
  const planId = session?.countedPlanId || undefined;
  const tokenPlanId = session?.tokenPlanId || undefined;
  envelope.link = {
    plan_id: planId,
    context_plan_id: tokenPlanId !== planId ? tokenPlanId : undefined,
    prompt_id: session?.promptId || undefined
  };
  envelope.plan = structuredClone(session?.plan || null);
}

const copy = (value) => JSON.parse(JSON.stringify(value));
const bytes = (value) => Buffer.byteLength(JSON.stringify(value), "utf8");
const hash = (value) => createHash("sha256").update(value).digest("hex");
const bindingKey = (login) => login ? JSON.stringify([login.backend, login.keyId]) : null;
const identified = (login) => typeof login?.backend === "string" && Boolean(login.backend) &&
  typeof login?.keyId === "string" && Boolean(login.keyId);

export function auditLogin(config) {
  const backend = config.backendEndpoint || config.verifyStepEndpoint?.replace(/\/iap\/verify-step$/, "");
  if (!backend || !config.apiKey) return null;
  return {
    backend,
    keyId: hash(config.apiKey),
    credentialVersion: JSON.stringify([config.loggedInAt || "", config.loginHistory || null]),
    loggedInAt: config.loggedInAt,
    loginHistory: config.loginHistory,
    userId: config.userId
  };
}

export async function revalidateOutboxLogin(config) {
  for (const stream of ["audit", "health", ...(config.runReportingEnabled ? ["runs"] : [])]) {
    try {
      await createAuditWal({ dataDir: config.dataDir, config, stream }).authenticationSucceeded(auditLogin(config));
    } catch { process.stderr.write("[armorcodex] outbox authentication not saved\n"); }
  }
}

function validateLimits(limits) {
  if (!limits || !["maxRowBytes", "maxBatchBytes", "maxBatchRows"].every((key) =>
    Number.isSafeInteger(limits[key]) && limits[key] > 0) ||
    JSON.stringify(limits.truncationMarker) !== '{"truncated":true}' ||
    JSON.stringify(limits.shrinkOrder ?? ["input", "output"]) !== '["input","output"]') {
    throw new Error("Invalid audit outbox sizeLimits contract");
  }
  return limits;
}

function sharedLimits() {
  return validateLimits(SIZE_LIMITS);
}

function fitAuditRow(original, limits, shrinkError = false) {
  const fitted = copy(original);
  for (const field of limits.shrinkOrder ?? ["input", "output"]) {
    if (bytes(fitted) <= limits.maxRowBytes) return fitted;
    if (Object.hasOwn(fitted, field)) fitted[field] = copy(limits.truncationMarker);
  }
  if (shrinkError && bytes(fitted) > limits.maxRowBytes && typeof fitted.error_message === "string") {
    fitted.error_message = JSON.stringify(limits.truncationMarker);
  }
  return bytes(fitted) <= limits.maxRowBytes ? fitted : null;
}

function syncDir(dir) {
  const fd = openSync(dir, "r");
  try { fsyncSync(fd); } finally { closeSync(fd); }
}

function replace(file, text, beforeCommit = () => {}) {
  const temporary = `${file}.tmp.${process.pid}.${randomUUID()}`;
  const fd = openSync(temporary, "wx", 0o600);
  try {
    fchmodSync(fd, 0o600);
    writeFileSync(fd, text);
    fsyncSync(fd);
    if (beforeCommit() === false) return false;
    renameSync(temporary, file);
    syncDir(path.dirname(file));
    return true;
  } finally {
    closeSync(fd);
    if (existsSync(temporary)) unlinkSync(temporary);
  }
}

function readText(file) {
  try { return readFileSync(file, "utf8"); } catch (error) {
    if (error.code === "ENOENT") return "";
    throw error;
  }
}

function alive(pid) {
  try { process.kill(pid, 0); return true; } catch (error) {
    if (error.code === "ESRCH") return false;
    throw error;
  }
}

export function createAuditWal(opts) {
  const stream = opts.stream ?? "audit";
  if (!CLIENT_EVENTS.queues.includes(stream)) throw new Error("Invalid outbox stream");
  const health = stream === "health";
  const runs = stream === "runs";
  const idField = health ? "event_id" : "client_row_id";
  const rowId = (row) => runs ? JSON.stringify([row.run_id, row.report_seq]) : row[idField];
  const batchField = health ? "events" : runs ? "reports" : "rows";
  const auditDir = path.join(opts.dataDir, stream);
  const dir = path.join(auditDir, "outbox-v1");
  const archiveDir = path.join(dir, "archive");
  const receiptsDir = path.join(dir, "receipts");
  const unreportedDir = path.join(dir, "unreported");
  const configuredLimits = opts.sizeLimits ? validateLimits(opts.sizeLimits) : sharedLimits();
  const limits = {
    ...configuredLimits,
    maxBatchRows: Math.min(configuredLimits.maxBatchRows, health ? CLIENT_EVENTS.maxBatchEvents : runs ? RUNS.limits.maxBatchReports : Infinity),
    maxBatchBytes: Math.min(configuredLimits.maxBatchBytes, runs ? RUNS.limits.maxBatchBytes : Infinity)
  };
  const captureLimits = { ...limits, maxRowBytes: Math.min(limits.maxRowBytes, opts.contentLimitBytes ?? limits.maxRowBytes) };
  const clock = opts.clock ?? { now: Date.now, random: Math.random };
  const timing = { baseMs: 1000, maxMs: 300_000, lockTtlMs: 30_000, authProbeMs: 120_000, healthProbeMs: 30_000, ...opts.timing };
  const currentLogin = () => typeof opts.login === "function" ? opts.login() : opts.login ?? auditLogin(opts.config ?? {});
  const fault = (point) => opts.beforeCommit?.(point);
  const failuresPath = path.join(dir, "capture-failures.jsonl");
  const statePath = (segment) => path.join(segment, "state.json");
  const rowsPath = (segment) => path.join(segment, "rows.jsonl");
  const loginPath = (login) => path.join(dir, "login." + hash(bindingKey(login)) + ".json");
  const boundLogin = (login) => ({ backend: login.backend, keyId: login.keyId });
  const receiptPath = (login, id) => path.join(receiptsDir, hash(JSON.stringify([bindingKey(login), id])) + ".json");
  const load = (segment) => {
    const state = JSON.parse(readText(statePath(segment)));
    if (state.version !== 1 || !identified(state.login) || !Array.isArray(state.dead) ||
      !Array.isArray(state.settled) || !state.delivery) throw new Error("Invalid audit queue state");
    return state;
  };
  const loadLogin = (login) => {
    const raw = readText(loginPath(login));
    return raw ? JSON.parse(raw) : { login: boundLogin(login), active: null, paused: null };
  };
  const owns = (state, generation) => state.lease?.generation === generation && state.lease.expiresAt > clock.now();
  const save = (segment, state, points = [], generation) => replace(statePath(segment), JSON.stringify(state), () => {
    for (const point of Array.isArray(points) ? points : [points]) fault(point);
    return !generation || owns(state, generation);
  });
  const saveLogin = (login, state) => replace(loginPath(login), JSON.stringify(state));

  function ensureDirs() {
    for (const folder of [opts.dataDir, auditDir, dir, archiveDir, receiptsDir, unreportedDir]) {
      const fresh = !existsSync(folder);
      ensurePrivateDirSync(folder);
      if (fresh) syncDir(path.dirname(folder));
    }
  }

  // Unique bakery tickets avoid deleting a replacement owner's lock during stale process recovery.
  async function transaction(update) {
    ensureDirs();
    const name = "transaction." + process.pid + "." + randomUUID() + ".json";
    const ticketPath = path.join(dir, name);
    const readTickets = () => readdirSync(dir).filter((n) => /^transaction\.\d+\..*\.json$/.test(n)).flatMap((n) => {
      const file = path.join(dir, n);
      const raw = readText(file);
      if (!raw) return [];
      const ticket = JSON.parse(raw);
      if (!alive(ticket.pid)) {
        try { unlinkSync(file); } catch (error) { if (error.code !== "ENOENT") throw error; }
        return [];
      }
      return [{ ...ticket, name: n }];
    });
    try {
      replace(ticketPath, JSON.stringify({ pid: process.pid, number: 0 }));
      const number = 1 + Math.max(0, ...readTickets().map((ticket) => ticket.number));
      replace(ticketPath, JSON.stringify({ pid: process.pid, number }));
      const deadline = performance.now() + 5000;
      while (readTickets().some((ticket) => ticket.name !== name &&
        (ticket.number === 0 || ticket.number < number || (ticket.number === number && ticket.name < name)))) {
        if (performance.now() >= deadline) throw new Error("Audit storage transaction is busy");
        await sleep(5);
      }
      return update();
    } finally { if (existsSync(ticketPath)) unlinkSync(ticketPath); }
  }

  function queueFiles(folder = dir) {
    return readdirSync(folder, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && /^(queue|legacy)\./.test(entry.name))
      .map((entry) => path.join(folder, entry.name)).sort();
  }

  function records(segment) {
    const raw = readText(rowsPath(segment));
    const complete = raw.lastIndexOf("\n") + 1;
    return raw.slice(0, complete).split("\n").filter(Boolean).map((line) => JSON.parse(line));
  }

  function pending(segment, state = load(segment)) {
    const seen = new Set(state.settled);
    return records(segment).filter((row) => {
      if (seen.has(rowId(row)) || existsSync(receiptPath(state.login, rowId(row)))) return false;
      seen.add(rowId(row));
      return true;
    }).map(({ _enqueuedAt, ...row }) => ({
      row, login: state.login, attempts: 0, retries: 0, nextAttemptAt: 0,
      enqueuedAt: _enqueuedAt ??
        (Date.parse(row.occurred_at ?? row.executed_at ?? row.started_at) || (state.createdAt ?? statSync(rowsPath(segment)).mtimeMs)),
      ...state.delivery[rowId(row)]
    }));
  }

  function credentialAvailable(login) {
    const current = currentLogin();
    return identified(current) && current.available !== false && bindingKey(current) === bindingKey(login);
  }

  function available(login) {
    if (!credentialAvailable(login)) return false;
    const paused = loadLogin(login).paused;
    return !paused || (currentLogin().credentialVersion &&
      currentLogin().credentialVersion !== paused.credentialVersion);
  }

  function stageHealth(state, type, count, reason, extra) {
    if (health) return;
    state.healthEvents ??= [];
    while (count > 0) {
      const part = Math.min(count, CLIENT_EVENTS.maxCount);
      state.healthEvents.push(clientEvent(type, stream, part, reason, clock.now(), extra));
      count -= part;
    }
  }

  function createSegment(name, login, rows = [], dead = [], healthEvents = []) {
    const segment = path.join(dir, name);
    const temporary = path.join(dir, "creating." + process.pid + "." + randomUUID());
    mkdirSync(temporary, { mode: 0o700 });
    try {
      replace(rowsPath(temporary), rows.map((row) => JSON.stringify(row) + "\n").join(""));
      save(temporary, {
        version: 1, login: boundLogin(login), delivery: {}, createdAt: clock.now(),
        settled: dead.map(({ row }) => rowId(row)), dead, lease: null,
        ...(healthEvents.length ? { healthEvents } : {})
      });
      syncDir(temporary);
      renameSync(temporary, segment);
      syncDir(dir);
      return segment;
    } finally {
      if (existsSync(temporary)) rmSync(temporary, { recursive: true });
    }
  }

  function archive(segment) {
    const state = load(segment);
    if (state.lease || pending(segment, state).length) return;
    for (const id of state.settled) {
      const receipt = receiptPath(state.login, id);
      if (!existsSync(receipt)) replace(receipt, JSON.stringify({ segment: path.basename(segment) }));
    }
    // Segments that still owe health events wait in unreported/ until the events are in the health spool.
    const target = state.healthEvents?.length ? unreportedDir : archiveDir;
    renameSync(segment, path.join(target, path.basename(segment)));
    syncDir(target);
    syncDir(dir);
  }

  function queueFor(login) {
    const meta = loadLogin(login);
    const active = meta.active && path.join(dir, meta.active);
    if (active && existsSync(active)) {
      const fd = openSync(rowsPath(active), "r");
      try {
        const size = fstatSync(fd).size;
        const last = Buffer.alloc(1);
        if (size) readSync(fd, last, 0, 1, size - 1);
        if ((!size || last[0] === 0x0a) && size < Math.min(1024 * 1024, limits.maxRowBytes * limits.maxBatchRows)) return active;
      } finally { closeSync(fd); }
    }
    const name = "queue." + hash(bindingKey(login)) + "." + randomUUID();
    const segment = createSegment(name, login);
    meta.active = name;
    saveLogin(login, meta);
    return segment;
  }

  function append(file, value, point) {
    if (point) fault(point);
    const fresh = !existsSync(file);
    const fd = openSync(file, "a", 0o600);
    try {
      fchmodSync(fd, 0o600);
      writeFileSync(fd, JSON.stringify(value) + "\n");
      fsyncSync(fd);
    } finally { closeSync(fd); }
    if (fresh) syncDir(path.dirname(file));
  }

  function captureFailure(row = {}) {
    append(failuresPath, {
      client_row_id: row.client_row_id, session_id: row.session_id,
      executed_at: row.executed_at, code: row.code
    });
  }

  function proveLegacyLogin(rows) {
    const login = currentLogin();
    if (!identified(login) || !validHistory(login.loginHistory)) return null;
    const loggedInAt = Date.parse(login.loggedInAt);
    const events = login.loginHistory.events;
    if (!Number.isFinite(loggedInAt) || events.at(-1).at !== login.loggedInAt ||
      !login.userId || events.at(-1).userId !== login.userId) return null;
    if (rows.some((row) => row.user_id && row.user_id !== login.userId)) return null;
    const times = rows.map((row) => {
      const executed = Date.parse(row.executed_at);
      return Number.isFinite(executed) ? executed : row._enqueuedAt;
    });
    if (times.some((at) => !Number.isFinite(at))) return null;
    const oldest = Math.min(...times);
    return loggedInAt <= oldest && events.every((event) => Date.parse(event.at) <= oldest) ? login : null;
  }

  function importLegacy() {
    const currentPath = path.join(auditDir, "current.jsonl");
    const releasedArchive = path.join(auditDir, "archive");
    const files = [currentPath];
    if (existsSync(releasedArchive)) {
      files.push(...readdirSync(releasedArchive).filter((name) => name.endsWith(".jsonl"))
        .map((name) => path.join(releasedArchive, name)));
    }
    const unknown = [];
    for (const file of files) {
      let fd;
      try { fd = openSync(file, "r"); } catch (error) {
        if (error.code === "ENOENT") continue;
        throw error;
      }
      let raw;
      try {
        const st = fstatSync(fd);
        const offsetPath = path.join(auditDir, "shipped.offset");
        const offset = file === currentPath ? readText(offsetPath).trim() : "";
        if (offset && !/^\d+$/.test(offset)) throw new Error("Invalid legacy audit offset");
        const data = readFileSync(fd);
        const sameFile = statSync(file, { throwIfNoEntry: false });
        const offsetAfter = file === currentPath ? readText(offsetPath).trim() : "";
        const stable = sameFile?.ino === st.ino && offset === offsetAfter;
        const start = stable && Number(offset || 0) <= data.length ? Number(offset || 0) : 0;
        const complete = data.lastIndexOf(0x0a) + 1;
        raw = data.subarray(start, complete).toString("utf8");
      } finally { closeSync(fd); }
      const sourceRows = raw.split("\n").filter(Boolean).map((line) => JSON.parse(line));
      const login = proveLegacyLogin(sourceRows);
      for (const original of sourceRows) {
        const { _seq, _enqueuedAt, ...row } = original;
        row.client_row_id ||= auditRowId("legacy", hash(JSON.stringify(original)), "result");
        const name = "legacy." + hash(row.client_row_id);
        if ([dir, archiveDir, unreportedDir].some((folder) => existsSync(path.join(folder, name)))) continue;
        if (login) createSegment(name, login, [row]);
        else unknown.push({ row, login: null, attempts: 0, nextAttemptAt: 0 });
      }
    }
    return unknown;
  }

  async function appendLine(original, { fallback = false, binding } = {}) {
    const login = copy(binding ?? currentLogin() ?? null);
    let row = copy(original);
    if (fallback) {
      row = {
        client_row_id: row.client_row_id,
        ...(typeof row.session_id === "string" ? { session_id: row.session_id } : {}),
        tool: "unknown", action: "unknown", input: {}, executed_at: row.executed_at,
        decision_code: row.decision_code, status: "blocked"
      };
    }
    if (runs) {
      if (typeof row.run_id !== "string" || !row.run_id || row.run_id.length > RUNS.limits.maxIdChars ||
          !Number.isSafeInteger(row.report_seq) || row.report_seq < 1) throw new Error("Invalid run report identity");
    } else row[idField] = typeof row[idField] === "string" && UUID.test(row[idField]) ? row[idField] : randomUUID();
    return transaction(() => {
      if (!identified(login)) { captureFailure(row); return; }
      if (existsSync(receiptPath(login, rowId(row)))) return;
      if ((health || runs) && queueFiles().some((segment) => {
        const state = load(segment);
        return bindingKey(state.login) === bindingKey(login) &&
          (state.settled.includes(rowId(row)) || Object.hasOwn(state.delivery, rowId(row)));
      })) return;
      const fitted = fitAuditRow(row, captureLimits, opts.contentLimitBytes !== undefined);
      try {
        if (!fitted) {
          fault("deadLetter");
          const name = "queue." + hash(bindingKey(login)) + ".oversize." + hash(rowId(row));
          const existing = [dir, archiveDir, unreportedDir].some((folder) => existsSync(path.join(folder, name)));
          const segment = existing ? path.join(dir, name) : createSegment(name, login, [],
            [{ row, attempts: 0, reason: "oversize" }],
            health ? [] : [clientEvent("dead_letter", stream, 1, "oversize", clock.now())]);
          if (existsSync(segment)) archive(segment);
        } else {
          const segment = queueFor(login);
          const state = load(segment);
          append(rowsPath(segment), fitted, "append");
          if (health || runs) {
            state.delivery[rowId(row)] = { enqueuedAt: clock.now() };
            save(segment, state);
          }
        }
      } catch (error) {
        try { captureFailure(row); } catch { /* Preserve the original storage error when diagnostics cannot be saved. */ }
        throw error;
      }
    });
  }

  function parseResults(body, batch) {
    if (!body || typeof body !== "object") return null;
    const results = new Map();
    if (Object.hasOwn(body, "results")) {
      if (!Array.isArray(body.results)) return null;
      const ids = new Set(batch.map(({ row }) => rowId(row)));
      for (const result of body.results) {
        if (!result || !ids.has(rowId(result)) || results.has(rowId(result)) ||
          !(runs ? ["accepted", "stale", "duplicate", "rejected"] : CLIENT_EVENTS.outcomes).includes(result.outcome) ||
          (result.error !== undefined && typeof result.error !== "string")) return null;
        results.set(rowId(result), result);
      }
      return results;
    }
    if (health || runs || !Array.isArray(body.failures)) return null;
    const failed = new Set();
    for (const failure of body.failures) {
      if (!failure || !Number.isInteger(failure.index) || failure.index < 0 || failure.index >= batch.length ||
        failed.has(failure.index) || typeof failure.error !== "string") return null;
      failed.add(failure.index);
      results.set(rowId(batch[failure.index].row), { outcome: "retryable", error: failure.error });
    }
    for (const entry of batch) if (!results.has(rowId(entry.row))) results.set(rowId(entry.row), { outcome: "accepted" });
    return results;
  }

  function retryDelay(retries, header) {
    const ceiling = Math.min(timing.maxMs, timing.baseMs * 2 ** Math.min(retries - 1, 30));
    let retryAfter = 0;
    if (typeof header === "string" && header.trim()) {
      retryAfter = Number.isFinite(Number(header)) ? Number(header) * 1000 : Date.parse(header) - clock.now();
    }
    return Math.max(ceiling / 2 + clock.random() * ceiling / 2, Number.isFinite(retryAfter) ? retryAfter : 0);
  }

  function authenticationSucceeded(login) {
    if (!identified(login) || login.available === false) return;
    const meta = loadLogin(login);
    if (meta.paused) {
      meta.paused = null;
      saveLogin(login, meta);
    }
  }

  async function deliver(segment, batch, send, generation) {
    const permitted = await transaction(() => {
      if (!existsSync(segment)) return null;
      const state = load(segment);
      if (!owns(state, generation) || !available(state.login) ||
        (state.endpointPaused && state.probeAt > clock.now())) return null;
      state.lease.expiresAt = clock.now() + timing.lockTtlMs;
      save(segment, state, [], generation);
      return copy(currentLogin());
    });
    if (!permitted) return;
    let reply;
    let networkError;
    try { reply = await send({ login: copy(batch[0].login), rows: batch.map(({ row }) => copy(row)) }); }
    catch (error) { networkError = String(error); reply = { status: 0, body: null }; }
    if (reply?.skipped) return;
    const hasResults = reply?.body !== null && typeof reply?.body === "object" && Object.hasOwn(reply.body, "results");
    const maySettle = (reply?.status >= 200 && reply?.status < 300) || [400, 403, 422].includes(reply?.status);
    const results = (hasResults && maySettle) || (reply?.status >= 200 && reply?.status < 300)
      ? parseResults(reply.body, batch) : null;
    const authorized = await transaction(() => {
      if (!existsSync(segment)) return false;
      const state = load(segment);
      if (!owns(state, generation)) return false;
      if (health || runs) {
        state.endpointPaused = reply?.status === 404 || Boolean(state.endpointPaused && !reply?.status);
        state.probeAt = state.endpointPaused ? clock.now() + timing.healthProbeMs : 0;
        save(segment, state, [], generation);
        if (state.endpointPaused) return false;
      }
      if (reply?.status === 401 || (reply?.status === 403 && !(hasResults && results))) {
        const meta = loadLogin(state.login);
        if ((health || runs) && reply.status === 403 && reply.body?.error === "org_required") {
          const retries = meta.hold?.credentialVersion === permitted.credentialVersion ? (meta.hold?.retries ?? 0) + 1 : 1;
          meta.hold = { reason: "org_required", retries, credentialVersion: permitted.credentialVersion,
            nextProbeAt: clock.now() + Math.min(3_600_000, 300_000 * 2 ** Math.min(retries - 1, 30)) };
          saveLogin(state.login, meta);
          return false;
        }
        meta.paused = { credentialVersion: permitted.credentialVersion ?? null, nextProbeAt: clock.now() + timing.authProbeMs };
        saveLogin(state.login, meta);
        state.stallReason = "auth_paused";
        save(segment, state, [], generation);
        return false;
      }
      if (reply?.status >= 200 && reply?.status < 300) authenticationSucceeded(state.login);
      if (results || (reply?.status >= 200 && reply?.status < 300)) {
        const meta = loadLogin(state.login);
        if (meta.hold) { meta.hold = null; saveLogin(state.login, meta); }
      }
      return true;
    });
    if (!authorized) return;
    if (!hasResults && [400, 422].includes(reply?.status) && batch.length > 1) {
      const middle = Math.floor(batch.length / 2);
      await deliver(segment, batch.slice(0, middle), send, generation);
      await deliver(segment, batch.slice(middle), send, generation);
      return;
    }
    const split = results && batch.length > 1 ? batch.filter(({ row }) => {
      const result = results.get(rowId(row));
      return result?.outcome === "retryable" && result.error === "batch_oversize";
    }) : [];
    await transaction(() => {
      if (!existsSync(segment)) return;
      const state = load(segment);
      if (!owns(state, generation)) return;
      const settled = new Set(state.settled);
      const decisions = new Map();
      const deadCounts = new Map();
      for (const sent of batch) {
        const id = rowId(sent.row);
        if (settled.has(id) || split.includes(sent)) continue;
        const result = results?.get(id);
        const isolated = !hasResults && batch.length === 1 && [400, 422].includes(reply?.status);
        const nonTransient = !hasResults && reply?.status >= 400 && reply.status < 500 &&
          ![401, 403, 408, 429].includes(reply.status) &&
          !(reply.status === 409 && reply.body?.error === "request_in_progress");
        const charged = result?.outcome === "rejected" || isolated || (!result && nonTransient);
        const attempts = (state.delivery[id]?.attempts ?? 0) + (charged ? 1 : 0);
        const retries = (state.delivery[id]?.retries ?? 0) + 1;
        const reason = result?.error || networkError || (result ? result.outcome : "HTTP " + (reply?.status ?? 0) + ": unreadable or missing outcome");
        state.delivery[id] = { enqueuedAt: sent.enqueuedAt, attempts, retries, lastError: reason, nextAttemptAt: 0 };
        if (["accepted", "duplicate", ...(runs ? ["stale"] : [])].includes(result?.outcome)) decisions.set(id, "ack");
        else if (result?.outcome === "rejected" || isolated || attempts >= 10) {
          decisions.set(id, "deadLetter");
          const code = result?.outcome === "rejected" || isolated ? "rejected" : "attempts_exhausted";
          deadCounts.set(code, (deadCounts.get(code) ?? 0) + 1);
        }
        else state.delivery[id].nextAttemptAt = clock.now() + retryDelay(retries, reply?.headers?.["retry-after"]);
      }
      state.stallReason = decisions.size + split.length === batch.length ? null : reply?.status === 429 ? "rate_limited"
        : reply?.status ? "server_error" : "backend_unreachable";
      if (!save(segment, state, [], generation)) return;
      for (const [id, decision] of decisions) {
        if (decision === "deadLetter") state.dead.push({
          row: batch.find(({ row }) => rowId(row) === id).row,
          attempts: state.delivery[id].attempts, reason: state.delivery[id].lastError
        });
        state.settled.push(id);
        delete state.delivery[id];
      }
      for (const [reason, count] of deadCounts) stageHealth(state, "dead_letter", count, reason);
      save(segment, state, [...new Set(decisions.values())], generation);
    });
    if (split.length) {
      const middle = Math.ceil(split.length / 2);
      await deliver(segment, split.slice(0, middle), send, generation);
      if (middle < split.length) await deliver(segment, split.slice(middle), send, generation);
    }
  }

  async function probePaused(probe) {
    if (!probe) return;
    const login = currentLogin();
    if (!credentialAvailable(login)) return;
    const selected = await transaction(() => {
      const meta = loadLogin(login);
      if (!meta.paused || meta.paused.nextProbeAt > clock.now()) return false;
      meta.paused.nextProbeAt = clock.now() + timing.authProbeMs;
      saveLogin(login, meta);
      return true;
    });
    if (!selected) return;
    try {
      const response = await probe({ login: boundLogin(login) });
      if (response?.status >= 200 && response.status < 300) {
        await transaction(() => authenticationSucceeded(login));
        return true;
      }
    } catch { /* Failed authentication probes keep the durable pause and spend no row attempts. */ }
  }

  async function drain(send, { probe, allowDelivery = true } = {}) {
    if (stream === "audit") await transaction(() => importLegacy());
    if (opts.canDeliverRow && !await transaction(() => queueFiles().some((segment) =>
      pending(segment).some(({ row }) => opts.canDeliverRow(row))))) return;
    const authenticated = await probePaused(probe);
    if (!allowDelivery && !authenticated) return;
    const ready = (state) => available(state.login) &&
      (!loadLogin(state.login).hold || loadLogin(state.login).hold.nextProbeAt <= clock.now() ||
        loadLogin(state.login).hold.credentialVersion !== currentLogin()?.credentialVersion) &&
      (!state.endpointPaused || state.probeAt <= clock.now());
    const selected = await transaction(() => queueFiles().filter((segment) => ready(load(segment))));
    for (const segment of selected) {
      const generation = randomUUID();
      const entries = await transaction(() => {
        if (!existsSync(segment)) return null;
        const state = load(segment);
        if (!ready(state) || state.lease?.expiresAt > clock.now()) return null;
        authenticationSucceeded(state.login);
        state.lease = { generation, expiresAt: clock.now() + timing.lockTtlMs };
        save(segment, state);
        return pending(segment, state).filter((entry) => entry.nextAttemptAt <= clock.now() &&
          (!opts.canDeliverRow || opts.canDeliverRow(entry.row)));
      });
      if (!entries) continue;
      try {
        let batch = [];
        for (const entry of entries) {
          if (entry.attempts >= 10) {
            await transaction(() => {
              if (!existsSync(segment)) return;
              const state = load(segment);
              if (!owns(state, generation) || state.settled.includes(rowId(entry.row))) return;
              state.dead.push({ row: entry.row, attempts: entry.attempts, reason: entry.lastError });
              state.settled.push(rowId(entry.row));
              delete state.delivery[rowId(entry.row)];
              stageHealth(state, "dead_letter", 1, "attempts_exhausted");
              save(segment, state, "deadLetter", generation);
            });
            continue;
          }
          const next = [...batch, entry];
          if (next.length > limits.maxBatchRows || bytes({ [batchField]: next.map(({ row }) => row) }) > limits.maxBatchBytes) {
            if (!batch.length) throw new Error("Audit row cannot fit the configured batch cap");
            await deliver(segment, batch, send, generation);
            batch = [];
          }
          if (bytes({ [batchField]: [entry.row] }) > limits.maxBatchBytes) throw new Error("Audit row cannot fit the configured batch cap");
          batch.push(entry);
        }
        if (batch.length) await deliver(segment, batch, send, generation);
      } finally {
        await transaction(() => {
          if (!existsSync(segment)) return;
          const state = load(segment);
          if (state.lease?.generation === generation) {
            state.lease = null;
            save(segment, state);
            archive(segment);
          }
        });
      }
    }
  }

  async function reportHealth(stallReason) {
    if (health) return;
    const reports = await transaction(() => {
      const files = [...queueFiles(), ...queueFiles(unreportedDir)];
      const groups = new Map();
      for (const name of readdirSync(dir).filter((name) => /^login\..*\.json$/.test(name))) {
        const meta = JSON.parse(readText(path.join(dir, name)));
        if (meta.healthEvents?.length) groups.set(bindingKey(meta.login), { login: meta.login, segments: [] });
      }
      const reports = files.flatMap((file) => {
        const state = load(file);
        if (file.startsWith(unreportedDir)) return (state.healthEvents ?? []).map((event) => ({ file, event, login: state.login }));
        const reason = !available(state.login) ? (loadLogin(state.login).paused ? "auth_paused" : "undeliverable_login")
          : stallReason ?? state.stallReason;
        const key = bindingKey(state.login);
        if (!groups.has(key)) groups.set(key, { login: state.login, segments: [], reason });
        const group = groups.get(key);
        group.segments.push({ file, state });
        group.reason ||= reason;
        return (state.healthEvents ?? []).map((event) => ({ file, event, login: state.login }));
      });
      for (const { login, segments, reason } of groups.values()) {
        const meta = loadLogin(login);
        if (reason && clock.now() - (meta.lastStallAt ?? -Infinity) >= 3_600_000) {
          const revision = JSON.stringify(segments.map(({ file }) => {
            const rows = statSync(rowsPath(file), { bigint: true });
            const state = statSync(statePath(file), { bigint: true });
            return [path.basename(file), rows.ino, rows.size, rows.mtimeNs, state.ino, state.mtimeNs].map(String);
          }));
          if (meta.stallCheck?.revision !== revision || meta.stallCheck.nextAt <= clock.now()) {
            const pendingEntries = segments.flatMap(({ file, state }) => pending(file, state));
            const entries = pendingEntries.filter(({ nextAttemptAt }) => nextAttemptAt <= clock.now());
            if (entries.length) {
              stageHealth(meta, "queue_stalled", entries.length, reason, {
                oldest_pending_seconds: Math.max(0, Math.floor((clock.now() - entries.reduce((oldest, entry) => Math.min(oldest, entry.enqueuedAt), clock.now())) / 1000))
              });
              meta.lastStallAt = clock.now();
              delete meta.stallCheck;
            } else {
              meta.stallCheck = { revision, nextAt: pendingEntries.reduce((next, entry) => Math.min(next, entry.nextAttemptAt), Number.MAX_SAFE_INTEGER) };
            }
            saveLogin(login, meta);
          }
        }
        reports.push(...(meta.healthEvents ?? []).map((event) => ({ event, login, loginReceipt: true })));
      }
      return reports;
    });
    const spool = createAuditWal({ ...opts, stream: "health" });
    for (const { file, event, login, loginReceipt } of reports) {
      // Keep the source receipt until the health append commits, so a crash can only cause a duplicate.
      await spool.appendLine(event, { binding: login });
      await transaction(() => {
        if (loginReceipt) {
          const meta = loadLogin(login);
          meta.healthEvents = (meta.healthEvents ?? []).filter(({ event_id }) => event_id !== event.event_id);
          saveLogin(login, meta);
          return;
        }
        const current = [file, path.join(unreportedDir, path.basename(file)), path.join(archiveDir, path.basename(file))]
          .find((candidate) => existsSync(candidate));
        if (!current) throw new Error("Missing health source receipt");
        const state = load(current);
        state.healthEvents = (state.healthEvents ?? []).filter(({ event_id }) => event_id !== event.event_id);
        save(current, state);
        if (current.startsWith(unreportedDir) && !state.healthEvents.length) {
          const target = path.join(archiveDir, path.basename(current));
          if (existsSync(target)) renameSync(target, `${target}.conflict.${randomUUID()}`);
          renameSync(current, target);
          syncDir(archiveDir);
          syncDir(unreportedDir);
        }
      });
    }
  }

  return {
    appendLine, drain, reportHealth,
    readPending: () => transaction(() => {
      const unknown = stream === "audit" ? importLegacy() : [];
      return [...queueFiles().flatMap((segment) => pending(segment)), ...unknown];
    }),
    readDeadLetters: () => transaction(() => [...queueFiles(), ...queueFiles(unreportedDir), ...queueFiles(archiveDir)].flatMap((segment) => load(segment).dead)),
    recordCaptureFailure: (row) => transaction(() => captureFailure(row)),
    authenticationSucceeded: (login) => identified(login) && existsSync(loginPath(login)) && loadLogin(login).paused
      ? transaction(() => authenticationSucceeded(login)) : Promise.resolve(),
    status: () => transaction(() => {
      const unknown = stream === "audit" ? importLegacy() : [];
      const entries = queueFiles().flatMap((segment) => pending(segment));
      return {
        queuedRows: entries.length + unknown.length,
        undeliverable: unknown.length + entries.filter(({ login }) => !available(login)).length,
        deadLetters: [...queueFiles(), ...queueFiles(unreportedDir), ...queueFiles(archiveDir)].reduce((count, segment) => count + load(segment).dead.length, 0),
        paused: queueFiles().some((segment) => {
          const state = load(segment);
          return Boolean(state.endpointPaused || loadLogin(state.login).paused);
        }),
        hold: queueFiles().map((segment) => loadLogin(load(segment).login).hold?.reason).find(Boolean) ?? null,
        captureFailures: readText(failuresPath).split("\n").filter(Boolean).length
      };
    })
  };
}
