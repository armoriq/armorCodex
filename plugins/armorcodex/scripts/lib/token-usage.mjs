/** Codex input_tokens includes cached and cache-write tokens, and output_tokens includes reasoning tokens. */

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
    return { records: [], latestTaskSequence: -1 };
  }
  try {
    return parseRollout(readFileSync(transcriptPath, "utf8"));
  } catch {
    return { records: [], latestTaskSequence: -1 };
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
          taskSequence,
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

export function readRollout(rolloutPath) {
  const { meta, events, records } = parseRollout(readFileSync(rolloutPath, "utf8"));
  return { meta, events, records };
}

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

function addCall(calls, entry, key, time) {
  if (key) (calls[utcHour(time)] ??= []).push({ ...entry, key, timestampMs: time });
}

export function rolloutUsage({ meta, events, records }, copied = {}, owns = () => true) {
  const createdAt = meta?.forked_from_id ? Date.parse(meta.timestamp) : NaN;
  const kept = (item) => {
    const at = item.turn && item.turn.time < createdAt ? item.turn.time : Date.parse(item.timestamp);
    return Number.isNaN(at) || owns(at);
  };
  const hours = {};
  const calls = {};
  const turns = new Set();
  const copiedTurns = {};
  const add = (item, usage, key) => {
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
      addCall(calls, entry, key, time);
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
  const skipped = copied.records ?? 0;
  records.slice(skipped).forEach((record, i) =>
    add(record, record.usage, record.responseId || `${record.timestamp}#${skipped + i}`)
  );
  return { hours, calls, turns: [...turns], copiedTurns };
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

export function codexTurnUsageCalls(transcriptPath) {
  const { records, latestTaskSequence } = readUsageEvents(transcriptPath);
  return records
    .filter((record) => record.taskSequence === latestTaskSequence)
    .flatMap((record, i) =>
      usageEntry(record.model, record.usage).map((entry) => ({
        ...entry,
        key: record.responseId || `${record.timestamp}#${i}`,
        timestampMs: Date.parse(record.timestamp),
      }))
    );
}

function toCount(value) {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) && n > 0 ? Math.trunc(n) : 0;
}
