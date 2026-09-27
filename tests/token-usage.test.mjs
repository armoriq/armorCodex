import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  readRollout,
  rolloutUsage,
  summarizeCodexTurnUsage,
} from "../plugins/armorcodex/scripts/lib/token-usage.mjs";

async function writeRollout(lines) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "codex-rollout-"));
  const file = path.join(dir, "rollout.jsonl");
  await writeFile(file, lines.map((l) => JSON.stringify(l)).join("\n"), "utf8");
  return file;
}

const tokenCount = (total, last) => ({
  type: "event_msg",
  payload: {
    type: "token_count",
    info: {
      total_token_usage: total,
      ...(last ? { last_token_usage: last } : {}),
    },
  },
});

test("summarizes only the latest task across multiple token snapshots", async () => {
  const file = await writeRollout([
    { type: "event_msg", payload: { type: "task_started" } },
    { type: "turn_context", payload: { model: "gpt-4.1" } },
    tokenCount({ input_tokens: 100, cached_input_tokens: 20, output_tokens: 10 }),
    { type: "event_msg", payload: { type: "task_complete" } },
    { type: "event_msg", payload: { type: "task_started" } },
    { type: "turn_context", payload: { model: "gpt-4.1" } },
    tokenCount(
      { input_tokens: 160, cached_input_tokens: 40, output_tokens: 20 },
      { input_tokens: 60, cached_input_tokens: 20, output_tokens: 10 },
    ),
    tokenCount(
      { input_tokens: 220, cached_input_tokens: 70, output_tokens: 30 },
      { input_tokens: 120, cached_input_tokens: 50, output_tokens: 20 },
    ),
  ]);

  assert.deepEqual(summarizeCodexTurnUsage(file), [
    {
      model: "gpt-4.1",
      inputTokens: 70,
      outputTokens: 20,
      cacheReadTokens: 50,
      cacheWriteTokens: 0,
      reasoningOutputTokens: 0,
    },
  ]);
});

test("uses last_token_usage for an older rollout without task boundaries", async () => {
  const file = await writeRollout([
    { type: "turn_context", payload: { model: "gpt-4.1" } },
    tokenCount({ input_tokens: 100, cached_input_tokens: 20, output_tokens: 10 }),
    tokenCount(
      { input_tokens: 180, cached_input_tokens: 50, output_tokens: 25 },
      { input_tokens: 80, cached_input_tokens: 30, output_tokens: 15 },
    ),
  ]);

  assert.deepEqual(summarizeCodexTurnUsage(file), [
    {
      model: "gpt-4.1",
      inputTokens: 50,
      outputTokens: 15,
      cacheReadTokens: 30,
      cacheWriteTokens: 0,
      reasoningOutputTokens: 0,
    },
  ]);
});

test("falls back to cumulative delta for an older rollout without last usage", async () => {
  const file = await writeRollout([
    { type: "turn_context", payload: { model: "gpt-4.1" } },
    tokenCount({ input_tokens: 100, cached_input_tokens: 20, output_tokens: 10 }),
    tokenCount({ input_tokens: 180, cached_input_tokens: 50, output_tokens: 25 }),
  ]);

  assert.deepEqual(summarizeCodexTurnUsage(file), [
    {
      model: "gpt-4.1",
      inputTokens: 50,
      outputTokens: 15,
      cacheReadTokens: 30,
      cacheWriteTokens: 0,
      reasoningOutputTokens: 0,
    },
  ]);
});

test("does not reuse the previous task when the latest task has no token count", async () => {
  const file = await writeRollout([
    { type: "event_msg", payload: { type: "task_started" } },
    { type: "turn_context", payload: { model: "gpt-4.1" } },
    tokenCount({ input_tokens: 100, cached_input_tokens: 20, output_tokens: 10 }),
    { type: "event_msg", payload: { type: "task_complete" } },
    { type: "event_msg", payload: { type: "task_started" } },
    { type: "turn_context", payload: { model: "gpt-4.1" } },
  ]);

  assert.deepEqual(summarizeCodexTurnUsage(file), []);
});

const at = (timestamp, line) => ({ timestamp, ...line });
const usageOf = async (lines, copied) => rolloutUsage(readRollout(await writeRollout(lines)), copied);
const byDay = async (lines, copied) => (await usageOf(lines, copied)).days;
const entry = (model, inputTokens, outputTokens, cacheReadTokens = 0, extra = {}) => ({
  model,
  inputTokens,
  outputTokens,
  cacheReadTokens,
  cacheWriteTokens: 0,
  reasoningOutputTokens: 0,
  ...extra,
});
const record = (responseId, usage) => ({
  type: "token_usage_record",
  payload: { response_id: responseId, usage },
});

