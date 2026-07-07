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

/**
 * @param {string} transcriptPath absolute path to the Codex rollout JSONL
 * @returns {Array<{model:string,inputTokens:number,outputTokens:number,cacheReadTokens:number,cacheWriteTokens:number}>}
 *   at most one entry (per the last-known model); [] on any read/parse error or
 *   when no token usage was recorded.
 */
export function summarizeCodexTranscriptUsage(transcriptPath) {
  if (typeof transcriptPath !== "string" || !transcriptPath) return [];

  let raw;
  try {
    raw = readFileSync(transcriptPath, "utf8");
  } catch {
    return [];
  }

  let model = "";
  let latestTotals = null;

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

    // Track the most recent model the turn ran under.
    if (obj.type === "turn_context" && typeof payload.model === "string" && payload.model) {
      model = payload.model;
      continue;
    }

    // Capture the latest cumulative token snapshot.
    if (obj.type === "event_msg" && payload.type === "token_count") {
      const totals = payload.info && typeof payload.info === "object"
        ? payload.info.total_token_usage
        : null;
      if (totals && typeof totals === "object") latestTotals = totals;
    }
  }

  if (!latestTotals) return [];

  const inputTotal = toCount(latestTotals.input_tokens);
  const cacheRead = toCount(latestTotals.cached_input_tokens);
  const outputTokens = toCount(latestTotals.output_tokens);
  // input_tokens is inclusive of cached; keep the fresh portion only.
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

function toCount(value) {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) && n > 0 ? Math.trunc(n) : 0;
}
