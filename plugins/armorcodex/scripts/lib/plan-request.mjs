import { createHash } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { tryFileLock } from "./live-usage.mjs";
import { auditRowId, createAuditWal } from "./audit-wal.mjs";
import { clientEvent } from "./client-events.mjs";

export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${canonicalJson(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  if (typeof value === "number" && !Number.isFinite(value)) throw new Error("Plan contains a nonfinite number");
  const json = JSON.stringify(value);
  if (json === undefined) throw new Error("Plan contains a value outside JSON");
  if (typeof value === "string" && /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(value)) {
    throw new Error("Plan contains an invalid Unicode string");
  }
  return json;
}

const hash = (value) => createHash("sha256").update(value).digest("hex");

export function planHash(plan) {
  return hash(canonicalJson(plan));
}

export function idempotencyKey(request) {
  const fields = request.kind === "refresh"
    ? ["refresh", request.countedPlanId, request.tokenExpiresAt]
    : [request.kind, request.promptId, request.parentPlanId || "", request.planHash];
  if (request.kind !== "refresh" && request.epoch > 0) fields.push(`epoch:${request.epoch}`);
  return `pcc1:${hash(fields.join("\n"))}`;
}

export function createPlanRequest(config, payload, session, kind = session.countedPlanId ? "revision" : "new") {
  const parentPlanId = session.countedPlanId || undefined;
  const requestHash = planHash(payload.plan);
  const key = idempotencyKey({ kind, promptId: session.promptId, parentPlanId, planHash: requestHash,
    epoch: session.retirementEpoch,
    countedPlanId: session.countedPlanId, tokenExpiresAt: session.tokenExpiresAt });
  const headers = {
    "Idempotency-Key": key,
    "X-ArmorIQ-Plan-Kind": kind,
    "X-ArmorIQ-Prompt-Id": session.promptId,
    ...(parentPlanId ? { "X-ArmorIQ-Parent-Plan-Id": parentPlanId } : {})
  };
  const body = config.intentEndpoint ? payload : {
    user_id: config.userId, agent_id: config.agentId, context_id: payload.session_id,
    plan: payload.plan, policy: csrgIntentPolicy(payload.policy_hash), expires_in: payload.validitySeconds
  };
  return JSON.parse(JSON.stringify({
    key, headers, body, planHash: requestHash, kind,
    transport: config.intentEndpoint ? "custom" : "sdk",
    promptId: session.promptId, promptGeneration: session.promptGeneration, authGeneration: session.authGeneration
  }));
}

/**
 * The policy CSRG signs into the token. CSRG reads it as an allow/deny list and
 * refuses every plan step when it has no allow list, so a held call could never
 * pass the backend's step check. Local rules are already enforced in PreToolUse.
 */
export function csrgIntentPolicy(policyHash) {
  return { allow: ["*"], deny: [], metadata: { source: "codex", policyHash: policyHash ?? "" } };
}

function unconfirmed(reason, reasonCode = "timeout") {
  return Object.assign(new Error(reason), { unconfirmed: true, reasonCode });
}

export async function withPlanRequest(runtimeFile, sessionId, task) {
  const lockPath = `${runtimeFile}.${hash(sessionId)}.request.lock`;
  const deadlineAt = Date.now() + 40000;
  let release = await tryFileLock(lockPath);
  while (!release) {
    if (Date.now() >= deadlineAt) throw unconfirmed("the session request deadline expired");
    await sleep(Math.min(10, deadlineAt - Date.now()));
    release = await tryFileLock(lockPath);
  }
  try {
    return await task(deadlineAt);
  } finally {
    await release();
  }
}

export async function requestWithRetry(send, options = {}) {
  try {
    return await retryRequest(send, options);
  } catch (error) {
    if (options.config?.apiKey && options.requestKey && (error.unconfirmed || error.retryable !== undefined)) {
      const event = clientEvent("plan_request_failed", "health", 1,
        error.reasonCode ?? (error.unconfirmed ? "timeout" : "rejected"), (options.now ?? Date.now)(), {
          event_id: auditRowId("plan_request_failed", options.requestKey, "decision")
        });
      await createAuditWal({ dataDir: options.config.dataDir, config: options.config, stream: "health" }).appendLine(event);
    }
    throw error;
  }
}

async function retryRequest(send, { now = Date.now, wait = sleep, timeoutMs = 30000, deadlineAt } = {}) {
  const deadline = deadlineAt ?? now() + 40000;
  let reason = "the request deadline expired";
  let reasonCode = "timeout";
  let attempt = 0;
  while (now() < deadline) {
    const remaining = deadline - now();
    let timer;
    try {
      return await Promise.race([
        send(Math.min(timeoutMs, remaining)),
        new Promise((_, reject) => { timer = setTimeout(() => reject(unconfirmed(reason)), remaining); })
      ]);
    } catch (error) {
      if (error.unconfirmed || !error.retryable) throw error;
      reason = error.message;
      reasonCode = error.reasonCode ?? "network";
      const retryAfter = error.retryAfter;
      const delay = retryAfter !== undefined && /^\d+(\.\d+)?$/.test(String(retryAfter).trim())
        ? Number(retryAfter) * 1000
        : retryAfter !== undefined ? Math.max(0, Date.parse(retryAfter) - now()) : NaN;
      const backoff = Number.isFinite(delay) ? delay : Math.min(1000 * 2 ** attempt, 4000);
      attempt++;
      const left = deadline - now();
      if (left > 0) await wait(Math.min(backoff, left));
    } finally {
      clearTimeout(timer);
    }
  }
  throw unconfirmed(reason, reasonCode);
}