test("readRollout returns the session_meta payload and each token_count with its model", async () => {
  const file = await writeRollout([
    at("2026-09-20T09:00:00Z", { type: "session_meta", payload: { id: "s1", cwd: "/repo" } }),
    at("2026-09-20T09:00:01Z", { type: "turn_context", payload: { model: "gpt-5.5" } }),
    at("2026-09-20T09:00:02Z", tokenCount({ input_tokens: 10, output_tokens: 1 })),
  ]);
  const { meta, events } = readRollout(file);
  assert.deepEqual(meta, { id: "s1", cwd: "/repo" });
  assert.equal(events.length, 1);
  assert.equal(events[0].model, "gpt-5.5");
  assert.equal(events[0].timestamp, "2026-09-20T09:00:02Z");
  assert.throws(() => readRollout("/does/not/exist.jsonl"));
});

test("splits cached tokens out of input_tokens", async () => {
  const days = await byDay([
    { type: "turn_context", payload: { model: "gpt-5.5" } },
    at(
      "2026-09-20T09:00:00Z",
      tokenCount({
        input_tokens: 13223,
        cached_input_tokens: 9088,
        output_tokens: 39,
        reasoning_output_tokens: 19,
        total_tokens: 13262,
      }),
    ),
  ]);
  assert.deepEqual(days, {
    "2026-09-20": { "gpt-5.5": entry("gpt-5.5", 4135, 39, 9088, { reasoningOutputTokens: 19 }) },
  });
});

test("puts each token_count's growth on its own UTC day and counts repeated totals once", async () => {
  const days = await byDay([
    { type: "turn_context", payload: { model: "gpt-5.5" } },
    at("2026-09-20T23:59:00Z", tokenCount({ input_tokens: 100, cached_input_tokens: 20, output_tokens: 10 })),
    at("2026-09-20T23:59:01Z", tokenCount({ input_tokens: 100, cached_input_tokens: 20, output_tokens: 10 })),
    at("2026-09-21T00:01:00Z", tokenCount({ input_tokens: 250, cached_input_tokens: 70, output_tokens: 30 })),
  ]);
  assert.deepEqual(days, {
    "2026-09-20": { "gpt-5.5": entry("gpt-5.5", 80, 10, 20) },
    "2026-09-21": { "gpt-5.5": entry("gpt-5.5", 100, 20, 50) },
  });
});

test("gives each model the growth of its own turns", async () => {
  const days = await byDay([
    { type: "turn_context", payload: { model: "gpt-5.5" } },
    at("2026-09-20T09:00:00Z", tokenCount({ input_tokens: 100, output_tokens: 10 })),
    { type: "turn_context", payload: { model: "gpt-5.5-codex" } },
    at("2026-09-20T10:00:00Z", tokenCount({ input_tokens: 220, output_tokens: 30 })),
  ]);
  assert.deepEqual(days, {
    "2026-09-20": {
      "gpt-5.5": entry("gpt-5.5", 100, 10),
      "gpt-5.5-codex": entry("gpt-5.5-codex", 120, 20),
    },
  });
});

test("a lower total starts a new count from zero", async () => {
  const days = await byDay([
    { type: "turn_context", payload: { model: "gpt-5.5" } },
    at("2026-09-20T09:00:00Z", tokenCount({ input_tokens: 1000, output_tokens: 100 })),
    at("2026-09-20T10:00:00Z", tokenCount({ input_tokens: 50, output_tokens: 5 })),
    at("2026-09-20T11:00:00Z", tokenCount({ input_tokens: 80, output_tokens: 8 })),
  ]);
  assert.deepEqual(days, { "2026-09-20": { "gpt-5.5": entry("gpt-5.5", 1080, 108) } });
});

test("copied events set the starting totals and count nothing", async () => {
  const days = await byDay(
    [
      { type: "turn_context", payload: { model: "gpt-5.5" } },
      at("2026-09-21T09:00:00Z", tokenCount({ input_tokens: 100, output_tokens: 10 })),
      at("2026-09-21T09:00:00Z", tokenCount({ input_tokens: 300, output_tokens: 30 })),
      at("2026-09-21T10:00:00Z", tokenCount({ input_tokens: 340, output_tokens: 33 })),
    ],
    { events: 2 },
  );
  assert.deepEqual(days, { "2026-09-21": { "gpt-5.5": entry("gpt-5.5", 40, 3) } });
});

