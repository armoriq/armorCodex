/**
 * armorCodex observability bridge — additive, fail-open. "Model A" (Design 2:
 * per-plan via disk).
 *
 * armorCodex has NO daemon: every hook event spawns a fresh short-lived `node
 * scripts/hook-router.mjs` process. Two hard SDK/backend facts rule out the
 * armorClaude daemon-resident approach (module-level Map of live
 * ObservabilityRecorders):
 *
 *   1. `ObservabilityRecorder` is an in-memory ring buffer that lives inside
 *      ONE process. `startTrace` always mints a brand-new trace id, and
 *      `recordSpan`/`endTrace` silently no-op for any traceId not already in
 *      that process's buffer (recorder.ts `bufferIndex.get(...)` miss). A
 *      recorder constructed fresh in hook process N+1 has never heard of the
 *      trace hook process N started — there is no way to "resume" it.
 *   2. The backend's `ObservabilityService.recordBatches` does an
 *      `obsTrace.create` (not upsert) inside a transaction. POSTing the same
 *      trace id twice throws a duplicate-key error and rolls back that
 *      batch's spans. So spans for one logical turn/plan can NEVER be shipped
 *      as multiple separate POSTs under the same trace id — the whole trace +
 *      all its spans must ship in exactly one POST.
 *
 * So instead of holding a live recorder across hooks, we persist the
 * accumulating trace (id + attributes + spans-so-far) to a small JSON file
 * under `config.dataDir`, one file per active turn:
 *
 *   <dataDir>/obs-trace.<sessionId>.json
 *
 * - First hook of a turn (UserPromptSubmit, or PreToolUse if no active trace
 *   file exists yet — Codex hook set has no explicit "turn start" event other
 *   than UserPromptSubmit) mints ONE trace id + writes the file.
 * - Every subsequent hook (PreToolUse/PermissionRequest/PostToolUse) appends
 *   pre-minted span objects (with correct parentSpanId linkage) to that file
 *   via the existing atomic fs-store (write-tmp -> rename) — no network I/O.
 * - On `Stop` (the turn boundary Codex fires every turn — there is no
 *   SessionEnd-per-turn signal, and no PostToolUseFailure event at all, so
 *   PostToolUse derives success/error itself from `tool_response`/`error`),
 *   we read the file, feed the complete (trace, spans) into a FRESH
 *   short-lived `ObservabilityRecorder` in this one process, end the trace
 *   (which enqueues it on the recorder's shipper), explicitly `flush()`, and
 *   `await` that flush to completion before deleting the file — because a
 *   short-lived hook process has no background timer that will ever fire.
 * - Codex has no SessionEnd hook at all; GC of stale trace files (e.g. a
 *   session that crashed mid-turn and never fired Stop) happens opportunistically
 *   on the next SessionStart.
 *
 * NOTHING here may throw into a hook: every emission goes through
 * safeObsAsync() (everything in this module does disk or network I/O, so
 * there is no synchronous variant to wrap).
 */
import armoriqSdk from "@armoriq/sdk";
import { sanitizeParams, redactSecrets } from "./common.mjs";
import { readJson, writeJson } from "./fs-store.mjs";
import { readdir, unlink, stat } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

const {
  ObservabilityRecorder,
  startTrace,
  recordSpan,
  endTrace,
  flushObservability,
  isValidUuid,
} = armoriqSdk;

// A trace file older than this is considered abandoned (crashed session,
// missed Stop) and is garbage-collected on the next SessionStart rather than
// shipped — shipping a partial/stale trace hours later would be confusing on
// the dashboard, and the turn it belonged to is long gone.
const STALE_TRACE_MAX_AGE_MS = 6 * 60 * 60 * 1000; // 6 hours

async function safeObsAsync(fn) {
  try {
    return await fn();
  } catch (err) {
    if (process.env.ARMORCODEX_DEBUG) {
      process.stderr.write(`[armorcodex-obs] ${err?.message ?? err}\n`);
    }
    return undefined;
  }
}

export function isObsEnabled(config) {
  return Boolean(config && config.observabilityEnabled);
}

function tracePath(config, sessionId) {
  return path.join(config.dataDir, `obs-trace.${sessionId}.json`);
}

function mintId() {
  return randomUUID();
}

function nowIso() {
  return new Date().toISOString();
}

// ---------------------------------------------------------------------------
// Disk trace record shape:
// {
//   traceId, sessionId, name, startTime, startTimeMs, attributes,
//   spans: SpanRecord[], createdAtEpochMs
// }
// ---------------------------------------------------------------------------

async function loadTraceFile(config, sessionId) {
  return readJson(tracePath(config, sessionId), null);
}

async function saveTraceFile(config, sessionId, trace) {
  await writeJson(tracePath(config, sessionId), trace);
}

