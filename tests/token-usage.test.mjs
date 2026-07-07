import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { summarizeCodexTranscriptUsage } from "../plugins/armorcodex/scripts/lib/token-usage.mjs";

async function writeRollout(lines) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "codex-rollout-"));
  const file = path.join(dir, "rollout.jsonl");
  await writeFile(file, lines.map((l) => JSON.stringify(l)).join("\n"), "utf8");
  return file;
}

const tokenCount = (total) => ({
  type: "event_msg",
  payload: { type: "token_count", info: { total_token_usage: total } },
});

test("parses model + splits cached tokens out of input_tokens", async () => {
  const file = await writeRollout([
    { type: "session_meta", payload: { model_provider: "openai" } },
    { type: "turn_context", payload: { model: "gpt-5.5" } },
    tokenCount({
      input_tokens: 13223,
      cached_input_tokens: 9088,
      output_tokens: 39,
      reasoning_output_tokens: 19,
      total_tokens: 13262,
    }),
  ]);
  const entries = summarizeCodexTranscriptUsage(file);
  assert.deepEqual(entries, [
    {
      model: "gpt-5.5",
      inputTokens: 4135, // 13223 - 9088
      outputTokens: 39,
      cacheReadTokens: 9088,
      cacheWriteTokens: 0,
    },
  ]);
  // Invariant: split preserves the reported total.
  const e = entries[0];
  assert.equal(e.inputTokens + e.outputTokens + e.cacheReadTokens, 13262);
});

test("uses the LAST cumulative token_count snapshot (idempotent totals)", async () => {
  const file = await writeRollout([
    { type: "turn_context", payload: { model: "gpt-5.5" } },
    tokenCount({ input_tokens: 100, cached_input_tokens: 0, output_tokens: 10 }),
    tokenCount({ input_tokens: 500, cached_input_tokens: 200, output_tokens: 60 }),
  ]);
  const entries = summarizeCodexTranscriptUsage(file);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].inputTokens, 300); // 500 - 200
  assert.equal(entries[0].cacheReadTokens, 200);
  assert.equal(entries[0].outputTokens, 60);
});

test("tracks the most recent model across turns", async () => {
  const file = await writeRollout([
    { type: "turn_context", payload: { model: "gpt-5.5" } },
    tokenCount({ input_tokens: 100, output_tokens: 10 }),
    { type: "turn_context", payload: { model: "gpt-5.5-codex" } },
    tokenCount({ input_tokens: 220, output_tokens: 30 }),
  ]);
  const entries = summarizeCodexTranscriptUsage(file);
  assert.equal(entries[0].model, "gpt-5.5-codex");
});

test("falls back to 'unknown' model when no turn_context present", async () => {
  const file = await writeRollout([tokenCount({ input_tokens: 50, output_tokens: 5 })]);
  const entries = summarizeCodexTranscriptUsage(file);
  assert.equal(entries[0].model, "unknown");
});

test("returns [] on missing file, empty path, and no usage", async () => {
  assert.deepEqual(summarizeCodexTranscriptUsage("/does/not/exist.jsonl"), []);
  assert.deepEqual(summarizeCodexTranscriptUsage(""), []);
  const noUsage = await writeRollout([{ type: "turn_context", payload: { model: "gpt-5.5" } }]);
  assert.deepEqual(summarizeCodexTranscriptUsage(noUsage), []);
});

test("skips corrupt lines without aborting the whole file", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "codex-rollout-"));
  const file = path.join(dir, "rollout.jsonl");
  await writeFile(
    file,
    [
      JSON.stringify({ type: "turn_context", payload: { model: "gpt-5.5" } }),
      "{not valid json",
      JSON.stringify(tokenCount({ input_tokens: 80, cached_input_tokens: 10, output_tokens: 8 })),
    ].join("\n"),
    "utf8",
  );
  const entries = summarizeCodexTranscriptUsage(file);
  assert.equal(entries[0].inputTokens, 70);
  assert.equal(entries[0].outputTokens, 8);
});
