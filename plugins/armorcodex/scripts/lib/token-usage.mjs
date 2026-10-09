/**
 * Codex token-usage capture.
 *
 * The shared SDK helper `summarizeTranscriptUsage` only understands the
 * Anthropic/Claude-Code transcript shape (`message.usage.{input_tokens,...}`).
 * Codex CLI writes a different rollout format, so we parse it ourselves and
 * still post through the single shared transport (`client.recordTokenUsage`),
 * exactly as the SDK docs recommend for tools whose transcript differs.
 *
 * Codex rollout JSONL (one object per line) carries, among others:
 *   { type: "turn_context", payload: { model: "gpt-5.5", ... } }
 *   { type: "event_msg", payload: { type: "token_count",
 *       info: { total_token_usage: { input_tokens, cached_input_tokens,
 *                                    output_tokens, reasoning_output_tokens,
 *                                    total_tokens }, ... } } }
 *
 * `total_token_usage` is CUMULATIVE for the session, so we take the last
 * token_count event's totals — matching the idempotent, cumulative contract of
 * the backend upsert (it SETS per-(session,model) counts, never adds).
 *
 * Codex's `input_tokens` INCLUDES `cached_input_tokens` (input+output=total).
 * To match the Claude convention (input excludes cache reads) we split them:
 *   inputTokens     = input_tokens - cached_input_tokens   (fresh prompt tokens)
 *   cacheReadTokens = cached_input_tokens
 *   outputTokens    = output_tokens                         (incl. reasoning)
 *   cacheWriteTokens = 0                                    (no Codex equivalent)
 */

import { readFileSync } from "node:fs";

function readUsageEvents(transcriptPath) {
  if (typeof transcriptPath !== "string" || !transcriptPath) {
    return { events: [], latestTaskSequence: -1 };
  }

  let raw;
  try {
    raw = readFileSync(transcriptPath, "utf8");
  } catch {
    return { events: [], latestTaskSequence: -1 };
  }

  let currentModel = "";
  let taskSequence = -1;
  const events = [];

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

    if (obj.type === "event_msg" && payload.type === "task_started") {
      taskSequence += 1;
      continue;
    }

    if (obj.type === "turn_context" && typeof payload.model === "string" && payload.model) {
      currentModel = payload.model;
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
    });
  }

  return { events, latestTaskSequence: taskSequence };
}

function usageEntry(model, totals) {
  const inputTotal = toCount(totals?.input_tokens);
  const cacheRead = toCount(totals?.cached_input_tokens);
  const outputTokens = toCount(totals?.output_tokens);
  const inputTokens = Math.max(0, inputTotal - cacheRead);

  if (inputTokens + outputTokens + cacheRead === 0) return [];
  return [
    {
      model: model || "unknown",
      inputTokens,
      outputTokens,
      cacheReadTokens: cacheRead,
      cacheWriteTokens: 0,
    },
  ];
}

function subtractTotals(latest, baseline) {
  return {
    input_tokens: Math.max(0, toCount(latest?.input_tokens) - toCount(baseline?.input_tokens)),
    cached_input_tokens: Math.max(
      0,
      toCount(latest?.cached_input_tokens) - toCount(baseline?.cached_input_tokens),
    ),
    output_tokens: Math.max(
      0,
      toCount(latest?.output_tokens) - toCount(baseline?.output_tokens),
    ),
  };
}

/**
 * @param {string} transcriptPath absolute path to the Codex rollout JSONL
 * @returns {Array<{model:string,inputTokens:number,outputTokens:number,cacheReadTokens:number,cacheWriteTokens:number}>}
 *   at most one entry (per the last-known model); [] on any read/parse error or
 *   when no token usage was recorded.
 */
export function summarizeCodexTranscriptUsage(transcriptPath) {
  const { events } = readUsageEvents(transcriptPath);
  const latest = events.at(-1);
  return latest ? usageEntry(latest.model, latest.totals) : [];
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