async function deleteTraceFile(config, sessionId) {
  await unlink(tracePath(config, sessionId)).catch(() => {});
}

function newTraceRecord(sessionId, attrs) {
  const sid = isValidUuid && isValidUuid(sessionId) ? sessionId : null;
  const startTimeMs = Date.now();
  return {
    traceId: mintId(),
    sessionId: sid,
    name: "iap.plan",
    startTime: new Date(startTimeMs).toISOString(),
    startTimeMs,
    attributes: attrs || {},
    spans: [],
    createdAtEpochMs: startTimeMs,
  };
}

function classifyDecision(output) {
  const d = output && output.hookSpecificOutput && output.hookSpecificOutput.permissionDecision;
  if (d === "deny") return "deny";
  const behaviorDeny =
    output && output.hookSpecificOutput && output.hookSpecificOutput.decision;
  if (behaviorDeny === "deny") return "deny";
  return "allow";
}

// ---------------------------------------------------------------------------
// Per-hook: ensure/mint the turn's trace file, append span(s), never POST.
// ---------------------------------------------------------------------------

async function obsStartPlan(sessionId, config, prompt) {
  const { prompt: sanitizedInput } = sanitizeParams({ prompt }, config.sanitize);
  const trace = newTraceRecord(sessionId, {
    source: "codex",
    input: sanitizedInput ?? null,
  });
  const startSpan = {
    id: mintId(),
    parentSpanId: null,
    sessionId: trace.sessionId,
    kind: "span",
    name: "iap.plan.start",
    startTime: nowIso(),
    endTime: nowIso(),
    durationMs: 0,
    status: "ok",
    attributes: { kind: "span", ...sanitizeParams({ prompt }, config.sanitize) },
  };
  trace.spans.push(startSpan);
  await saveTraceFile(config, sessionId, trace);
}

async function ensureTraceFile(sessionId, config) {
  let trace = await loadTraceFile(config, sessionId);
  if (!trace) {
    trace = newTraceRecord(sessionId, { source: "codex", lazy: true });
    await saveTraceFile(config, sessionId, trace);
  }
  return trace;
}

async function obsCheck(sessionId, config, toolName, toolInput, output) {
  const trace = await ensureTraceFile(sessionId, config);
  const decision = classifyDecision(output);
  const status = decision === "deny" ? "denied" : "ok";
  const reason =
    (output && output.hookSpecificOutput && output.hookSpecificOutput.permissionDecisionReason) ||
    (output && typeof output.reason === "string" ? output.reason : null);

  const checkSpanId = mintId();
  const checkStart = nowIso();
  const policySpan = {
    id: mintId(),
    parentSpanId: checkSpanId,
    sessionId: trace.sessionId,
    kind: "policy_call",
    name: `armorcodex.${decision}`,
    startTime: checkStart,
    endTime: nowIso(),
    durationMs: 0,
    status: decision === "allow" ? "ok" : "denied",
    attributes: {
      kind: "policy_call",
      policyId: null,
      policyName: null,
      policyHash: null,
      policyVersion: null,
      decision,
      matchedRuleId: null,
      dataClasses: [],
      reason: reason ?? null,
      input: sanitizeParams(toolInput, config.sanitize),
      output: null,
      source: "sdk",
      enforcementAction: decision === "deny" ? "block" : "allow",
      obligations: null,
      delegationId: null,
    },
  };
  const checkSpan = {
    id: checkSpanId,
    parentSpanId: null,
    sessionId: trace.sessionId,
    kind: "span",
    name: "iap.check",
    startTime: checkStart,
    endTime: nowIso(),
    durationMs: 0,
    status,
    attributes: { kind: "span", toolName: toolName || undefined },
  };
  trace.spans.push(checkSpan, policySpan);
  await saveTraceFile(config, sessionId, trace);
}

async function obsReport(sessionId, config, toolName, toolInput, toolResponse, status) {
  const trace = await ensureTraceFile(sessionId, config);
  const span = {
    id: mintId(),
    parentSpanId: null,
    sessionId: trace.sessionId,
    kind: "span",
    name: "tool.report",
    startTime: nowIso(),
    endTime: nowIso(),
    durationMs: 0,
    status: status || "ok",
    attributes: {
      kind: "span",
      toolName: toolName || undefined,
      input: sanitizeParams(toolInput, config.sanitize),
      output: redactSecrets(sanitizeParams(toolResponse, config.sanitize)),
    },
  };
  trace.spans.push(span);
  await saveTraceFile(config, sessionId, trace);
}

// ---------------------------------------------------------------------------
// Stop: assemble + ship the COMPLETE trace exactly once, then delete the file.
// ---------------------------------------------------------------------------

