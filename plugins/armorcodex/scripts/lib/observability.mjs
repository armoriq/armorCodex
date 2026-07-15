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
 * accumulating turn as an APPEND-ONLY NDJSON LOG under `config.dataDir`, one
 * file per active turn:
 *
 *   <dataDir>/obs-turn.<sha256(sessionId)>.ndjson
 *
 * WHY APPEND-ONLY NDJSON INSTEAD OF READ-MODIFY-WRITE JSON (race analysis):
 *
 * The original design read the whole trace file, pushed one span into the JS
 * array in memory, and wrote the whole file back out (atomically, via
 * write-tmp+rename in fs-store.writeJson). The rename step is atomic, but the
 * READ...MODIFY...WRITE *cycle* is not: two hook processes overlapping in
 * time (e.g. a fast PreToolUse immediately followed by PostToolUse of a
 * *previous* tool call, or two tool calls the agent issued back-to-back) can
 * both read the same on-disk snapshot before either has written back. Each
 * appends its own span to its own in-memory copy and writes; whichever
 * rename() lands second silently clobbers the first process's entire write —
 * including that first process's span. The span is not queued, not retried,
 * not logged anywhere: it is simply gone, and the shipped trace is missing a
 * span the dashboard should have shown. There is no lock protecting the
 * read...write cycle, so nothing prevents this interleaving.
 *
 * An append-only log sidesteps the problem entirely by removing the READ
 * step from the accumulation path. Every hook process, independent of any
 * other, does exactly one thing: open the turn's log file with O_APPEND and
 * write one line (one `fs.write()` syscall). POSIX guarantees that a single
 * `write()` to a file opened O_APPEND is atomic with respect to the file's
 * end-of-file offset: the kernel serializes concurrent writers' write()
 * calls, and each write lands as a contiguous, non-interleaved run of bytes
 * at whatever the current end-of-file is at the moment the kernel services
 * that call. Two processes racing to append never tear each other's bytes
 * and never lose a write — there is no "last write wins" because there is no
 * shared snapshot being overwritten, only monotonic appends. This is the
 * same guarantee production log shippers rely on for concurrent-writer log
 * files. To stay safely within the size any single write() will actually
 * perform as one atomic operation (well under the historical 4KB/PIPE_BUF
 * ballpark), every span's attributes are capped (see `capAttributes` below)
 * before being serialized — oversized fields are truncated with a
 * `<truncated>` marker rather than silently growing a line past the
 * safe-append boundary. `fs-store.appendNdjsonLine` throws if a line would
 * exceed that cap even after capping (defense in depth — should not happen
 * given the cap sizes below), and the caller is wrapped in `safeObsAsync` so
 * that throw degrades to "this one span didn't record" rather than crashing
 * the hook.
 *
 * Each line is one self-describing JSON record — `{ recordType: "meta", ... }`
 * for turn-level metadata (trace name/attributes/startTime), written once by
 * whichever hook starts the turn, or `{ recordType: "span", span: {...} }`
 * for each span. Because every line is independent, `Stop` reconstructs the
 * whole trace by reading every line and doesn't need any single writer to
 * have "won" — every writer's line survives.
 *
 * ON `Stop` (turn boundary): rename-before-read. The log is renamed
 * (`obs-turn.<sessionId>.ndjson` -> `obs-turn.<sessionId>.ndjson.shipping`)
 * BEFORE it is opened for reading. This one atomic filesystem op is what
 * fixes the two MEDIUM findings that share the same root cause as the span
 * race:
 *
 *   (a) Stop-vs-last-PostToolUse: without the rename, Stop could read the
 *       file while a straggling PostToolUse from the same turn is still
 *       mid-append, ship a trace missing that last span, and then delete the
 *       file — orphaning nothing (append already landed) but the shipped
 *       trace is short one span, OR (worse, pre-fix) Stop's delete could race
 *       a straggler's read-modify-write and resurrect/corrupt state. With the
 *       rename: the straggling PostToolUse's `open(..., O_APPEND|O_CREAT)`
 *       against the ORIGINAL path either (i) lands before the rename, in
 *       which case its bytes are safely inside the file Stop is about to
 *       process, or (ii) lands after the rename, in which case it
 *       transparently creates a brand-new empty file at the original path
 *       (O_CREAT) and appends to that — Stop already claimed and is
 *       processing the OLD file under its `.shipping` name, so there is no
 *       interleaving possible between "Stop is reading this exact inode" and
 *       "a hook is appending to this exact inode". The straggler's span ends
 *       up orphaned in a fresh same-name file rather than corrupting the
 *       trace Stop ships — see residual edge case below.
 *   (b) out-of-order Stop vs next turn's UserPromptSubmit: because the
 *       rename gives Stop exclusive ownership of the inode it saw, a
 *       late-arriving Stop from turn N cannot collide with turn N+1's
 *       UserPromptSubmit, which always starts from "no file at the turn's
 *       path" (ENOENT) and creates a fresh one. The turn boundary is the
 *       session-scoped filename plus this rename-claim, not any ordering
 *       assumption about hook delivery.
 *
 * After the rename, Stop reads every line from the `.shipping` file, feeds
 * the complete (trace, spans) into a FRESH short-lived `ObservabilityRecorder`
 * in this one process, ends the trace (enqueues it on the shipper), and
 * `await`s `flush()` to completion before deleting the `.shipping` file —
 * because a short-lived hook process has no background timer that will ever
 * fire.
 *
 * Codex has no SessionEnd hook at all; GC of stale `.ndjson`/`.shipping`
 * files left behind by a crashed session (never reached Stop, or crashed
 * between rename and delete) happens opportunistically on the next
 * SessionStart.
 *
 * RESIDUAL EDGE CASE (documented, not eliminated): if a hook process for
 * turn N is delayed (e.g. descheduled by the OS) long enough that it appends
 * to the ORIGINAL path *after* Stop has already renamed-claimed, read, and
 * shipped that file, that straggler's `open(O_CREAT|O_APPEND)` recreates a
 * new file at the original path and its span lands in it. That new file is
 * indistinguishable from "the start of turn N+1", so either: (i) it is
 * picked up as trace metadata/spans for whatever turn actually starts next
 * (a stray extra span attributed to the wrong turn), or (ii) if no further
 * turn happens in this session, it sits until GC'd by SESSION_START's stale
 * file sweep. We accept this rather than adding cross-process coordination
 * for an out-of-order-delivery case Codex's hook model does not actually
 * produce in practice (Stop is emitted after the model turn's tool calls are
 * done, not concurrently with them) — engineering a fix for it would require
 * either a lock Stop holds for the file's entire lifetime (defeating the
 * lock-free append design that fixes the actual, confirmed bug) or a
 * generation counter in the filename that every hook would need to agree on
 * out-of-band. Both are disproportionate to a race that requires hook
 * delivery to be delayed past the NEXT turn's Stop, which nothing in the
 * Codex hook contract does today.
 *
 * NOTHING here may throw into a hook: every emission goes through
 * safeObsAsync() (everything in this module does disk or network I/O, so
 * there is no synchronous variant to wrap).
 */
