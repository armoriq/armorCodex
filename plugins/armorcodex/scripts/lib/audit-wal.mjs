import {
  chmodSync, closeSync, existsSync, fchmodSync, fsyncSync, openSync,
  readFileSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync
} from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { ensurePrivateDirSync } from "./fs-store.mjs";

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
    credentialVersion: JSON.stringify([config.loggedInAt || "", config.loginHistory || null])
  };
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
  const contract = JSON.parse(readFileSync(new URL("../../tests/fixtures/block-capture-v1.json", import.meta.url), "utf8"));
  if (contract.version !== 1 || !Array.isArray(contract.sizeLimits?.shrinkOrder)) {
    throw new Error("Invalid audit outbox contract");
  }
  return validateLimits(contract.sizeLimits);
}

export function fitAuditRow(original, limits = sharedLimits()) {
  const fitted = copy(original);
  for (const field of limits.shrinkOrder ?? ["input", "output"]) {
    if (bytes(fitted) <= limits.maxRowBytes) return fitted;
    if (Object.hasOwn(fitted, field)) fitted[field] = copy(limits.truncationMarker);
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
  const dir = path.join(opts.dataDir, "audit");
  const limits = opts.sizeLimits ? validateLimits(opts.sizeLimits) : sharedLimits();
  const clock = opts.clock ?? { now: Date.now, random: Math.random };
  const timing = { baseMs: 1000, maxMs: 300_000, lockTtlMs: 30_000, ...opts.timing };
  const currentLogin = () => typeof opts.login === "function" ? opts.login() : opts.login ?? auditLogin(opts.config ?? {});
  const fault = (point) => opts.beforeCommit?.(point);
  const failuresPath = path.join(dir, "capture-failures.jsonl");
  const currentPath = path.join(dir, "current.jsonl");
  const statePath = (file) => file.replace(/\.jsonl$/, ".state.json");
  const load = (file) => {
    const raw = readText(statePath(file));
    if (!raw) return null;
    const state = JSON.parse(raw);
    if (state.version !== 1 || !identified(state.login) || !Array.isArray(state.dead) ||
      !Array.isArray(state.settled) || !state.delivery) throw new Error("Invalid audit queue state");
    return state;
  };
  const save = (file, state, points = [], generation) => replace(statePath(file), JSON.stringify(state), () => {
    for (const point of Array.isArray(points) ? points : [points]) fault(point);
    return !generation || owns(state, generation);
  });

  function ensureDirs() {
    const newDataDir = !existsSync(opts.dataDir);
    const newAuditDir = !existsSync(dir);
    const newArchiveDir = !existsSync(path.join(dir, "archive"));
    ensurePrivateDirSync(dir);
    ensurePrivateDirSync(path.join(dir, "archive"));
    if (newDataDir) syncDir(path.dirname(opts.dataDir));
    if (newAuditDir) syncDir(opts.dataDir);
    if (newArchiveDir) syncDir(dir);
    for (const folder of [dir, path.join(dir, "archive")]) {
      for (const name of readdirSync(folder)) {
        const file = path.join(folder, name);
        const st = statSync(file, { throwIfNoEntry: false });
        if (st?.isFile() && st.uid === process.getuid?.() && (st.mode & 0o077)) chmodSync(file, 0o600);
      }
    }
  }

  // Unique bakery tickets avoid deleting a replacement owner's lock during stale process recovery.
  async function transaction(update) {
    ensureDirs();
    const name = `transaction.${process.pid}.${randomUUID()}.json`;
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

  function queueFiles() {
    const files = new Set(readdirSync(dir).filter((name) => /^(current|queue\.[a-f0-9]+)\.jsonl$/.test(name)));
    for (const name of readdirSync(dir).filter((name) => /^(current|queue\.[a-f0-9]+)\.state\.json$/.test(name))) {
      files.add(name.replace(/\.state\.json$/, ".jsonl"));
    }
    return [...files].sort().map((name) => path.join(dir, name));
  }

  function records(file) {
    let raw = readText(file);
    if (!load(file) && file === currentPath) {
      const offset = readText(path.join(dir, "shipped.offset")).trim();
      if (offset && !/^\d+$/.test(offset)) throw new Error("Invalid legacy audit offset");
      raw = Buffer.from(raw).subarray(Number(offset || 0)).toString("utf8");
    }
    return raw.split("\n").filter(Boolean).map((line) => {
      const { _seq, _enqueuedAt, ...row } = JSON.parse(line);
      return row;
    });
  }

  function pending(file, state = load(file)) {
    const seen = new Set(state?.settled ?? []);
    return records(file).filter((row) => {
      if (row.client_row_id && seen.has(row.client_row_id)) return false;
      if (row.client_row_id) seen.add(row.client_row_id);
      return true;
    }).map((row) => ({
      row, login: state?.login ?? null, attempts: 0, nextAttemptAt: 0,
      ...state?.delivery[row.client_row_id]
    }));
  }

  function available(state, login = currentLogin()) {
    return identified(login) && login.available !== false && bindingKey(login) === bindingKey(state?.login) &&
      (!state.paused || (login.credentialVersion && login.credentialVersion !== state.paused.credentialVersion));
  }

  function queueFor(login) {
    let file = queueFiles().find((candidate) => bindingKey(load(candidate)?.login) === bindingKey(login));
    if (file) return file;
    file = !existsSync(currentPath) && !existsSync(statePath(currentPath)) ? currentPath
      : path.join(dir, `queue.${hash(bindingKey(login))}.jsonl`);
    save(file, {
      version: 1, login: { backend: login.backend, keyId: login.keyId },
      delivery: {}, settled: [], dead: [], lease: null, paused: null
    });
    return file;
  }

  function captureFailure(row = {}) {
    replace(failuresPath, readText(failuresPath) + JSON.stringify({
      client_row_id: row.client_row_id, session_id: row.session_id, executed_at: row.executed_at,
      code: row.code
    }) + "\n");
  }

  async function appendLine(original, { fallback = false, loggedOut = false } = {}) {
    if (loggedOut) return;
    const login = copy(currentLogin() ?? null);
    let row = copy(original);
    if (fallback) {
      row = {
        client_row_id: row.client_row_id,
        ...(typeof row.session_id === "string" ? { session_id: row.session_id } : {}),
        tool: "unknown", action: "unknown", input: {}, executed_at: row.executed_at,
        decision_code: row.decision_code, status: "blocked"
      };
    }
    row.client_row_id = typeof row.client_row_id === "string" && UUID.test(row.client_row_id) ? row.client_row_id : randomUUID();
    return transaction(() => {
      if (!identified(login)) { captureFailure(row); return; }
      const file = queueFor(login);
      const state = load(file);
      const fitted = fitAuditRow(row, limits);
      try {
        if (!fitted) {
          if (!state.settled.includes(row.client_row_id)) {
            state.dead.push({ row, attempts: 0, reason: "oversize" });
            state.settled.push(row.client_row_id);
            save(file, state, "deadLetter");
          }
        } else {
          const raw = readText(file);
          replace(file, raw + JSON.stringify(fitted) + "\n", () => fault("append"));
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
      const ids = new Set(batch.map(({ row }) => row.client_row_id));
      for (const result of body.results) {
        if (!result || !ids.has(result.client_row_id) || results.has(result.client_row_id) ||
          !["accepted", "duplicate", "retryable", "rejected"].includes(result.outcome) ||
          (result.error !== undefined && typeof result.error !== "string")) return null;
        results.set(result.client_row_id, result);
      }
      return results;
    }
    if (!Array.isArray(body.failures)) return null;
    const failed = new Set();
    for (const failure of body.failures) {
      if (!failure || !Number.isInteger(failure.index) || failure.index < 0 || failure.index >= batch.length ||
        failed.has(failure.index) || typeof failure.error !== "string") return null;
      failed.add(failure.index);
      results.set(batch[failure.index].row.client_row_id, { outcome: "retryable", error: failure.error });
    }
    for (const entry of batch) if (!results.has(entry.row.client_row_id)) results.set(entry.row.client_row_id, { outcome: "accepted" });
    return results;
  }

  function retryDelay(attempts, header) {
    const ceiling = Math.min(timing.maxMs, timing.baseMs * 2 ** (attempts - 1));
    let retryAfter = 0;
    if (typeof header === "string" && header.trim()) {
      retryAfter = Number.isFinite(Number(header)) ? Number(header) * 1000 : Date.parse(header) - clock.now();
    }
    return Math.max(ceiling / 2 + clock.random() * ceiling / 2, Number.isFinite(retryAfter) ? retryAfter : 0);
  }

  const owns = (state, generation) => state.lease?.generation === generation && state.lease.expiresAt > clock.now();

  async function deliver(file, batch, send, generation) {
    const permitted = await transaction(() => {
      const state = load(file);
      return owns(state, generation) && available(state) ? copy(currentLogin()) : null;
    });
    if (!permitted) return;
    let reply;
    let networkError;
    try { reply = await send({ login: copy(batch[0].login), rows: batch.map(({ row }) => copy(row)) }); }
    catch (error) { networkError = String(error); reply = { status: 0, body: null }; }
    const hasResults = reply?.body !== null && typeof reply?.body === "object" && Object.hasOwn(reply.body, "results");
    const results = hasResults || (reply?.status >= 200 && reply?.status < 300) ? parseResults(reply.body, batch) : null;
    const authorized = await transaction(() => {
      const state = load(file);
      if (!owns(state, generation)) return false;
      if (reply?.status === 401 || (reply?.status === 403 && !(hasResults && results))) {
        state.paused = { credentialVersion: permitted.credentialVersion ?? null };
        save(file, state, [], generation);
        return false;
      }
      return true;
    });
    if (!authorized) return;
    if (!hasResults && [400, 422].includes(reply?.status) && batch.length > 1) {
      const middle = Math.floor(batch.length / 2);
      await deliver(file, batch.slice(0, middle), send, generation);
      await deliver(file, batch.slice(middle), send, generation);
      return;
    }
    const split = results && batch.length > 1 ? batch.filter(({ row }) => {
      const result = results.get(row.client_row_id);
      return result?.outcome === "retryable" && result.error === "batch_oversize";
    }) : [];
    await transaction(() => {
      const state = load(file);
      if (!owns(state, generation)) return;
      const decisions = new Map();
      for (const sent of batch) {
        const id = sent.row.client_row_id;
        if (state.settled.includes(id) || split.includes(sent)) continue;
        const attempts = (state.delivery[id]?.attempts ?? 0) + 1;
        const result = results?.get(id);
        const reason = result?.error || networkError || (result ? result.outcome : `HTTP ${reply?.status ?? 0}: unreadable or missing outcome`);
        state.delivery[id] = { attempts, lastError: reason, nextAttemptAt: 0 };
        if (["accepted", "duplicate"].includes(result?.outcome)) decisions.set(id, "ack");
        else if (result?.outcome === "rejected" || attempts >= 10 ||
          (!hasResults && batch.length === 1 && [400, 422].includes(reply?.status))) decisions.set(id, "deadLetter");
        else state.delivery[id].nextAttemptAt = clock.now() + retryDelay(attempts, reply?.headers?.["retry-after"]);
      }
      if (!save(file, state, [], generation)) return;
      for (const [id, decision] of decisions) {
        if (decision === "deadLetter") state.dead.push({
          row: batch.find(({ row }) => row.client_row_id === id).row,
          attempts: state.delivery[id].attempts, reason: state.delivery[id].lastError
        });
        state.settled.push(id);
      }
      save(file, state, [...new Set(decisions.values())], generation);
    });
    if (split.length) {
      const middle = Math.ceil(split.length / 2);
      await deliver(file, split.slice(0, middle), send, generation);
      if (middle < split.length) await deliver(file, split.slice(middle), send, generation);
    }
  }

  async function drain(send) {
    const selected = await transaction(() => queueFiles().filter((file) => available(load(file))));
    for (const file of selected) {
      const generation = randomUUID();
      const entries = await transaction(() => {
        const state = load(file);
        if (!available(state) || state.lease?.expiresAt > clock.now()) return null;
        state.lease = { generation, expiresAt: clock.now() + timing.lockTtlMs };
        state.paused = null;
        save(file, state);
        return pending(file, state).filter((entry) => entry.nextAttemptAt <= clock.now());
      });
      if (!entries) continue;
      try {
        let batch = [];
        for (const entry of entries) {
          if (entry.attempts >= 10) {
            await transaction(() => {
              const state = load(file);
              if (!owns(state, generation) || state.settled.includes(entry.row.client_row_id)) return;
              state.dead.push({ row: entry.row, attempts: entry.attempts, reason: entry.lastError });
              state.settled.push(entry.row.client_row_id);
              save(file, state, "deadLetter", generation);
            });
            continue;
          }
          const next = [...batch, entry];
          if (next.length > limits.maxBatchRows || bytes({ rows: next.map(({ row }) => row) }) > limits.maxBatchBytes) {
            if (!batch.length) throw new Error("Audit row cannot fit the configured batch cap");
            await deliver(file, batch, send, generation);
            batch = [];
          }
          if (bytes({ rows: [entry.row] }) > limits.maxBatchBytes) {
            throw new Error("Audit row cannot fit the configured batch cap");
          }
          batch.push(entry);
        }
        if (batch.length) await deliver(file, batch, send, generation);
      } finally {
        await transaction(() => {
          const state = load(file);
          if (state.lease?.generation === generation) { state.lease = null; save(file, state); }
        });
      }
    }
  }

  return {
    appendLine, drain,
    readPending: () => transaction(() => queueFiles().flatMap((file) => pending(file))),
    readDeadLetters: () => transaction(() => queueFiles().flatMap((file) => load(file)?.dead ?? [])),
    recordCaptureFailure: (row) => transaction(() => captureFailure(row)),
    restoreLogin: () => transaction(() => {
      for (const file of queueFiles()) {
        const state = load(file);
        const login = currentLogin();
        if (state && identified(login) && login.available !== false && bindingKey(state.login) === bindingKey(login)) {
          state.paused = null;
          save(file, state);
        }
      }
    }),
    status: () => transaction(() => {
      const files = queueFiles();
      return {
        queuedRows: files.reduce((count, file) => count + pending(file).length, 0),
        undeliverable: files.reduce((count, file) => count + (available(load(file)) ? 0 : pending(file).length), 0),
        deadLetters: files.reduce((count, file) => count + (load(file)?.dead.length ?? 0), 0),
        captureFailures: readText(failuresPath).split("\n").filter(Boolean).length
      };
    }),
    _paths: { currentPath, statePath: statePath(currentPath), archiveDir: path.join(dir, "archive") }
  };
}
