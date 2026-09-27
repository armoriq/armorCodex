/**
 * Codex token-usage parsing.
 *
 * The shared SDK helper `summarizeTranscriptUsage` only understands the
 * Anthropic/Claude-Code transcript shape (`message.usage.{input_tokens,...}`).
 * Codex CLI writes a different rollout format, so we parse it ourselves and
 * still post through the single shared transport (`client.recordTokenUsage`).
 *
 * Codex rollout JSONL (one object per line) carries, among others:
 *   { type: "session_meta", payload: { id, session_id, forked_from_id, cwd, ... } }
 *   { type: "turn_context", payload: { model: "gpt-5.5", ... } }
 *   { type: "event_msg", timestamp, payload: { type: "token_count",
 *       info: { total_token_usage: { input_tokens, cached_input_tokens,
 *                                    output_tokens, reasoning_output_tokens,
 *                                    total_tokens }, ... } } }
 *   { type: "token_usage_record", timestamp, payload: { response_id,
 *       usage: { input_tokens, cached_input_tokens, cache_write_input_tokens,
 *                output_tokens, reasoning_output_tokens, total_tokens } } }
 *
 * A token_usage_record (Codex 0.153 and later) is the Responses API usage of
 * one completed request, compaction requests included. token_count carries a
 * running total that skips remote compaction requests and is overwritten on a
 * context-window overflow, so a rollout is counted from token_count growth only
 * up to its first token_usage_record and from the records after that.
 *
 * `total_token_usage` is cumulative for the rollout file. A fork's file starts
 * with a copy of its original's lines, token_count events and records included,
 * and its counter continues from there. The counter can restart from zero
 * inside one file.
 *
 * Codex's `input_tokens` INCLUDES `cached_input_tokens` and
 * `cache_write_input_tokens`, and `output_tokens` includes
 * `reasoning_output_tokens`. Entries follow the Claude convention:
 *   inputTokens          = input_tokens - cached_input_tokens - cache_write_input_tokens
 *   cacheReadTokens      = cached_input_tokens
 *   cacheWriteTokens     = cache_write_input_tokens
 *   outputTokens         = output_tokens
 *   reasoningOutputTokens = reasoning_output_tokens (part of outputTokens)
 */

import { readFileSync } from "node:fs";

const COUNT_FIELDS = ["input_tokens", "cached_input_tokens", "output_tokens"];
const USAGE_FIELDS = [
  "input_tokens",
  "cached_input_tokens",
  "cache_write_input_tokens",
  "output_tokens",
  "reasoning_output_tokens",
];

function readUsageEvents(transcriptPath) {
  if (typeof transcriptPath !== "string" || !transcriptPath) {
    return { events: [], latestTaskSequence: -1 };
  }
  try {
    return parseRollout(readFileSync(transcriptPath, "utf8"));
  } catch {
    return { events: [], latestTaskSequence: -1 };
  }
}

function parseRollout(raw) {
  let meta = null;
  let currentModel = "";
  let taskSequence = -1;
  let timestamp = "";
  const events = [];
  const records = [];

  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    let obj;
    try {
      obj = JSON.parse(trimmed);
    } catch {
      continue;
    }

    const payload = obj && typeof obj === "object" ? obj.payload : null;
    if (!payload || typeof payload !== "object") continue;
    if (typeof obj.timestamp === "string") timestamp = obj.timestamp;

    if (obj.type === "session_meta") {
      meta ??= payload;
      continue;
    }

    if (obj.type === "event_msg" && payload.type === "task_started") {
      taskSequence += 1;
      continue;
    }

    if (obj.type === "turn_context" && typeof payload.model === "string" && payload.model) {
      currentModel = payload.model;
      continue;
    }

    if (obj.type === "token_usage_record") {
      if (payload.usage && typeof payload.usage === "object") {
        records.push({
          model: currentModel,
          usage: payload.usage,
          responseId: typeof payload.response_id === "string" ? payload.response_id : "",
          timestamp,
        });
      }
      continue;
    }

    if (obj.type !== "event_msg" || payload.type !== "token_count") continue;
    const info = payload.info && typeof payload.info === "object" ? payload.info : null;
    const totals = info && typeof info.total_token_usage === "object"
      ? info.total_token_usage
      : null;
    if (!totals) continue;

    events.push({
      model: currentModel,
      taskSequence,
      totals,
      lastUsage:
        info.last_token_usage && typeof info.last_token_usage === "object"
          ? info.last_token_usage
          : null,
      timestamp,
      afterRecord: records.length > 0,
    });
  }

  return { meta, events, records, latestTaskSequence: taskSequence };
}

/**
 * Read a Codex rollout: its session_meta payload (null when absent), every
 * token_count event and every token_usage_record, each with the model and
 * timestamp in effect. Throws when the file cannot be read.
 */