import armoriqSdk from "@armoriq/sdk";
import { sanitizeParams, redactSecrets, sha256Hex } from "./common.mjs";
import { summarizeCodexTurnUsage } from "./token-usage.mjs";
import {
  appendNdjsonLine,
  readNdjsonLines,
  renameIfExists,
} from "./fs-store.mjs";
import { readdir, unlink, stat } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

const {
  ObservabilityRecorder,
  startTrace,
  recordSpan,
  recordGeneration,
  endTrace,
  flushObservability,
  isValidUuid,
} = armoriqSdk;

// A trace file older than this is considered abandoned (crashed session,
// missed Stop) and is garbage-collected on the next SessionStart rather than
// shipped — shipping a partial/stale trace hours later would be confusing on
// the dashboard, and the turn it belonged to is long gone.
const STALE_TRACE_MAX_AGE_MS = 6 * 60 * 60 * 1000; // 6 hours

// Per-line attribute size cap. Obs input/output/tool-args are meant to be
// concise, non-sensitive summaries (see common.mjs sanitizeParams, which
// already caps individual string fields at config.sanitize.maxChars, default
// 2000) — this is a SECOND, coarser cap on the serialized size of the whole
// attributes object, enforced right before writing an NDJSON line, so one
// line can never grow past what a single append can still atomically write.
// Comfortably under fs-store.NDJSON_APPEND_SAFE_BYTES to leave headroom for
// the envelope (id/kind/timestamps/etc) wrapped around attributes.
const MAX_ATTRIBUTES_JSON_BYTES = 2800;

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

function turnLogPath(config, sessionId) {
  return path.join(config.dataDir, `obs-turn.${sha256Hex(sessionId)}.ndjson`);
}