test("uses 'unknown' when no turn_context names a model, and skips corrupt lines", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "codex-rollout-"));
  const file = path.join(dir, "rollout.jsonl");
  await writeFile(
    file,
    [
      "{not valid json",
      JSON.stringify(
        at("2026-09-20T09:00:00Z", tokenCount({ input_tokens: 80, cached_input_tokens: 10, output_tokens: 8 })),
      ),
    ].join("\n"),
    "utf8",
  );
  assert.deepEqual(rolloutUsage(readRollout(file)).days, {
    "2026-09-20": { unknown: entry("unknown", 70, 8, 10) },
  });
});

// Codex 0.153+ writes one token_usage_record per completed Responses API request
// (codex-rs/core/src/session/mod.rs record_observed_response_completed).
test("counts token_usage_record usage, including a compaction request no token_count reports", async () => {
  const days = await byDay([
    { type: "turn_context", payload: { model: "gpt-5.5" } },
    at(
      "2026-09-07T13:05:00Z",
      record("resp-1", {
        input_tokens: 21688,
        cached_input_tokens: 0,
        output_tokens: 478,
        reasoning_output_tokens: 343,
        total_tokens: 22166,
      }),
    ),
    at("2026-09-07T13:05:01Z", tokenCount({ input_tokens: 21688, output_tokens: 478 })),
    at(
      "2026-09-07T13:40:00Z",
      record("resp-compact", {
        input_tokens: 230969,
        cached_input_tokens: 118272,
        output_tokens: 4520,
        total_tokens: 235489,
      }),
    ),
    at("2026-09-07T13:40:01Z", tokenCount({ input_tokens: 21688, output_tokens: 478 })),
  ]);
  assert.deepEqual(days, {
    "2026-09-07": {
      "gpt-5.5": entry("gpt-5.5", 21688 + 112697, 478 + 4520, 118272, { reasoningOutputTokens: 343 }),
    },
  });
});

test("counts token_count growth up to the first token_usage_record, then the records", async () => {
  const days = await byDay([
    { type: "turn_context", payload: { model: "gpt-5.5" } },
    at("2026-09-01T09:00:00Z", tokenCount({ input_tokens: 100, output_tokens: 10 })),
    at("2026-09-08T09:00:00Z", record("resp-1", { input_tokens: 50, output_tokens: 5 })),
    at("2026-09-08T09:00:01Z", tokenCount({ input_tokens: 150, output_tokens: 15 })),
    at("2026-09-08T10:00:00Z", record("resp-2", { input_tokens: 20, output_tokens: 2 })),
    at("2026-09-08T10:00:01Z", tokenCount({ input_tokens: 170, output_tokens: 17 })),
  ]);
  assert.deepEqual(days, {
    "2026-09-01": { "gpt-5.5": entry("gpt-5.5", 100, 10) },
    "2026-09-08": { "gpt-5.5": entry("gpt-5.5", 70, 7) },
  });
});

test("copied token_usage_records count nothing", async () => {
  const days = await byDay(
    [
      { type: "turn_context", payload: { model: "gpt-5.5" } },
      at("2026-09-08T09:00:00Z", record("resp-1", { input_tokens: 50, output_tokens: 5 })),
      at("2026-09-08T09:00:00Z", record("resp-2", { input_tokens: 20, output_tokens: 2 })),
      at("2026-09-09T09:00:00Z", record("resp-3", { input_tokens: 9, output_tokens: 1 })),
    ],
    { records: 2 },
  );
  assert.deepEqual(days, { "2026-09-09": { "gpt-5.5": entry("gpt-5.5", 9, 1) } });
});

test("cache writes come out of input_tokens as cacheWriteTokens", async () => {
  const days = await byDay([
    { type: "turn_context", payload: { model: "gpt-5.5" } },
    at(
      "2026-09-08T09:00:00Z",
      record("resp-1", {
        input_tokens: 100,
        cached_input_tokens: 20,
        cache_write_input_tokens: 30,
        output_tokens: 5,
      }),
    ),
  ]);
  assert.deepEqual(days, {
    "2026-09-08": { "gpt-5.5": entry("gpt-5.5", 50, 5, 20, { cacheWriteTokens: 30 }) },
  });
});

test("readRollout returns each token_usage_record with its response id and model", async () => {
  const { records } = readRollout(
    await writeRollout([
      { type: "turn_context", payload: { model: "gpt-5.5" } },
      at("2026-09-08T09:00:00Z", record("resp-1", { input_tokens: 5 })),
    ]),
  );
  assert.deepEqual(records, [
    { model: "gpt-5.5", usage: { input_tokens: 5 }, responseId: "resp-1", timestamp: "2026-09-08T09:00:00Z", turn: null },
  ]);
});

