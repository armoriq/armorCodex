import { createHash, randomUUID } from "node:crypto";
import { nowEpochSeconds } from "./common.mjs";
import { readJson, writeJson } from "./fs-store.mjs";
import { withFileLock } from "./live-usage.mjs";

const MAX_SESSION_AGE_SECONDS = 60 * 60 * 24;

const SESSION_DEFAULTS = {
  runId: null,
  promptId: null,
  promptGeneration: 0,
  retirementEpoch: 0,
  promptOpenSince: null,
  lastActivityAt: null,
  countedPlanId: null,
  tokenPlanId: null,
  planHash: null,
  kind: null,
  tokenExpiresAt: null,
  authGeneration: 0,
  pendingRequest: null,
  refreshFailures: 0,
  refreshRetryAt: null,
  unregisteredLocalPlan: null
};

export async function withRuntimeState(runtimeFilePath, update) {
  return withFileLock(`${runtimeFilePath}.lock`, async () => {
    const state = await loadRuntimeState(runtimeFilePath);
    const result = await update(state);
    await saveRuntimeState(runtimeFilePath, state);
    return result;
  });
}

export function retireSessionPlan(session) {
  Object.assign(session, {
    retirementEpoch: (session.retirementEpoch ?? 0) + 1,
    countedPlanId: null,
    tokenPlanId: null,
    planHash: null,
    kind: null,
    tokenExpiresAt: null,
    pendingRequest: null,
    refreshFailures: 0,
    refreshRetryAt: null,
    unregisteredLocalPlan: null,
    intentTokenRaw: "",
    plan: null,
    allowedActions: [],
    expiresAt: null,
    planCheck: null,
    intentExecution: null
  });
}

export function syncSessionAuth(state, sessionId, config, { retireOnChange = true } = {}) {
  config = config.authConfig || config;
  const session = upsertSession(state, sessionId, {});
  const fingerprint = createHash("sha256").update(JSON.stringify([
    config.apiKey || "", config.orgId || "", config.userId || "",
    config.loggedInAt || "", config.loginHistory || null,
    config.loginBackend || ""
  ])).digest("hex");
  if (session.authFingerprint && session.authFingerprint !== fingerprint) {
    if (!retireOnChange) return null;
    retireSessionPlan(session);
    session.authGeneration += 1;
  }
  session.authFingerprint = fingerprint;
  return session;
}

export function beginPrompt(session, prompt) {
  const now = Date.now();
  const hash = createHash("sha256").update(prompt).digest("hex");
  if (session.promptId && session.promptHash === hash && now >= session.promptStartedAt && now - session.promptStartedAt <= 5000) {
    return;
  }
  retireSessionPlan(session);
  session.promptId = randomUUID();
  session.retirementEpoch = 0;
  session.promptGeneration += 1;
  session.promptHash = hash;
  session.promptStartedAt = now;
  session.promptOpenSince = now / 1000;
}

export function matchesSessionGeneration(session, expected) {
  return Boolean(session && expected) && (!Object.hasOwn(expected, "promptId") || session.promptId === expected.promptId) &&
    session.promptGeneration === expected.promptGeneration &&
    session.authGeneration === expected.authGeneration;
}

export function isPromptOpen(session, now = Date.now()) {
  const lastActivity = session?.lastActivityAt ?? session?.promptOpenSince;
  return Number.isFinite(session?.promptOpenSince) && Number.isFinite(lastActivity) &&
    now / 1000 - lastActivity < 30 * 60;
}

export async function loadRuntimeState(runtimeFilePath) {
  const initial = { sessions: {}, discoveredTools: [] };
  const raw = await readJson(runtimeFilePath, initial);
  const sessions = raw && typeof raw === "object" && raw.sessions && typeof raw.sessions === "object"
    ? raw.sessions
    : {};
  const discoveredTools = Array.isArray(raw?.discoveredTools)
    ? raw.discoveredTools
    : [];
  return { sessions, discoveredTools };
}

export function getSession(runtimeState, sessionId) {
  if (!sessionId) {
    return undefined;
  }
  return runtimeState.sessions[sessionId];
}

export function upsertSession(runtimeState, sessionId, patch) {
  const prev = getSession(runtimeState, sessionId) || {};
  let legacyPlanId;
  if (!Object.hasOwn(prev, "countedPlanId") && !Object.hasOwn(prev, "tokenPlanId") && prev.intentTokenRaw) {
    try {
      const token = JSON.parse(prev.intentTokenRaw);
      legacyPlanId = token.planId || token.plan_id || token.rawToken?.plan_id;
    } catch { /* An unreadable token cannot establish the old session's plan context. */ }
  }
  runtimeState.sessions[sessionId] = {
    ...SESSION_DEFAULTS,
    ...prev,
    ...(legacyPlanId ? { tokenPlanId: legacyPlanId } : {}),
    ...patch,
    updatedAt: nowEpochSeconds()
  };
  return runtimeState.sessions[sessionId];
}

export function pruneSessions(runtimeState) {
  const now = nowEpochSeconds();
  for (const [sessionId, session] of Object.entries(runtimeState.sessions)) {
    const updatedAt = Number.isFinite(session.updatedAt) ? session.updatedAt : 0;
    if (now - updatedAt > MAX_SESSION_AGE_SECONDS) {
      delete runtimeState.sessions[sessionId];
    }
  }
}

export async function saveRuntimeState(runtimeFilePath, runtimeState) {
  pruneSessions(runtimeState);
  await writeJson(runtimeFilePath, runtimeState);
}

export function upsertDiscoveredTool(runtimeState, toolName) {
  if (!toolName || typeof toolName !== "string") return;
  const name = toolName.trim();
  if (!name) return;
  if (!Array.isArray(runtimeState.discoveredTools)) {
    runtimeState.discoveredTools = [];
  }
  const normalized = name.toLowerCase();
  const existing = runtimeState.discoveredTools.map((t) => t.toLowerCase());
  if (!existing.includes(normalized)) {
    runtimeState.discoveredTools.push(name);
  }
}

export function getDiscoveredTools(runtimeState) {
  return Array.isArray(runtimeState?.discoveredTools)
    ? runtimeState.discoveredTools
    : [];
}