function shippingPath(config, sessionId) {
  return `${turnLogPath(config, sessionId)}.shipping`;
}

function mintId() {
  return randomUUID();
}

function nowIso() {
  return new Date().toISOString();
}

const SENSITIVE_ATTRIBUTE_KEYS = new Set([
  "apikey",
  "authorization",
  "clientsecret",
  "password",
  "passwd",
  "privatekey",
  "pwd",
  "secret",
  "token",
]);

function isSensitiveAttributeKey(key) {
  const normalized = key.replace(/[^a-z0-9]/gi, "").toLowerCase();
  if (SENSITIVE_ATTRIBUTE_KEYS.has(normalized)) return true;
  return ["apikey", "authorization", "password", "passwd", "privatekey", "secret", "token"]
    .some((suffix) => normalized.endsWith(suffix));
}

function redactSensitiveAttributeFields(value) {
  if (typeof value === "string") return redactSecrets(value);
  if (value == null || typeof value !== "object") return value;
  if (Array.isArray(value)) {
    return value.map((entry) => redactSensitiveAttributeFields(entry));
  }
  const out = {};
  for (const [key, entry] of Object.entries(value)) {
    out[key] = isSensitiveAttributeKey(key)
      ? "<redacted>"
      : redactSensitiveAttributeFields(entry);
  }
  return out;
}

function redactObservabilitySecrets(value) {
  return redactSensitiveAttributeFields(value);
}

// Cap the JSON-serialized size of a span's attributes object so the whole
// NDJSON line stays inside the atomic-append-safe size. Truncates by
// dropping the largest-serializing keys first (rather than a blunt whole-
// object cut) so structurally important fields (kind/toolName/decision/etc,
// which are small) usually survive and only bulky fields (input/output) get
// clipped or dropped.
function capAttributes(attributes) {
  if (!attributes || typeof attributes !== "object") return attributes;
  let json = JSON.stringify(attributes);
  if (Buffer.byteLength(json, "utf8") <= MAX_ATTRIBUTES_JSON_BYTES) {
    return attributes;
  }
  // Rank keys by serialized size, descending, and progressively clip/drop
  // the largest until the object fits.
  const entries = Object.entries(attributes);
  const sized = entries
    .map(([key, value]) => ({ key, value, size: Buffer.byteLength(JSON.stringify(value) ?? "null", "utf8") }))
    .sort((a, b) => b.size - a.size);

  const out = { ...attributes };
  for (const { key, value, size } of sized) {
    json = JSON.stringify(out);
    if (Buffer.byteLength(json, "utf8") <= MAX_ATTRIBUTES_JSON_BYTES) break;
    if (size <= 64) continue; // small fields aren't worth clipping further
    if (typeof value === "string") {
      out[key] = `${value.slice(0, 200)}<truncated:${value.length}chars>`;
    } else {
      out[key] = "<truncated>";
    }
  }

  json = JSON.stringify(out);
  if (Buffer.byteLength(json, "utf8") <= MAX_ATTRIBUTES_JSON_BYTES) {
    return out;
  }

  // Still too big (e.g. many mid-sized fields): drop non-essential bulky
  // fields entirely rather than risk exceeding the atomic-append cap.
  const essential = new Set(["kind", "toolName", "decision", "status", "reason", "source", "enforcementAction"]);
  const minimal = {};
  for (const [key, value] of Object.entries(out)) {
    if (essential.has(key)) minimal[key] = value;
  }
  minimal.truncated = true;
  return minimal;
}

function capSpan(span) {
  return { ...span, attributes: capAttributes(span.attributes) };
}

// ---------------------------------------------------------------------------
// Disk record shapes (one JSON value per NDJSON line):
//   { recordType: "meta", traceId, sessionId, name, startTime, startTimeMs,
//     attributes, createdAtEpochMs }
//   { recordType: "span", span: SpanRecord }
// ---------------------------------------------------------------------------

function newMetaRecord(sessionId, attrs) {
  const sid = isValidUuid && isValidUuid(sessionId) ? sessionId : null;
  const startTimeMs = Date.now();
  return {
    recordType: "meta",
    traceId: mintId(),
    sessionId: sid,
    name: "iap.plan",
    startTime: new Date(startTimeMs).toISOString(),
    startTimeMs,
    attributes: capAttributes(attrs || {}),
    createdAtEpochMs: startTimeMs,
  };
}

