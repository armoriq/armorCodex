import { randomUUID } from "node:crypto";

// conmap-auto publishes these wire values in docs/contracts/client-events-v1.json.
export const CLIENT_EVENTS = Object.freeze({
  maxBatchEvents: 100,
  maxCount: 1_000_000,
  queues: ["audit", "runs", "health"],
  outcomes: ["accepted", "duplicate", "retryable", "rejected"],
  reasons: {
    dead_letter: ["rejected", "attempts_exhausted", "oversize"],
    queue_stalled: ["backend_unreachable", "auth_paused", "rate_limited", "server_error", "undeliverable_login"],
    plan_request_failed: ["timeout", "network", "rate_limited", "server_error", "request_in_progress", "rejected"]
  }
});

export function clientEvent(type, queue, count, reason, now, extra = {}) {
  if (!CLIENT_EVENTS.reasons[type]?.includes(reason) || !CLIENT_EVENTS.queues.includes(queue) ||
      !Number.isInteger(count) || count < 1 || count > CLIENT_EVENTS.maxCount) {
    throw new Error("Invalid client event");
  }
  return {
    event_id: randomUUID(), type, queue, count, reason_code: reason,
    occurred_at: new Date(now).toISOString(), ...extra
  };
}
