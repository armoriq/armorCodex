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

export function runStateWarnings(config) {
  try { return readdirSync(config.dataDir).filter((name) => name.startsWith("run-state-v1.json.corrupt.")).length; }
  catch (error) { if (error.code === "ENOENT") return 0; throw error; }
}

function replayTools(config, run) {
  let raw;
  try { raw = readFileSync(toolsFile(config, run.run_id)); }
  catch (error) { if (error.code === "ENOENT") return; throw error; }
  const end = raw.lastIndexOf(0x0a) + 1;
  const seen = new Set(run.toolIds);
  for (const line of raw.subarray(run.toolOffset ?? 0, end).toString("utf8").split("\n").filter(Boolean)) {
    const event = JSON.parse(line);
    if (event.id && seen.has(event.id)) continue;
    run.tool_calls += 1;
    if (event.gated) run.gated_tool_calls += 1;
    if (event.id) { seen.add(event.id); run.toolIds.push(event.id); }
    run.lastActivityAt = Math.max(run.lastActivityAt ?? 0, event.at);
  }
  run.toolOffset = end;
}

export async function withRunState(config, update, { toolJournal = false } = {}) {
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
    for (const run of Object.values(state.runs)) replayTools(config, run);
    const before = JSON.stringify(state);
    const result = await update(state);
    if (JSON.stringify(state) === before) return result;
    if (toolJournal && result) {
      const journal = toolsFile(config, result.runId);
      const freshDirectory = !existsSync(path.dirname(journal));
      ensurePrivateDirSync(path.dirname(journal));
      const fresh = !existsSync(journal);
      const fd = openSync(journal, "a", 0o600);
      try { writeFileSync(fd, JSON.stringify(result) + "\n"); fsyncSync(fd); }
      finally { closeSync(fd); }
      if (fresh) {
        const directory = openSync(path.dirname(journal), "r");
        try { fsyncSync(directory); } finally { closeSync(directory); }
      }
      if (freshDirectory) {
        const directory = openSync(config.dataDir, "r");
        try { fsyncSync(directory); } finally { closeSync(directory); }
      }
      return result;
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
  if (!run.closing || Object.values(run.registrations).some(({ status }) => status === "pending")) return;
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
    if (!state.startedRuns[context.run_id]) {
      const run = { ...context, report_seq: 1, tool_calls: 0, gated_tool_calls: 0,
        plan_ids: [], toolIds: [], registrations: {}, backendUnreachable: false };
      delete run.closing;
      state.runs[run.run_id] = run;
      state.startedRuns[run.run_id] = true;
      replayTools(config, run);
      queueReport(state, { ...run, tool_calls: 0, gated_tool_calls: 0 });
    }
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
  session.runStarts.push({ run_id: session.runId, session_id: sessionId,
    started_at: new Date(session.promptStartedAt).toISOString(), login: auditLogin(config),
    mode: config.mode, owner: session.runOwner, lastActivityAt: Date.now() });
}

export function countRunTool(state, runId, input) {
  const run = state.runs[runId];
  if (!run || run.closing || !isRootRunHook(input) || !input.tool_name) return;
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

export async function markRunUnreachable(config, runId) {
  await accountForRun(config, (state) => {
    if (state.runs[runId]) state.runs[runId].backendUnreachable = true;
  });
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
