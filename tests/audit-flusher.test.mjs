import test from "node:test";
import assert from "node:assert/strict";
import { createAuditFlusher } from "../plugins/armorcodex/scripts/lib/audit-flusher.mjs";

test("ticks during a slow ship are skipped, so stopping waits for one ship at most", async () => {
  let calls = 0;
  const flusher = createAuditFlusher({
    ship: async () => {
      calls += 1;
      await new Promise((resolve) => setTimeout(resolve, 100));
      throw new Error("backend down");
    },
    onError: () => {},
    intervalMs: 10
  });
  await new Promise((resolve) => setTimeout(resolve, 400));
  const stopping = Date.now();
  await flusher.stop();
  const waited = Date.now() - stopping;
  assert.ok(waited < 350, `stop waited ${waited} ms for queued ticks`);
  assert.ok(calls <= 7, `ship ran ${calls} times`);
});

test("stop waits for the ship in flight and then ships once more", async () => {
  const order = [];
  const flusher = createAuditFlusher({
    ship: async () => {
      order.push("start");
      await new Promise((resolve) => setTimeout(resolve, 60));
      order.push("end");
    },
    onError: () => {},
    intervalMs: 20
  });
  await new Promise((resolve) => setTimeout(resolve, 30));
  await flusher.stop();
  assert.deepEqual(order, ["start", "end", "start", "end"]);
});
