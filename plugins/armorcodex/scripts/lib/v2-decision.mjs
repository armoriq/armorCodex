import { createHash } from "node:crypto";
import path from "node:path";
import { buildAuthHeaders, isPlainObject } from "./common.mjs";
import { classifyStatus, recordBackendOutcome } from "./backend-posture.mjs";
import { appendNdjsonLine, readJson, writeJson } from "./fs-store.mjs";
import { sdkModule, sdkPeer } from "./sdk.mjs";

export const VERDICT_RANK = { allow: 0, hold: 1, block: 2 };
const BUNDLE_TIMEOUT_MS = 5000;

const bundleFile = (config) => path.join(config.dataDir, "policy-bundle.json");
const keyFingerprint = (apiKey) => createHash("sha256").update(apiKey).digest("hex").slice(0, 16);

function bundleHttpClient(config, outcome) {
  return {
    async get(url, { params = {}, headers = {} } = {}) {
      const target = new URL(url);
      for (const [name, value] of Object.entries(params)) target.searchParams.set(name, value);
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), BUNDLE_TIMEOUT_MS);
      try {
        // fetch joins header names case-insensitively, so one spelling of the key.
        const { "x-api-key": _dup, ...auth } = buildAuthHeaders(config);
        const res = await fetch(target, {
          headers: { ...auth, ...headers },
          signal: controller.signal
        }).catch(async (error) => {
          await recordBackendOutcome(config, "unreachable");
          throw error;
        });
        outcome.status = res.status;
        if (res.status === 401 || res.status >= 500) await recordBackendOutcome(config, classifyStatus(res.status));
        const data = res.status === 200 ? await res.json() : undefined;
        return { status: res.status, data, headers: { etag: res.headers.get("etag") ?? "" } };
      } finally {
        clearTimeout(timer);
      }
    }
  };
}

/**
 * The SDK's PolicyBundleCache keeps the bundle in memory, but every Codex hook
 * is a new process, so the cached entry is carried between hooks on disk. That
 * keeps the 60 second revalidation and the ETag round trip instead of fetching
 * the bundle on every tool call.
 */
async function currentBundle(config) {
  const { PolicyBundleCache, BUNDLE_REVALIDATE_MS } = sdkModule("policy-bundle");
  if (typeof PolicyBundleCache !== "function") return { state: { status: "unavailable" }, outcome: {} };
  const agentId = config.policyAgentId;
  const identity = { backend: config.backendEndpoint, key: keyFingerprint(config.apiKey), agentId };
  const outcome = {};
  const cache = new PolicyBundleCache(() => ({
    httpClient: bundleHttpClient(config, outcome),
    backendEndpoint: config.backendEndpoint,
    apiKey: config.apiKey,
    agentId
  }));
  const saved = await readJson(bundleFile(config), null);
  const matches =
    saved?.backend === identity.backend && saved.key === identity.key && saved.agentId === agentId;
  // A confirmation time in the future (clock moved back, or a hand-written
  // file) would never revalidate, so such an entry is refetched.
  if (matches && isPlainObject(saved.entry) && !(saved.entry.confirmedAt > Date.now())) cache.cached = saved.entry;
  const before = matches ? saved.entry?.confirmedAt : undefined;
  await cache.refresh(BUNDLE_REVALIDATE_MS);
  if (cache.cached && cache.cached.confirmedAt !== before) {
    await writeJson(bundleFile(config), { ...identity, entry: cache.cached }).catch((error) =>
      process.stderr.write(`[armorcodex] policy bundle not cached: ${error?.message ?? error}\n`)
    );
  }
  return { state: cache.state(), outcome };
}

/** The agent's v2 documents: `policies[]` when the backend sends it, else the legacy single policy. */
export function bundleEntries(agent) {
  if (Array.isArray(agent?.policies)) return agent.policies.filter((entry) => isPlainObject(entry?.document));
  return agent?.policy ? [{ ...agent.policy, targetType: "agent", status: "active" }] : [];
}

function mcpCall(toolName) {
  const match = /^mcp__(.+?)__(.+)$/i.exec(toolName.trim());
  return match ? { tool: match[2], mcpServer: match[1] } : { tool: toolName, mcpServer: undefined };
}

function callInputs(agent, { tool, mcpServer, args, userEmail }) {
  const base = {
    tool,
    arguments: args,
    schemaHash: null,
    capabilities: [],
    timestamp: new Date().toISOString()
  };
  if (userEmail) {
    const known = (agent.members || []).find((m) => m.email === userEmail.trim().toLowerCase());
    base.member = { email: userEmail, ...(known ? { membershipId: known.membershipId } : {}) };
  }
  const named = (agent.tools || []).filter((t) => t.name === tool || t.qualifiedName === tool);
  const owned = mcpServer ? named.filter((t) => t.server === mcpServer) : [];
  const known = owned.length ? owned : named;
  if (!known.length) return [base];
  return known.map((t) => ({ ...base, schemaHash: t.schemaHash, capabilities: t.capabilities }));
}