export function readRollout(rolloutPath) {
  const { meta, events, records } = parseRollout(readFileSync(rolloutPath, "utf8"));
  return { meta, events, records };
}

/** Identity of a token_count event: its cumulative totals. */
export function usageSignature(totals) {
  return [...COUNT_FIELDS, "total_tokens"].map((k) => toCount(totals?.[k])).join("/");
}

export function sumEntries(a, b) {
  if (!a) return b;
  return {
    model: a.model,
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens,
    cacheWriteTokens: a.cacheWriteTokens + b.cacheWriteTokens,
    reasoningOutputTokens: a.reasoningOutputTokens + b.reasoningOutputTokens,
  };
}

/**
 * Per-UTC-day, per-model usage of one rollout. Up to its first
 * token_usage_record it is the growth of the cumulative totals between
 * token_count events; a total lower than the one before starts a new count
 * from zero. From then on it is the sum of the records. The first
 * `copied.events` token_count events and `copied.records` records are history
 * copied from another rollout and count nothing; the copied events still set
 * the starting totals. Returns { "YYYY-MM-DD": { model: entry } }.
 */
export function rolloutUsageByDay({ events, records }, copied = {}) {
  const days = {};
  const add = (model, usage, timestamp) => {
    const time = Date.parse(timestamp);
    const [entry] = usageEntry(model, usage);
    if (!entry || Number.isNaN(time)) return;
    const day = (days[new Date(time).toISOString().slice(0, 10)] ??= {});
    day[entry.model] = sumEntries(day[entry.model], entry);
  };
  let prev = null;
  for (const [i, event] of events.entries()) {
    if (event.afterRecord) break;
    const reset = prev && COUNT_FIELDS.some((k) => toCount(event.totals[k]) < toCount(prev[k]));
    const base = prev && !reset ? prev : {};
    prev = event.totals;
    if (i < (copied.events ?? 0)) continue;
    add(event.model, subtractTotals(event.totals, base), event.timestamp);
  }
  for (const record of records.slice(copied.records ?? 0)) {
    add(record.model, record.usage, record.timestamp);
  }
  return days;
}

function usageEntry(model, totals) {
  const inputTotal = toCount(totals?.input_tokens);
  const cacheRead = toCount(totals?.cached_input_tokens);
  const cacheWrite = toCount(totals?.cache_write_input_tokens);
  const outputTokens = toCount(totals?.output_tokens);
  const inputTokens = Math.max(0, inputTotal - cacheRead - cacheWrite);

  if (inputTokens + outputTokens + cacheRead + cacheWrite === 0) return [];
  return [
    {
      model: model || "unknown",
      inputTokens,
      outputTokens,
      cacheReadTokens: cacheRead,
      cacheWriteTokens: cacheWrite,
      reasoningOutputTokens: Math.min(outputTokens, toCount(totals?.reasoning_output_tokens)),
    },
  ];
}

function subtractTotals(latest, baseline) {
  return Object.fromEntries(
    USAGE_FIELDS.map((k) => [k, Math.max(0, toCount(latest?.[k]) - toCount(baseline?.[k]))])
  );
}

/**
 * Return only the latest Codex task's token usage for one observability trace.
 * Codex reports cumulative session totals, while the observability backend adds
 * every trace's generation span. Prefer a task-boundary delta so repeated Stop
 * hooks cannot double count. Older rollouts without task_started fall back to
 * last_token_usage, then the last two cumulative snapshots, then the sole
 * cumulative snapshot for a first turn.
 */
export function summarizeCodexTurnUsage(transcriptPath) {
  const { events, latestTaskSequence } = readUsageEvents(transcriptPath);
  const latest = events.at(-1);
  if (!latest) return [];

  if (latestTaskSequence >= 0) {
    if (latest.taskSequence !== latestTaskSequence) return [];
    const baseline = events.findLast((event) => event.taskSequence < latest.taskSequence);
    const totals = baseline ? subtractTotals(latest.totals, baseline.totals) : latest.totals;
    const entry = usageEntry(latest.model, totals);
    if (entry.length) return entry;
    return usageEntry(latest.model, latest.lastUsage);
  }

  const fromLastUsage = usageEntry(latest.model, latest.lastUsage);
  if (fromLastUsage.length) return fromLastUsage;

  const previous = events.at(-2);
  if (previous) {
    const fromDelta = usageEntry(latest.model, subtractTotals(latest.totals, previous.totals));
    if (fromDelta.length) return fromDelta;
  }
  return usageEntry(latest.model, latest.totals);
}

function toCount(value) {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) && n > 0 ? Math.trunc(n) : 0;
}
