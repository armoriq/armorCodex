import { normalizeToolName } from "./common.mjs";
import { createHash, randomUUID } from "node:crypto";
import { closeSync, existsSync, fsyncSync, openSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { auditLogin, createAuditWal } from "./audit-wal.mjs";
import { ensurePrivateDirSync } from "./fs-store.mjs";
import { withFileLock } from "./live-usage.mjs";
import { harnessProcess, processInfo } from "./usage-sessions.mjs";

export { RUNS } from "./runs-contract.mjs";
import { RUNS } from "./runs-contract.mjs";

const toolsFile = (config, id) => path.join(config.dataDir, "run-tools-v1", createHash("sha256").update(id).digest("hex") + ".jsonl");
const startArchiveFile = (config, id) => path.join(config.dataDir, "run-starts-v1", "archive", createHash("sha256").update(id).digest("hex") + ".json");

function archivedStart(config, id) {
  try { return JSON.parse(readFileSync(startArchiveFile(config, id), "utf8")); }
  catch (error) { if (error.code === "ENOENT") return null; throw error; }
}

function hasArchivedContext(config, context) {
  try { return archivedStart(config, context.run_id)?.context?.run_id === context.run_id; }
  catch { process.stderr.write("[armorcodex] run start archive could not be read\n"); return false; }
}

function syncDirectory(dir) {
  const fd = openSync(dir, "r");
  try { fsyncSync(fd); } finally { closeSync(fd); }
}

function storeArchive(file, raw) {
  const directories = [];
  for (let dir = path.dirname(file); !existsSync(dir); dir = path.dirname(dir)) directories.push(dir);
  ensurePrivateDirSync(path.dirname(file));
  const temporary = `${file}.tmp.${randomUUID()}`;
  const fd = openSync(temporary, "wx", 0o600);
  try {
    writeFileSync(fd, raw);
    fsyncSync(fd);
    renameSync(temporary, file);
    syncDirectory(path.dirname(file));
    for (const dir of directories) syncDirectory(path.dirname(dir));
  } finally {
    closeSync(fd);
    try { unlinkSync(temporary); } catch (error) { if (error.code !== "ENOENT") throw error; }
  }
}

const quarantineFile = (config, journal, offset, line) => path.join(config.dataDir, "run-tools-v1", "quarantine",
  `${path.basename(journal)}.${offset}.${createHash("sha256").update(line).digest("hex")}`);

function quarantineLine(config, journal, offset, line) {
  const file = quarantineFile(config, journal, offset, line);
  if (!existsSync(file)) storeArchive(file, line);
}

function readJournal(journal, durable = false) {
  try {
    if (!durable) return readFileSync(journal);
    const fd = openSync(journal, "r");
    try {
      // Sync before committing a replay offset, or a crash can lose already-counted calls.
      fsyncSync(fd);
      return readFileSync(fd);
    } finally { closeSync(fd); }
  }
  catch (error) { if (error.code === "ENOENT") return Buffer.alloc(0); throw error; }
}

function cleanJournalTail(config, journal, raw) {
  if (!raw.length || raw.at(-1) === 0x0a) return raw;
  const offset = raw.lastIndexOf(0x0a) + 1;
  // Keep the bytes before sealing the tail, or a crash can turn a torn record into a counted call.
  quarantineLine(config, journal, offset, raw.subarray(offset));
  const fd = openSync(journal, "a", 0o600);
  try { writeFileSync(fd, "\n"); fsyncSync(fd); } finally { closeSync(fd); }
  return Buffer.concat([raw, Buffer.from("\n")]);
}

export function runStateWarnings(config) {
  try { return readdirSync(config.dataDir).filter((name) => name.startsWith("run-state-v1.json.corrupt.")).length; }
  catch (error) { if (error.code === "ENOENT") return 0; throw error; }
}

export function runJournalWarnings(config) {
  try { return readdirSync(path.join(config.dataDir, "run-tools-v1", "quarantine")).filter((name) => !name.includes(".tmp.")).length; }
  catch (error) { if (error.code === "ENOENT") return 0; throw error; }
}

function replayTools(config, run, durable) {
  const journal = toolsFile(config, run.run_id);
  const raw = cleanJournalTail(config, journal, readJournal(journal, durable));
  const seen = new Set(run.toolIds);
  const toolIds = [...run.toolIds];
  let toolCalls = run.tool_calls;
  let gatedToolCalls = run.gated_tool_calls;
  let lastActivityAt = run.lastActivityAt ?? 0;
  for (let offset = run.toolOffset ?? 0; offset < raw.length;) {
    const end = raw.indexOf(0x0a, offset);
    const line = raw.subarray(offset, end);
    const start = offset;
    offset = end + 1;
    if (!line.length || existsSync(quarantineFile(config, journal, start, line))) continue;
    let event;
    try {
      event = JSON.parse(line.toString("utf8"));
      if (!event || event.runId !== run.run_id || typeof event.at !== "number" || typeof event.gated !== "boolean") throw new SyntaxError("Invalid run tool event");
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
      quarantineLine(config, journal, start, line);
      continue;
    }
    if (event.id && seen.has(event.id)) continue;
    toolCalls += 1;
    if (event.gated) gatedToolCalls += 1;
    if (event.id) { seen.add(event.id); toolIds.push(event.id); }
    lastActivityAt = Math.max(lastActivityAt, event.at);
  }
  Object.assign(run, { tool_calls: toolCalls, gated_tool_calls: gatedToolCalls, toolIds, lastActivityAt });
  run.toolOffset = raw.length;
}

function replayRunTools(config, run, durable = true) {
  try { replayTools(config, run, durable); delete run.journalUnavailable; }
  catch {
    run.journalUnavailable = true;
    process.stderr.write("[armorcodex] run tool journal could not be read\n");
  }
}

export async function withRunState(config, update, { tool } = {}) {
  const file = path.join(config.dataDir, "run-state-v1.json");
  return withFileLock(`${file}.lock`, async () => {
    let state;
    try {
      state = JSON.parse(readFileSync(file, "utf8"));
      if (!state || !state.runs || Array.isArray(state.runs) || !Array.isArray(state.runReports)) throw new SyntaxError("Invalid run state");
    }
    catch (error) {
      if (error instanceof SyntaxError) {
        renameSync(file, `${file}.corrupt.${randomUUID()}`);
        const directory = openSync(config.dataDir, "r");
        try { fsyncSync(directory); } finally { closeSync(directory); }
        process.stderr.write("[armorcodex] corrupt run state set aside\n");
      } else if (error.code !== "ENOENT") throw error;
      state = { runs: {}, runReports: [] };
    }
    for (const run of Object.values(state.runs)) replayRunTools(config, run, !tool);
    const before = JSON.stringify(state);
    // Archive only settled entries from the committed snapshot, so a crash cannot hide an uncommitted close.
    for (const [runId, context] of Object.entries(state.startedRuns ?? {})) {
      if (state.runs[runId]) continue;
      const archive = startArchiveFile(config, runId);
      if (!existsSync(archive)) storeArchive(archive, JSON.stringify({ run_id: runId, context }));
      delete state.startedRuns[runId];
    }
    const result = await update(state);
    const changed = JSON.stringify(state) !== before;
    const event = tool ? countRunTool(state, tool.runId, tool.input) : null;
    if (event) {
      const journal = toolsFile(config, event.runId);
      const freshDirectory = !existsSync(path.dirname(journal));
      ensurePrivateDirSync(path.dirname(journal));
      const fresh = !existsSync(journal);
      const fd = openSync(journal, "a", 0o600);
      const line = JSON.stringify(event) + "\n";
      try { writeFileSync(fd, line); }
      finally { closeSync(fd); }
      if (fresh) {
        const directory = openSync(path.dirname(journal), "r");
        try { fsyncSync(directory); } finally { closeSync(directory); }
      }
      if (freshDirectory) {
        const directory = openSync(config.dataDir, "r");
        try { fsyncSync(directory); } finally { closeSync(directory); }
      }
      if (changed) state.runs[event.runId].toolOffset += Buffer.byteLength(line);
    }
    if (!changed) return event ?? result;
    if (tool) {
      // Every active offset enters this snapshot, so syncing only this tool's journal can lose another run's counts.
      for (const run of Object.values(state.runs)) {
        const fd = openSync(toolsFile(config, run.run_id), "r");
        try { fsyncSync(fd); } finally { closeSync(fd); }
      }
    }
    ensurePrivateDirSync(config.dataDir);
    const temporary = `${file}.tmp.${process.pid}.${randomUUID()}`;
    const fd = openSync(temporary, "wx", 0o600);
    try {
      writeFileSync(fd, JSON.stringify(state));
      fsyncSync(fd);
      renameSync(temporary, file);
      const dir = openSync(config.dataDir, "r");
      try { fsyncSync(dir); } finally { closeSync(dir); }
    } finally {
      closeSync(fd);
      try { unlinkSync(temporary); } catch (error) { if (error.code !== "ENOENT") throw error; }
    }
    return result;
  });
}

export async function accountForRun(config, update, options) {
  if (!config.runReportingEnabled) return;
  try { return await withRunState(config, update, options); }
  catch { process.stderr.write("[armorcodex] run accounting not saved\n"); }
}

export function isRootRunHook(input) {
  return !input.parent_session_id && !input.is_subagent &&
    (!input.root_session_id || input.root_session_id === input.session_id);
}

function runToolDisposition(name) {
  const normalized = normalizeToolName(name);
  const rule = RUNS.capability.rules.find(({ patterns }) => patterns.some((pattern) => new RegExp(pattern).test(normalized)));
  return { counted: rule.counted, gated: rule.gated };
}

function alive(pid) {
  try { process.kill(pid, 0); return true; } catch (error) {
    if (error.code === "ESRCH") return false;
    if (error.code === "EPERM") return true;
    throw error;
  }
}

function noPlanReason(run) {
  if (run.plan_ids.length) return undefined;
  const attempts = Object.values(run.registrations);
  const applies = {
    monitor_mode: run.mode === "monitor",
    no_tool_use: run.tool_calls === 0,
    read_only: run.gated_tool_calls === 0,
    backend_unreachable: run.backendUnreachable,
    request_failed: attempts.length > 0 && attempts.every(({ status }) => status === "failed"),
    plan_rejected: attempts.some(({ status }) => status === "rejected"),
    not_registered: run.gated_tool_calls > 0 && attempts.length === 0
  };
  return RUNS.noPlanReasons.find((reason) => applies[reason]);
}

function queueReport(state, run, final = false) {
  if (!run.login) return;
  const report = {
    run_id: run.run_id, report_seq: run.report_seq, session_id: run.session_id,
    started_at: run.started_at, tool_calls: run.tool_calls,
    gated_tool_calls: run.gated_tool_calls, plan_ids: [...run.plan_ids],
    ...(final ? run.closing : {})
  };
  if (final) {
    const reason = noPlanReason(run);
    if (reason) report.no_plan_reason = reason;
  }
  state.runReports.push({ report, login: run.login });
}

function finishRun(state, run) {
  if (!run.closing || run.journalUnavailable || Object.values(run.registrations).some(({ status }) => status === "pending")) return;
  run.report_seq += 1;
  // The close and report receipt share one run state commit, so a crash cannot lose the final report.
  queueReport(state, run, true);
  delete state.runs[run.run_id];
}

function settleAbandonedRequests(run) {
  for (const attempt of Object.values(run.registrations)) {
    if (attempt.status === "pending" && (!alive(attempt.pid) || Date.now() >= attempt.deadlineAt)) attempt.status = "failed";
  }
}

export function closeRun(state, runId, endReason) {
  const run = state.runs[runId];
  if (!run) return;
  if (!RUNS.endReasons.includes(endReason)) throw new Error("Invalid run end reason");
  run.closing ??= { ended_at: new Date(Math.max(Date.now(), Date.parse(run.started_at))).toISOString(), end_reason: endReason };
  settleAbandonedRequests(run);
  finishRun(state, run);
}

export function startRun(state, sessionId, session, config) {
  if (!config.runReportingEnabled) return;
  state.startedRuns ??= Object.fromEntries(Object.keys(state.runs).map((id) => [id, true]));
  for (const context of session.runStarts ?? []) {
    const archived = archivedStart(config, context.run_id);
    if (archived) {
      if (archived.context === true) storeArchive(startArchiveFile(config, context.run_id), JSON.stringify({ run_id: context.run_id, context }));
      continue;
    }
    if (!state.startedRuns[context.run_id]) {
      const run = { ...context, report_seq: 1, tool_calls: 0, gated_tool_calls: 0,
        plan_ids: [], toolIds: [], registrations: {}, backendUnreachable: false };
      delete run.closing;
      state.runs[run.run_id] = run;
      const journal = toolsFile(config, run.run_id);
      if (!existsSync(journal)) storeArchive(journal, "");
      replayRunTools(config, run);
      queueReport(state, { ...run, tool_calls: 0, gated_tool_calls: 0 });
    }
    state.startedRuns[context.run_id] = context;
    if (context.closing && state.runs[context.run_id]) {
      state.runs[context.run_id].closing ??= context.closing;
      closeRun(state, context.run_id, context.closing.end_reason);
    }
  }
}

export function prepareRun(sessionId, session, config) {
  if (!config.runReportingEnabled || !session.promptId || session.runId === session.promptId) return;
  const previous = session.runStarts?.find(({ run_id }) => run_id === session.runId);
  if (previous) previous.closing ??= { ended_at: new Date(Date.now()).toISOString(), end_reason: "next_prompt" };
  session.runId = session.promptId;
  if (!Object.hasOwn(session, "runOwner")) session.runOwner = harnessProcess();
  session.runStarts ??= [];
  session.runStarts = session.runStarts.filter((context, index, all) =>
    index >= all.length - 1 || !hasArchivedContext(config, context));
  session.runStarts.push({ run_id: session.runId, session_id: sessionId,
    started_at: new Date(session.promptStartedAt).toISOString(), login: auditLogin(config),
    mode: config.mode, owner: session.runOwner, lastActivityAt: Date.now() });
}

export function countRunTool(state, runId, input) {
  const run = state.runs[runId];
  if (!run || run.closing || run.journalUnavailable || !isRootRunHook(input) || !input.tool_name) return;
  const { counted, gated } = runToolDisposition(input.tool_name);
  if (!counted || (input.tool_use_id && run.toolIds.includes(input.tool_use_id))) return;
  if (input.tool_use_id) run.toolIds.push(input.tool_use_id);
  run.tool_calls += 1;
  if (gated) run.gated_tool_calls += 1;
  run.lastActivityAt = Date.now();
  return { runId, id: input.tool_use_id, gated, at: run.lastActivityAt };
}

export function recordRunRegistration(state, runId, key, status, { previousKey, planId, kind, backendUnreachable = false, deadlineAt = Date.now() + 40000 } = {}) {
  const run = state.runs[runId];
  if (!run) return;
  if (previousKey && previousKey !== key) delete run.registrations[previousKey];
  if (run.registrations[key]?.status === "confirmed") return;
  run.registrations[key] = { status, pid: process.pid, deadlineAt, ...(planId ? { planId, kind } : {}) };
  if (backendUnreachable) run.backendUnreachable = true;
  if (status === "confirmed" && kind !== "refresh" && planId && !run.plan_ids.includes(planId)) {
    if (run.plan_ids.length < RUNS.limits.maxPlanIds) run.plan_ids.push(planId);
  }
  finishRun(state, run);
}

export function markRunUnreachable(state, runId) {
  if (state.runs[runId]) state.runs[runId].backendUnreachable = true;
}

export function recoverRuns(state, sessionId, source) {
  for (const run of Object.values(state.runs)) {
    const currentOwner = run.owner?.startedAt ? processInfo(run.owner.pid) : null;
    const abandoned = (run.session_id === sessionId && (!source || ["startup", "resume"].includes(source))) ||
      (run.owner && (!alive(run.owner.pid) || (currentOwner && currentOwner.startedAt !== run.owner.startedAt))) ||
      (!run.owner && Date.now() - (run.lastActivityAt ?? Date.parse(run.started_at)) >= 30 * 60_000);
    if (abandoned) closeRun(state, run.run_id, "recovered");
  }
}

export async function publishRunReports(config) {
  await accountForRun(config, async (state) => {
    for (const run of Object.values(state.runs)) {
      if (run.closing) {
        settleAbandonedRequests(run);
        finishRun(state, run);
      }
    }
    const wal = createAuditWal({ dataDir: config.dataDir, config, stream: "runs" });
    for (const { report, login } of state.runReports) await wal.appendLine(report, { binding: login });
    // Retain receipts until the outbox append commits; replay uses the same run id and sequence.
    state.runReports = [];
  });
}