function evaluateLayers(evaluate, inputs, bound) {
  return inputs
    .map((input) => evaluate(input, bound))
    .reduce((best, next) => (VERDICT_RANK[next.verdict] > VERDICT_RANK[best.verdict] ? next : best));
}

function layered(entries, status) {
  const pick = (target) => entries.find((e) => e.targetType === target && e.status === status);
  return { floor: pick("org"), agent: pick("agent") };
}

function boundOf(layers) {
  const bound = {};
  if (layers.floor) bound.floor = layers.floor.document;
  if (layers.agent) bound.agent = layers.agent.document;
  return bound;
}

function decidingEntry(evaluation, layers) {
  const byId = [layers.floor, layers.agent].find((e) => e && e.policyId === evaluation.provenance?.policyId);
  if (byId) return byId;
  if (layers.floor && evaluation.floorVerdict === evaluation.verdict) return layers.floor;
  return layers.agent ?? layers.floor;
}

function ruleOf(evaluation) {
  const p = evaluation.provenance;
  return p?.statementId ? `${p.ruleKey}#${p.variant}` : "tools.default";
}

/**
 * The org's v2 verdict for this call, decided locally from the bundle with the
 * same evaluator conmap uses. Returns null when no v2 policy applies, so the
 * caller falls back to the local armor.policy.v1 file.
 */
export async function decideV2(config, toolName, toolArgs) {
  if (config.policyV2Enabled === false || !config.apiKey || !config.backendEndpoint) return null;
  const { state, outcome } = await currentBundle(config);
  if (state.status !== "current") {
    // The backend answered and has no bundle for this key (no org, or an older
    // backend without the endpoint): nothing to enforce, so the local policy decides.
    if (outcome.status === 403 || outcome.status === 404) return null;
    if (outcome.status === 401) return null;
    return {
      verdict: "block",
      reason: `policy-bundle-${state.status}: the ArmorIQ policy bundle could not be loaded`
    };
  }
  const agent = state.agent;
  if (!agent) return null;
  const entries = bundleEntries(agent);
  const active = layered(entries, "active");
  const shadows = entries.filter((e) => e.status === "shadow");
  if (!active.floor && !active.agent && !shadows.length) {
    return agent.inactive ? { verdict: "block", reason: "agent_inactive" } : null;
  }

  const { evaluate } = sdkPeer("@armoriq/policy-ir");
  const call = { ...mcpCall(toolName), args: isPlainObject(toolArgs) ? toolArgs : {}, userEmail: config.userEmail };
  const inputs = callInputs(agent, call);

  const shadow = shadows.flatMap((entry) => {
    const layers = { ...active, [entry.targetType === "org" ? "floor" : "agent"]: entry };
    try {
      const evaluation = evaluateLayers(evaluate, inputs, boundOf(layers));
      return [{ policy_id: entry.policyId, policy_name: entry.name, verdict: evaluation.verdict, rule_id: ruleOf(evaluation) }];
    } catch (error) {
      process.stderr.write(`[armorcodex] shadow policy "${entry.name}" not evaluated: ${error?.message ?? error}\n`);
      return [];
    }
  });

  if (!active.floor && !active.agent) {
    return agent.inactive ? { verdict: "block", reason: "agent_inactive", shadow } : { verdict: null, shadow };
  }
  const evaluation = evaluateLayers(evaluate, inputs, boundOf(active));
  const entry = decidingEntry(evaluation, active);
  return {
    verdict: evaluation.verdict,
    reason: `${evaluation.verdict}:${ruleOf(evaluation)}`,
    policyId: entry?.policyId,
    policyName: entry?.name,
    policyHash: entry?.policyHash ?? undefined,
    ruleId: ruleOf(evaluation),
    targetType: entry?.targetType,
    shadow
  };
}

export async function logShadow(config, toolName, sessionId, shadow, activeVerdict) {
  for (const s of shadow.filter((entry) => entry.verdict !== activeVerdict)) {
    process.stderr.write(
      `[armorcodex] shadow policy "${s.policy_name}" would ${s.verdict} ${toolName} (${s.rule_id}); not enforced\n`
    );
  }
  await appendNdjsonLine(path.join(config.dataDir, "policy-shadow.jsonl"), {
    at: new Date().toISOString(),
    session_id: sessionId,
    tool: toolName,
    active: activeVerdict,
    shadow
  }).catch((error) => process.stderr.write(`[armorcodex] shadow log not written: ${error?.message ?? error}\n`));
}
