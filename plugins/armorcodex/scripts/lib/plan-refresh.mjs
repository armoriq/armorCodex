import { unlink } from "node:fs/promises";
import path from "node:path";
import { requestIntent } from "./intent.mjs";
import { computePolicyHash, loadPolicyState } from "./policy.mjs";
import { createPlanRequest, requestWithRetry, withPlanRequest } from "./plan-request.mjs";
import { readJson } from "./fs-store.mjs";
import { cachedPosture } from "./backend-posture.mjs";
import { getSession, isPromptOpen, loadRuntimeState, matchesSessionGeneration, syncSessionAuth, withRuntimeState } from "./runtime-state.mjs";

export async function refreshSession(currentConfig, sessionId, { expiredOnly = false, expected } = {}) {
  const config = currentConfig();
  if (!sessionId || !config.apiKey || (!config.useSdkIntent && !config.intentEndpoint) ||
      (await cachedPosture(config))?.state === "signed_out") return null;
  return withPlanRequest(config.runtimeFile, sessionId, async (deadlineAt) => {
    let descriptor;
    let currentToken;
    let tokenExpiresAt;
    let countedPlanId;
    const update = (change) => withRuntimeState(config.runtimeFile, (state) => {
      if (!getSession(state, sessionId)) return null;
      let session = getSession(state, sessionId);
      if (session.backendEndpoint && session.backendEndpoint !== config.backendEndpoint) return null;
      session = syncSessionAuth(state, sessionId, currentConfig(), { retireOnChange: false });
      if (!session) return null;
      if (!isPromptOpen(session) || (expected && !matchesSessionGeneration(session, expected))) return null;
      if (descriptor && (!matchesSessionGeneration(session, descriptor) || session.pendingRequest?.key !== descriptor.key ||
          session.countedPlanId !== countedPlanId || session.tokenExpiresAt !== tokenExpiresAt)) return null;
      return change(session);
    });
    try {
      descriptor = await update(async (session) => {
        if (!session.countedPlanId || !session.tokenPlanId || !session.intentTokenRaw || !session.plan) return null;
        const remaining = Date.parse(session.tokenExpiresAt) - Date.now();
        const threshold = expiredOnly ? 0 : Math.min(120, config.validitySeconds / 3) * 1000;
        if (!Number.isFinite(remaining)) return null;
        if (remaining > threshold) {
          if (expiredOnly) currentToken = structuredClone(session);
          return null;
        }
        if (!expiredOnly && Date.now() < session.refreshRetryAt) return null;
        if (session.pendingRequest && session.pendingRequest.kind !== "refresh") return null;
        tokenExpiresAt = session.tokenExpiresAt;
        countedPlanId = session.countedPlanId;
        if (!session.pendingRequest) {
          const { policy } = await loadPolicyState(config.policyFile);
          session.pendingRequest = createPlanRequest(config, {
            prompt: session.plan.goal, plan: session.plan, session_id: sessionId,
            policy_hash: computePolicyHash(policy), policy, validitySeconds: config.validitySeconds,
            metadata: { source: "codex", planning: "codex-registered" }
          }, session, "refresh");
        }
        return structuredClone(session.pendingRequest);
      });
      if (!descriptor) return currentToken ?? null;
      const result = await requestWithRetry(async (timeoutMs) => {
        if (!await update(() => true)) throw new Error("the prompt or login changed while refreshing");
        return requestIntent(config, { plan: descriptor.body.plan }, descriptor, { timeoutMs });
      }, { timeoutMs: config.timeoutMs, deadlineAt, config, requestKey: descriptor.key });
      if (!result?.tokenRaw || !result.planId || !Number.isFinite(result.expiresAt)) {
        throw new Error("the backend returned no token, plan id or expiry");
      }
      return await update(async (session) => {
        Object.assign(session, {
          intentTokenRaw: result.tokenRaw, tokenPlanId: result.planId,
          expiresAt: result.expiresAt, tokenExpiresAt: new Date(result.expiresAt * 1000).toISOString(),
          planCheck: result.planCheck ?? null, intentExecution: null,
          pendingRequest: null, refreshFailures: 0, refreshRetryAt: null
        });
        const pendingPath = path.join(config.dataDir, `pending-plan.${sessionId}.json`);
        const pending = await readJson(pendingPath, null);
        if (matchesSessionGeneration(session, pending)) await unlink(pendingPath);
        return structuredClone(session);
      });
    } catch (error) {
      if (descriptor) {
        await update((session) => {
          if (!error.unconfirmed) session.pendingRequest = null;
          session.refreshFailures = (session.refreshFailures || 0) + 1;
          session.refreshRetryAt = Date.now() + Math.min(30000 * 2 ** (session.refreshFailures - 1), 300000);
        });
      }
      throw error;
    }
  });
}

export function createPlanRefresher({ currentConfig, onError }) {
  const inFlight = new Map();
  let scanning = null;
  let stopped = false;
  const run = async () => {
    if (stopped) return;
    scanning ??= (async () => {
      const state = await loadRuntimeState(currentConfig().runtimeFile);
      if (stopped) return;
      for (const [sessionId, session] of Object.entries(state.sessions)) {
        if (inFlight.has(sessionId) || !isPromptOpen(session)) continue;
        const flight = refreshSession(currentConfig, sessionId, { expected: session })
          .catch(onError).finally(() => inFlight.delete(sessionId));
        inFlight.set(sessionId, flight);
      }
    })().finally(() => { scanning = null; });
    await scanning;
    await Promise.all(inFlight.values());
  };
  const timer = setInterval(() => { run().catch(onError); }, 15000);
  timer.unref?.();
  return {
    run,
    async stop() {
      stopped = true;
      clearInterval(timer);
      await scanning;
      await Promise.all(inFlight.values());
    }
  };
}