const v7 = (iso) => {
  const hex = Date.parse(iso).toString(16).padStart(12, "0");
  return `${hex.slice(0, 8)}-${hex.slice(8)}-7000-8000-000000000001`;
};
const started = (turnId, iso) => ({
  type: "event_msg",
  payload: { type: "task_started", turn_id: turnId, started_at: Math.floor(Date.parse(iso) / 1000) },
});

test("a fork's copied turns are kept apart, dated by the turn's start", async () => {
  const copiedTurn = v7("2026-09-20T23:59:30Z");
  const ownTurn = v7("2026-09-22T09:04:00Z");
  const usage = await usageOf([
    at("2026-09-22T09:00:00Z", {
      type: "session_meta",
      payload: { id: "fork", forked_from_id: "original", timestamp: "2026-09-22T09:00:00Z" },
    }),
    at("2026-09-22T09:00:00Z", started(copiedTurn, "2026-09-20T23:59:30Z")),
    at("2026-09-22T09:00:00Z", { type: "turn_context", payload: { model: "gpt-5.5" } }),
    at("2026-09-22T09:00:00Z", tokenCount({ input_tokens: 100, output_tokens: 10 })),
    at("2026-09-22T09:00:00Z", tokenCount({ input_tokens: 300, output_tokens: 30 })),
    at("2026-09-22T09:04:00Z", started(ownTurn, "2026-09-22T09:04:00Z")),
    at("2026-09-22T09:05:00Z", tokenCount({ input_tokens: 340, output_tokens: 33 })),
  ]);
  assert.deepEqual(usage, {
    days: { "2026-09-22": { "gpt-5.5": entry("gpt-5.5", 40, 3) } },
    turns: [ownTurn],
    copiedTurns: {
      [copiedTurn]: { usageDate: "2026-09-20", items: 2, models: { "gpt-5.5": entry("gpt-5.5", 300, 30) } },
    },
  });
});

test("a turn id that is not a UUIDv7 is dated by started_at", async () => {
  const turnId = "43ad1418-d21c-40ec-979a-e809f11001a9";
  const { days, copiedTurns } = await usageOf([
    at("2026-09-22T09:00:00Z", {
      type: "session_meta",
      payload: { id: "fork", forked_from_id: "original", timestamp: "2026-09-22T09:00:00Z" },
    }),
    at("2026-09-22T09:00:00Z", started(turnId, "2026-09-21T08:00:00Z")),
    at("2026-09-22T09:00:00Z", record("resp-1", { input_tokens: 50, output_tokens: 5 })),
  ]);
  assert.deepEqual(days, {});
  assert.deepEqual(copiedTurns, {
    [turnId]: { usageDate: "2026-09-21", items: 1, models: { unknown: entry("unknown", 50, 5) } },
  });
});

test("a rollout that is not a fork has no copied turns", async () => {
  const turnId = v7("2026-09-20T09:00:00Z");
  const usage = await usageOf([
    at("2026-09-21T09:00:00Z", { type: "session_meta", payload: { id: "s", timestamp: "2026-09-21T09:00:00Z" } }),
    at("2026-09-21T09:00:00Z", started(turnId, "2026-09-20T09:00:00Z")),
    at("2026-09-21T09:01:00Z", tokenCount({ input_tokens: 10, output_tokens: 1 })),
  ]);
  assert.deepEqual(usage.copiedTurns, {});
  assert.deepEqual(usage.days, { "2026-09-21": { unknown: entry("unknown", 10, 1) } });
});

test("a turn that starts in the fork's first second is the fork's own", async () => {
  const ownTurn = v7("2026-09-22T09:00:00.800Z");
  const { days, turns, copiedTurns } = await usageOf([
    at("2026-09-22T09:00:00.500Z", {
      type: "session_meta",
      payload: { id: "fork", forked_from_id: "original", timestamp: "2026-09-22T09:00:00.500Z" },
    }),
    at("2026-09-22T09:00:00.800Z", started(ownTurn, "2026-09-22T09:00:00.800Z")),
    at("2026-09-22T09:00:05Z", tokenCount({ input_tokens: 10, output_tokens: 1 })),
  ]);
  assert.deepEqual(days, { "2026-09-22": { unknown: entry("unknown", 10, 1) } });
  assert.deepEqual(turns, [ownTurn]);
  assert.deepEqual(copiedTurns, {});
});
