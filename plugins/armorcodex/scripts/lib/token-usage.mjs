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
 * and its counter continues from there. Every copied line carries the fork's
 * write time as its timestamp; a copied task_started keeps its turn_id and
 * started_at. The counter can restart from zero inside one file.
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
  let turn = null;
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
      turn = readTurn(payload);
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
          turn,
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
      turn,
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

const UUID_V7 = /^([0-9a-f]{8})-([0-9a-f]{4})-7[0-9a-f]{3}-/i;

function readTurn(payload) {
  const id = typeof payload.turn_id === "string" ? payload.turn_id : "";
  const v7 = UUID_V7.exec(id);
  const time = v7
    ? parseInt(v7[1] + v7[2], 16)
    : typeof payload.started_at === "number"
      ? payload.started_at * 1000
      : NaN;
  return id && Number.isFinite(time) ? { id, time } : null;
}

const utcHour = (time) => new Date(time).toISOString().slice(0, 13);

/**
 * Usage of one rollout, per UTC hour (`YYYY-MM-DDTHH`) and model. Up to its first
 * token_usage_record it is the growth of the cumulative totals between
 * token_count events; a total lower than the one before starts a new count
 * from zero. From then on it is the sum of the records.
 *
 * In a fork, usage inside a turn that started before the fork was created is
 * history copied from another rollout. It lands in `copiedTurns[turnId]`,
 * in the UTC hour the turn started, with `items` the number of usage lines copied.
 * The first `copied.events` token_count events and `copied.records` records
 * count nothing, for forks whose turns carry no id. Copied events still set
 * the starting totals. `turns` lists the ids of the rollout's own turns.
 */
export function rolloutUsage({ meta, events, records }, copied = {}, owns = () => true) {
  const createdAt = meta?.forked_from_id ? Date.parse(meta.timestamp) : NaN;
  const kept = (item) => {
    const at = item.turn && item.turn.time < createdAt ? item.turn.time : Date.parse(item.timestamp);
    return Number.isNaN(at) || owns(at);
  };
  const hours = {};
  const turns = new Set();
  const copiedTurns = {};
  const add = (item, usage) => {
    const [entry] = usageEntry(item.model, usage);
    if (!entry) return;
    if (!kept(item)) return;
    let models;
    if (item.turn && item.turn.time < createdAt) {
      const turn = (copiedTurns[item.turn.id] ??= { hour: utcHour(item.turn.time), items: 0, models: {} });
      turn.items++;
      models = turn.models;
    } else {
      const time = Date.parse(item.timestamp);
      if (Number.isNaN(time)) return;
      if (item.turn) turns.add(item.turn.id);
      models = hours[utcHour(time)] ??= {};
    }
    models[entry.model] = sumEntries(models[entry.model], entry);
  };
  let prev = null;
  for (const [i, event] of events.entries()) {
    if (event.afterRecord) break;
    const reset = prev && COUNT_FIELDS.some((k) => toCount(event.totals[k]) < toCount(prev[k]));
    const base = prev && !reset ? prev : {};
    prev = event.totals;
    if (i < (copied.events ?? 0)) continue;
    add(event, subtractTotals(event.totals, base));
  }
  for (const record of records.slice(copied.records ?? 0)) add(record, record.usage);
  return { hours, turns: [...turns], copiedTurns };
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
