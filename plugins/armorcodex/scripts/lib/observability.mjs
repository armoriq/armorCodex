/** Hooks are separate processes: append one line per span; a read-modify-write drops concurrent hooks' spans. */
import { sanitizeParams, redactSecrets, sha256Hex } from "./common.mjs";
import { codexTurnUsageCalls } from "./token-usage.mjs";
import {
  appendNdjsonLine,
  readNdjsonLines,
  renameIfExists,
} from "./fs-store.mjs";
import { readdir, unlink, stat } from "node:fs/promises";
import path from "node:path";
import { CLIENT } from "./client-identity.mjs";
import { sdkModule } from "./sdk.mjs";


const STALE_TRACE_MAX_AGE_MS = 6 * 60 * 60 * 1000;

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

function capAttributes(attributes) {
  if (!attributes || typeof attributes !== "object") return attributes;
  let json = JSON.stringify(attributes);
  if (Buffer.byteLength(json, "utf8") <= MAX_ATTRIBUTES_JSON_BYTES) {
    return attributes;
  }
  const entries = Object.entries(attributes);
  const sized = entries
    .map(([key, value]) => ({ key, value, size: Buffer.byteLength(JSON.stringify(value) ?? "null", "utf8") }))
    .sort((a, b) => b.size - a.size);

  const out = { ...attributes };
  for (const { key, value, size } of sized) {
    json = JSON.stringify(out);
    if (Buffer.byteLength(json, "utf8") <= MAX_ATTRIBUTES_JSON_BYTES) break;
    if (size <= 64) continue;
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

  const essential = new Set(["toolName", "decision", "outcome", "source"]);
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

function newMetaRecord(attrs) {
  return { recordType: "meta", at: Date.now(), attributes: capAttributes(attrs || {}) };
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

async function appendMeta(sessionId, config, attrs) {
  const meta = newMetaRecord(attrs);
  await appendNdjsonLine(turnLogPath(config, sessionId), meta);
  return meta;
}

async function appendSpan(sessionId, config, span) {
  await appendNdjsonLine(turnLogPath(config, sessionId), {
    recordType: "span",
    span: capSpan({ ...span, at: Date.now() }),
  });
}

async function obsStartPlan(sessionId, config, prompt) {
  const { prompt: sanitizedInput } = redactObservabilitySecrets(
    sanitizeParams({ prompt }, config.sanitize)
  );
  await appendMeta(sessionId, config, { source: "codex", input: sanitizedInput ?? null });
}

async function obsCheck(sessionId, config, toolName, toolInput, output, callId) {
  await appendSpan(sessionId, config, {
    kind: "policy",
    callId,
    attributes: {
      toolName: toolName || undefined,
      decision: classifyDecision(output),
      input: redactObservabilitySecrets(sanitizeParams(toolInput, config.sanitize)),
    },
  });
}

async function obsReport(sessionId, config, toolName, toolInput, toolResponse, status, callId) {
  await appendSpan(sessionId, config, {
    kind: "tool",
    callId,
    attributes: {
      toolName: toolName || undefined,
      outcome: status === "error" ? "error" : "success",
      input: redactObservabilitySecrets(sanitizeParams(toolInput, config.sanitize)),
      output: redactObservabilitySecrets(sanitizeParams(toolResponse, config.sanitize)),
    },
  });
}

const toolCategory = (toolName) =>
  typeof toolName === "string" && toolName.startsWith("mcp__") ? "mcp" : "tool";

const endedAt = (ms) => (Number.isFinite(ms) ? { endTime: new Date(ms) } : undefined);

function toolStartTimes(spans) {
  const starts = new Map();
  for (const span of spans) {
    if (span.kind === "policy" && span.callId && !starts.has(span.callId)) starts.set(span.callId, span.at);
  }
  return starts;
}

async function replaySpan(session, span, toolStarts) {
  const attrs = span.attributes || {};
  const toolName = attrs.toolName || "unknown";
  const call = { toolName, toolCallId: span.callId, arguments: attrs.input };
  if (span.kind === "policy") {
    await session.recordPolicy(call, { decision: attrs.decision === "deny" ? "block" : "allow" }, endedAt(span.at));
  } else if (span.kind === "tool") {
    const startedAt = toolStarts.get(span.callId);
    await session.recordTool(
      { ...call, operation: { category: toolCategory(toolName) } },
      {
        outcome: attrs.outcome === "error" ? "error" : "success",
        result: attrs.output,
        durationMs: Number.isFinite(startedAt) && span.at >= startedAt ? span.at - startedAt : undefined,
      },
      endedAt(span.at)
    );
  }
}

async function replayModel(session, call) {
  const usage = {
    "gen_ai.usage.input_tokens": call.inputTokens,
    "gen_ai.usage.output_tokens": call.outputTokens,
    "gen_ai.usage.cache_read_tokens": call.cacheReadTokens,
    "gen_ai.usage.cache_write_tokens": call.cacheWriteTokens,
  };
  await session.recordModel(call.model, usage, endedAt(call.timestampMs), { spanId: sha256Hex(call.key).slice(0, 16) });
}

function parseTurnLog(lines) {
  let meta = null;
  const spans = [];
  for (const record of lines) {
    if (!record || typeof record !== "object") continue;
    if (record.recordType === "meta" && !meta) {
      meta = record;
    } else if (record.recordType === "span" && record.span) {
      spans.push(record.span);
    }
  }
  return { meta, spans };
}

function turnRoot(meta, spans) {
  const times = [meta?.at, ...spans.map((span) => span.at)].filter(Number.isFinite);
  return times.length ? { startTime: new Date(Math.min(...times)) } : undefined;
}

async function obsEndTurnAndShip(sessionId, config, transcriptPath) {
  const stoppedAt = Date.now();
  const livePath = turnLogPath(config, sessionId);
  const claimedPath = shippingPath(config, sessionId);

  // Rename before reading so a late append lands in a fresh file, never in the one being shipped.
  const claimed = await renameIfExists(livePath, claimedPath);
  if (!claimed) return;

  const { meta, spans } = parseTurnLog(await readNdjsonLines(claimedPath));

  const { ArmorIQTelemetryRuntime, OtelSession } = sdkModule("observability");
  const { VERSION } = sdkModule("_version");
  const runtime = new ArmorIQTelemetryRuntime({
    backendEndpoint: config.observabilityEndpoint,
    apiKey: config.apiKey,
    sdkVersion: typeof VERSION === "string" ? VERSION : "unknown",
    options: { serviceName: config.observabilityProduct || "armorcodex" },
    client: CLIENT,
  });
  const session = new OtelSession(runtime, {
    sessionId,
    agentId: config.agentId || null,
    userId: config.userId || null,
    root: turnRoot(meta, spans),
  });
  // A runtime without a lease records nothing, so wait for it (the SDK bounds the wait).
  await session.refreshPolicy();
  await session.beginRoot({ input: meta?.attributes?.input ?? null });
  let failure = null;
  try {
    const toolStarts = toolStartTimes(spans);
    for (const span of spans) await replaySpan(session, span, toolStarts);
    for (const call of codexTurnUsageCalls(transcriptPath)) await replayModel(session, call);
  } catch (err) {
    failure = err;
    process.stderr.write(`[armorcodex-obs] Stop could not replay the turn: ${err?.message ?? err}\n`);
  }
  await session.close({ status: failure ? "error" : "ok", endTime: new Date(stoppedAt) });
  await unlink(claimedPath).catch(() => {});
}

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

export async function observeHook(event, input, output, config) {
  if (!isObsEnabled(config)) return;
  const sessionId = typeof input?.session_id === "string" ? input.session_id : "";
  if (!sessionId && event !== "SessionStart") return;
  const callId = typeof input?.tool_use_id === "string" ? input.tool_use_id : undefined;

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
          output,
          callId
        );
        break;
      case "PermissionRequest":
        await obsCheck(
          sessionId,
          config,
          typeof input.tool_name === "string" ? input.tool_name : "",
          input.tool_input,
          output,
          callId
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
          status,
          callId
        );
        break;
      }
      case "Stop":
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