async function obsEndTurnAndShip(sessionId, config) {
  const trace = await loadTraceFile(config, sessionId);
  if (!trace) return; // no hooks fired for this turn (e.g. no tool use) — nothing to ship

  // Fresh recorder scoped to this one short-lived process. Its ring buffer
  // and shipper live only as long as this function runs — we start a trace,
  // replay every disk-accumulated span into it, end the trace (which enqueues
  // it on the shipper), and explicitly await flush() before returning. There
  // is no background 5s timer in a ~50ms hook process, so the flush MUST be
  // awaited here or the batch is silently lost when the process exits.
  const recorder = new ObservabilityRecorder({
    enabled: true,
    endpoint: config.observabilityEndpoint,
    apiKey: config.apiKey,
    product: config.observabilityProduct,
    sessionId: trace.sessionId,
    userId: isValidUuid && isValidUuid(config.userId) ? config.userId : null,
    agentId: config.agentId || null,
    // Disable the periodic timer entirely — we drive flush() explicitly and
    // don't want an unref'd interval outliving the one flush we need.
    flushIntervalMs: 24 * 60 * 60 * 1000,
  });

  // `startTrace` mints a NEW trace id (the recorder is the only place ids are
  // minted) — the disk-persisted `trace.traceId` was only ever a same-process
  // correlation handle across the accumulation phase; it never left this
  // machine and was never sent anywhere, so re-minting here (matching the
  // SDK's "recorder owns id minting" invariant) is safe and simpler than
  // trying to force a specific id through the public API.
  const ctx = startTrace(recorder, trace.name, trace.attributes, trace.sessionId);

  for (const span of trace.spans) {
    // Re-home each disk-accumulated span under the freshly-minted trace id
    // (parentSpanId links between sibling spans are unaffected — those ids
    // were minted once, up front, when each span was created, and are
    // preserved verbatim from disk).
    recordSpan(recorder, ctx, { ...span, sessionId: ctx.sessionId });
  }

  endTrace(recorder, ctx, { status: "ok" });
  await flushObservability(recorder);
  await deleteTraceFile(config, sessionId);
}

// ---------------------------------------------------------------------------
// SessionStart: GC stale obs-trace.*.json files left behind by turns that
// never reached Stop (crash, kill -9, etc). Codex has no per-session
// SessionEnd, so this is the only natural GC point.
// ---------------------------------------------------------------------------

async function gcStaleTraceFiles(config) {
  let names;
  try {
    names = await readdir(config.dataDir);
  } catch {
    return;
  }
  const now = Date.now();
  for (const name of names) {
    if (!name.startsWith("obs-trace.") || !name.endsWith(".json")) continue;
    const full = path.join(config.dataDir, name);
    try {
      const st = await stat(full);
      if (now - st.mtimeMs > STALE_TRACE_MAX_AGE_MS) {
        await unlink(full).catch(() => {});
      }
    } catch {
      // file vanished between readdir and stat — fine, ignore
    }
  }
}

// ---------------------------------------------------------------------------
// Public entrypoint — hook-router calls this after computing the decision.
// ---------------------------------------------------------------------------

export async function observeHook(event, input, output, config) {
  if (!isObsEnabled(config)) return;
  const sessionId = typeof input?.session_id === "string" ? input.session_id : "";
  if (!sessionId && event !== "SessionStart") return;

  await safeObsAsync(async () => {
    switch (event) {
      case "SessionStart":
        await gcStaleTraceFiles(config);
        break;
      case "UserPromptSubmit":
        await obsStartPlan(sessionId, config, typeof input.prompt === "string" ? input.prompt : "");
        break;
      case "PreToolUse":
        await obsCheck(
          sessionId,
          config,
          typeof input.tool_name === "string" ? input.tool_name : "",
          input.tool_input,
          output
        );
        break;
      case "PermissionRequest":
        await obsCheck(
          sessionId,
          config,
          typeof input.tool_name === "string" ? input.tool_name : "",
          input.tool_input,
          output
        );
        break;
      case "PostToolUse": {
        // Codex has no PostToolUseFailure event; derive success/error from
        // the hook payload itself.
        const hasError =
          typeof input.error === "string" && input.error.length > 0;
        const responseLooksError =
          input.tool_response &&
          typeof input.tool_response === "object" &&
          (input.tool_response.error || input.tool_response.is_error === true);
        const status = hasError || responseLooksError ? "error" : "ok";
        await obsReport(
          sessionId,
          config,
          input.tool_name,
          input.tool_input,
          input.tool_response,
          status
        );
        break;
      }
      case "Stop":
        // Turn boundary: assemble the complete trace from disk and ship it
        // ONCE. Must be awaited to completion — this process has no
        // background timer to finish the job after we return.
        await obsEndTurnAndShip(sessionId, config);
        break;
      default:
        break;
    }
  });
}

export async function __resetObsForTests() {
  // No module-level state to reset (everything lives on disk per-session);
  // kept for parity with armorClaude's test surface.
}
