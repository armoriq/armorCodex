import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { CLIENT_EVENTS, clientEvent } from "../plugins/armorcodex/scripts/lib/client-events.mjs";

const contract = JSON.parse(
  readFileSync(new URL("../plugins/armorcodex/tests/fixtures/client-events-v1.json", import.meta.url), "utf8")
);

test("the client event values match the backend's shared contract", () => {
  assert.deepEqual(Object.keys(CLIENT_EVENTS.reasons), contract.types);
  assert.deepEqual(CLIENT_EVENTS.queues, contract.queues);
  assert.deepEqual(CLIENT_EVENTS.reasons, contract.reasonCodes);
  assert.equal(CLIENT_EVENTS.maxBatchEvents, contract.limits.maxEventsPerRequest);
  assert.equal(CLIENT_EVENTS.maxCount, contract.limits.maxCount);
});

for (const { name, event, outcome } of contract.examples) {
  test(`the contract example "${name}" is ${outcome} by the plugin's builder too`, () => {
    const build = () =>
      clientEvent(event.type, event.queue, event.count, event.reason_code, event.occurred_at);
    if (outcome === "accepted") assert.equal(build().reason_code, event.reason_code);
    else assert.throws(build);
  });
}