function classifyDecision(output) {
  const d = output && output.hookSpecificOutput && output.hookSpecificOutput.permissionDecision;
  if (d === "deny") return "deny";
  const permissionRequestDecision =
    output && output.hookSpecificOutput && output.hookSpecificOutput.decision;
  if (
    permissionRequestDecision === "deny" ||
    (permissionRequestDecision && permissionRequestDecision.behavior === "deny")
  ) {
    return "deny";
  }
  return "allow";
}

// ---------------------------------------------------------------------------
// Per-hook: append-only. Never reads the log, never blocks on any other
// process — each call is exactly one O_APPEND write (or two, for obsCheck's
// pair of related spans, appended as two independent lines so no single
// line risks exceeding the atomic-append size).
// ---------------------------------------------------------------------------

async function appendMeta(sessionId, config, attrs) {
  const meta = newMetaRecord(sessionId, attrs);
  await appendNdjsonLine(turnLogPath(config, sessionId), meta);
  return meta;
}

async function appendSpan(sessionId, config, span) {
  await appendNdjsonLine(turnLogPath(config, sessionId), {
    recordType: "span",
    span: capSpan(span),
  });
}

async function obsStartPlan(sessionId, config, prompt) {
  const sanitizedPrompt = redactObservabilitySecrets(sanitizeParams({ prompt }, config.sanitize));
  const { prompt: sanitizedInput } = sanitizedPrompt;
  await appendMeta(sessionId, config, { source: "codex", input: sanitizedInput ?? null });
  const startSpan = {
    id: mintId(),
    parentSpanId: null,
    sessionId: isValidUuid && isValidUuid(sessionId) ? sessionId : null,
    kind: "span",
    name: "iap.plan.start",
    startTime: nowIso(),
    endTime: nowIso(),
    durationMs: 0,
    status: "ok",
    attributes: { kind: "span", ...sanitizedPrompt },
  };
  await appendSpan(sessionId, config, startSpan);
}

async function obsCheck(sessionId, config, toolName, toolInput, output) {
  const decision = classifyDecision(output);
  const status = decision === "deny" ? "denied" : "ok";
  const reason =
    (output && output.hookSpecificOutput && output.hookSpecificOutput.permissionDecisionReason) ||
    (output &&
      output.hookSpecificOutput &&
      output.hookSpecificOutput.decision &&
      typeof output.hookSpecificOutput.decision.message === "string"
      ? output.hookSpecificOutput.decision.message
      : null) ||
    (output && typeof output.reason === "string" ? output.reason : null);

  const sid = isValidUuid && isValidUuid(sessionId) ? sessionId : null;
  const checkSpanId = mintId();
  const checkStart = nowIso();
  const policySpan = {
    id: mintId(),
    parentSpanId: checkSpanId,
    sessionId: sid,
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
      reason: redactObservabilitySecrets(reason ?? null),
      input: redactObservabilitySecrets(sanitizeParams(toolInput, config.sanitize)),
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
    sessionId: sid,
    kind: "span",
    name: "iap.check",
    startTime: checkStart,
    endTime: nowIso(),
    durationMs: 0,
    status,
    attributes: { kind: "span", toolName: toolName || undefined },
  };
  // Two independent appends (two lines) rather than one combined write —
  // keeps each line comfortably small and each append is independently
  // atomic; Stop reassembles both from the log regardless of arrival order.
  await appendSpan(sessionId, config, checkSpan);
  await appendSpan(sessionId, config, policySpan);
}

async function obsReport(sessionId, config, toolName, toolInput, toolResponse, status) {
  const sid = isValidUuid && isValidUuid(sessionId) ? sessionId : null;
  const span = {
    id: mintId(),
    parentSpanId: null,
    sessionId: sid,
    kind: "span",
    name: "tool.report",
    startTime: nowIso(),
    endTime: nowIso(),
    durationMs: 0,
    status: status || "ok",
    attributes: {
      kind: "span",
      toolName: toolName || undefined,
      input: redactObservabilitySecrets(sanitizeParams(toolInput, config.sanitize)),
      output: redactObservabilitySecrets(sanitizeParams(toolResponse, config.sanitize)),
    },
  };
  await appendSpan(sessionId, config, span);
}

// ---------------------------------------------------------------------------
// Stop: rename-claim the log, assemble + ship the COMPLETE trace exactly
// once, then delete the claimed (.shipping) file.
// ---------------------------------------------------------------------------

async function obsEndTurnAndShip(sessionId, config, transcriptPath) {
  const livePath = turnLogPath(config, sessionId);
  const claimedPath = shippingPath(config, sessionId);

  // Rename FIRST, before any read. This is the single atomic operation that
  // gives this Stop invocation exclusive ownership of whatever bytes were on
  // disk at this instant. Any hook process still mid-append (or one that
  // starts appending after this instant) is now writing to a brand-new file
  // at `livePath` (O_CREAT) — it can never write into the inode we are about
  // to read, so there is no read-vs-append race window at all, unlike the
  // old read-then-delete sequence.
  const claimed = await renameIfExists(livePath, claimedPath);
  if (!claimed) return; // no hooks fired for this turn (e.g. no tool use) — nothing to ship

  const lines = await readNdjsonLines(claimedPath);

  let meta = null;
  const spans = [];
  for (const record of lines) {
    if (!record || typeof record !== "object") continue;
    if (record.recordType === "meta" && !meta) {
      // First meta record wins (there should only ever be one per turn —
      // UserPromptSubmit or the lazy PreToolUse fallback — but if somehow
      // two landed, e.g. a lazy PreToolUse fallback firing before a
      // just-barely-late UserPromptSubmit, take the earliest).
      meta = record;
    } else if (record.recordType === "span" && record.span) {
      spans.push(record.span);
    }
  }

  if (!meta) {
    // Spans exist but no meta line ever landed (e.g. the process that would
    // have written it crashed after claiming to append but before the append
    // completed — extremely unlikely given O_APPEND atomicity, but degrade
    // gracefully rather than throw). Synthesize a minimal meta so the spans
    // still ship instead of being silently dropped.
    meta = {
      recordType: "meta",
      traceId: mintId(),
      sessionId: isValidUuid && isValidUuid(sessionId) ? sessionId : null,
      name: "iap.plan",
      startTime: nowIso(),
      attributes: { source: "codex", lazy: true, recoveredWithoutMeta: true },
    };
  }

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
    sessionId: meta.sessionId,
    userId: isValidUuid && isValidUuid(config.userId) ? config.userId : null,
    agentId: config.agentId || null,
    // Disable the periodic timer entirely — we drive flush() explicitly and
    // don't want an unref'd interval outliving the one flush we need.
    flushIntervalMs: 24 * 60 * 60 * 1000,
  });

  // `startTrace` mints a NEW trace id (the recorder is the only place ids are
  // minted) — the disk-persisted `meta.traceId` was only ever a same-process
  // correlation handle across the accumulation phase; it never left this
  // machine and was never sent anywhere, so re-minting here (matching the
  // SDK's "recorder owns id minting" invariant) is safe and simpler than
  // trying to force a specific id through the public API.
  const ctx = startTrace(recorder, meta.name, meta.attributes, meta.sessionId);

  for (const span of spans) {
    // Re-home each disk-accumulated span under the freshly-minted trace id
    // (parentSpanId links between sibling spans are unaffected — those ids
    // were minted once, up front, when each span was created, and are
    // preserved verbatim from disk).
    recordSpan(recorder, ctx, { ...span, sessionId: ctx.sessionId });
  }

  // Observability session totals are incremented from generation spans on each
  // trace, so emit this turn's delta rather than Codex's cumulative session
  // snapshot. The legacy /dashboard/token-usage POST remains cumulative and is
  // intentionally handled separately by engine.handleStop.
  for (const entry of summarizeCodexTurnUsage(transcriptPath)) {
    recordGeneration(recorder, ctx, entry);
  }

  endTrace(recorder, ctx, { status: "ok" });
  await flushObservability(recorder);
  await unlink(claimedPath).catch(() => {});
}

// ---------------------------------------------------------------------------
// SessionStart: GC stale obs-turn.*.ndjson[.shipping] files left behind by
// turns that never reached Stop (crash, kill -9, etc), or a .shipping file
// whose process died between rename and delete. Codex has no per-session
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
    const isTurnLog = name.startsWith("obs-turn.") && (name.endsWith(".ndjson") || name.endsWith(".ndjson.shipping"));
    // Also sweep the pre-fix legacy filename in case an upgrade lands mid-
    // session with an old file still on disk.
    const isLegacy = name.startsWith("obs-trace.") && name.endsWith(".json");
    if (!isTurnLog && !isLegacy) continue;
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
        // Turn boundary: rename-claim the log, assemble the complete trace
        // from it, and ship it ONCE. Must be awaited to completion — this
        // process has no background timer to finish the job after we
        // return.
        await obsEndTurnAndShip(sessionId, config, input.transcript_path);
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
