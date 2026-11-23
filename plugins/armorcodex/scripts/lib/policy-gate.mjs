import { createHash } from "node:crypto";
import { readFile, unlink } from "node:fs/promises";
import path from "node:path";
import { buildAuthHeaders, isPlainObject, normalizeToolName, postJson } from "./common.mjs";
import { readJson, writeJson, writePrivateFile } from "./fs-store.mjs";
import { VERDICT_RANK, mcpCall } from "./v2-decision.mjs";

const HOLD_MEMORY_MS = 60 * 60 * 1000;

/**
 * The stricter of the org's v2 verdict and the local armor.policy.v1 decision.
 * A local require_approval stays a block, as it always has been on Codex.
 */
export function combinePolicyDecisions(v2, local) {
  const localVerdict = local.allowed ? "allow" : "block";
  const shadow = v2?.shadow?.length ? v2.shadow : undefined;
  if (v2?.verdict && VERDICT_RANK[v2.verdict] >= VERDICT_RANK[localVerdict]) {
    return {
      verdict: v2.verdict,
      reason: v2.reason,
      localBlocks: localVerdict === "block",
      record: {
        source: v2.verdict === "allow" && !v2.policyId ? "default" : "v2",
        policy_id: v2.policyId,
        policy_name: v2.policyName,
        policy_hash: v2.policyHash,
        rule_id: v2.ruleId,
        shadow
      }
    };
  }
  const matched = local.matchedRule?.id;
  return {
    verdict: localVerdict,
    reason: local.reason,
    record: {
      source: matched || local.effect !== "default" ? "local" : "default",
      ...(matched ? { policy_name: matched, rule_id: matched } : {}),
      shadow
    }
  };
}

export function v2BlockReason(toolName, decision, verb = "blocked") {
  const name = decision.record.policy_name;
  return name
    ? `ArmorIQ policy "${name}" ${verb} ${toolName} (${decision.reason})`
    : `ArmorIQ policy ${verb} ${toolName} (${decision.reason})`;
}

function callShape(toolName, toolInput) {
  const input = isPlainObject(toolInput) ? toolInput : {};
  const { description: _description, ...rest } = input;
  const subject = normalizeToolName(toolName) === "bash" ? String(rest.command ?? "") : rest;
  return createHash("sha256")
    .update(JSON.stringify([normalizeToolName(toolName), subject]))
    .digest("hex")
    .slice(0, 32);
}

const holdsPath = (config, sessionId) =>
  path.join(config.dataDir, "policy-holds", `${createHash("sha256").update(sessionId).digest("hex").slice(0, 32)}.json`);

async function readHolds(config, sessionId) {
  const holds = await readJson(holdsPath(config, sessionId), {});
  const now = Date.now();
  return Object.fromEntries(
    Object.entries(isPlainObject(holds) ? holds : {}).filter(([, h]) => now - (h?.at ?? 0) < HOLD_MEMORY_MS)
  );
}

function signedToken(intentTokenRaw) {
  try {
    const token = JSON.parse(intentTokenRaw);
    const jwt = typeof token.jwtToken === "string" ? token.jwtToken : "";
    let claims = {};
    try {
      claims = JSON.parse(Buffer.from(jwt.split(".")[1] ?? "", "base64url").toString("utf8"));
    } catch {
      claims = {};
    }
    const planId = token.planId ?? token.rawToken?.plan_id ?? claims.plan_id;
    return jwt && typeof planId === "string" ? { jwt_token: jwt, plan_id: planId, agentId: claims.agent_id } : null;
  } catch {
    return null;
  }
}

async function fileDelegation(config, { holds, key, callId, token, tool, domain, args, reason }) {
  if (holds[key]?.delegationId) return { delegationId: holds[key].delegationId };
  if (!config.userEmail) return { error: "the signed-in ArmorIQ profile has no email" };
  const headers = { ...buildAuthHeaders(config), "X-User-Email": config.userEmail };
  const timeout = config.timeoutMs || 8000;
  const role = await getJson(`${config.backendEndpoint}/delegation/my-role`, headers, timeout).catch(() => null);
  const res = await postJson(
    `${config.backendEndpoint}/delegation/request`,
    {
      tool,
      action: "execute",
      arguments: args,
      requesterEmail: config.userEmail,
      requesterRole: role?.role || "agent_user",
      requesterLimit: Number(role?.limit) || 0,
      domain,
      planId: token.plan_id,
      reason
    },
    headers,
    timeout
  );
  const body = unwrap(res.data);
  if (!res.ok || typeof body?.delegationId !== "string") {
    return { error: `HTTP ${res.status}${body?.message ? `: ${body.message}` : ""}` };
  }
  holds[key] = { state: "requested", delegationId: body.delegationId, callId, token, at: Date.now() };
  return { delegationId: body.delegationId };
}

async function enforceUnder(config, token, { tool, domain, args }) {
  const res = await postJson(
    `${config.backendEndpoint}/iap/sdk/enforce`,
    {
      tool,
      mcp: domain,
      arguments: args,
      intent_token: { jwt_token: token.jwt_token, plan_id: token.plan_id },
      agent_id: token.agentId || config.agentId,
      user_email: config.userEmail || undefined
    },
    buildAuthHeaders(config),
    config.timeoutMs || 8000
  );
  return { ok: res.ok, status: res.status, verdict: unwrap(res.data) ?? {} };
}

/**
 * The request this session filed for the same call under an earlier plan. Codex
 * registers a new plan every turn, while the backend spends an approval only under
 * the plan it was filed for, so an approved one is spent with that plan's token.
 */
async function earlierRequest(config, holds, callId, call, planId) {
  const [key, entry] = Object.entries(holds)
    .filter(([, h]) => h?.callId === callId && h.delegationId && h.token && h.token.plan_id !== planId)
    .sort(([, a], [, b]) => b.at - a.at)[0] ?? [];
  if (!entry) return null;
  delete holds[key];
  const url = `${config.backendEndpoint}/delegation/${encodeURIComponent(entry.delegationId)}/status`;
  const status = (await getJson(url, buildAuthHeaders(config), config.timeoutMs || 8000).catch(() => null))?.status;
  if (status === "pending") {
    holds[key] = entry;
    return { delegationId: entry.delegationId };
  }
  if (status !== "approved") return null;
  const res = await enforceUnder(config, entry.token, call);
  return res.ok && res.verdict.allowed === true ? { verdict: res.verdict } : null;
}

async function getJson(url, headers, timeoutMs) {
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(timeoutMs) });
  return res.ok ? unwrap(await res.json()) : null;
}

const unwrap = (data) => (isPlainObject(data?.data) && !("allowed" in data) && !("delegationId" in data) ? data.data : data);

/**
 * A held call is decided by the workspace: the backend's enforce either spends an
 * approval another member granted for this exact call (plan, tool, arguments), or
 * the call is stopped and an approval request is filed for it. Any failure stops it.
 */
export async function resolveHold(config, input, decision, intentTokenRaw) {
  const toolName = input.tool_name;
  const name = decision.record.policy_name ? `"${decision.record.policy_name}" ` : "";
  const head = `ArmorIQ policy ${name}holds ${toolName} for approval (${decision.reason})`;
  const token = intentTokenRaw ? signedToken(intentTokenRaw) : null;
  if (!token) {
    return {
      action: "block",
      reason: `${head}. This session has no signed intent plan to attach an approval request to: call register_intent_plan, then retry`
    };
  }
  const { tool, mcpServer } = mcpCall(toolName);
  const domain = mcpServer ?? config.mcpName;
  const args = isPlainObject(input.tool_input) ? input.tool_input : {};
  const sessionId = typeof input.session_id === "string" ? input.session_id : "";
  const holds = await readHolds(config, sessionId);
  const call = { tool, domain, args };
  const callId = createHash("sha256").update(JSON.stringify([domain, tool, args])).digest("hex").slice(0, 32);
  const key = createHash("sha256").update(JSON.stringify([token.plan_id, domain, tool, args])).digest("hex").slice(0, 32);
  const approve = async (verdict) => {
    const delegationId = verdict.metadata?.delegationId;
    delete holds[key];
    holds[callShape(toolName, input.tool_input)] = { state: "approved", delegationId, at: Date.now() };
    await writeJson(holdsPath(config, sessionId), holds);
    return { action: "allow", delegationId };
  };
  const waiting = (delegationId) => ({
    action: "block",
    delegationId,
    reason:
      `${head}. Approval request ${delegationId} is waiting for another member of the workspace; ` +
      "retry the same call unchanged after it is approved"
  });
  try {
    const { ok, status, verdict } = await enforceUnder(config, token, call);
    if (!ok) return { action: "block", reason: `${head}. The approval check failed (HTTP ${status}), so it is blocked` };
    if (verdict.allowed === true) return await approve(verdict);
    if (verdict.enforcementAction !== "hold") {
      return { action: "block", reason: `${head}. ${verdict.message || verdict.reason || "The approval check blocked it"}` };
    }
    const earlier = await earlierRequest(config, holds, callId, call, token.plan_id);
    if (earlier?.verdict) return await approve(earlier.verdict);
    if (earlier?.delegationId) {
      await writeJson(holdsPath(config, sessionId), holds);
      return waiting(earlier.delegationId);
    }
    const filed = await fileDelegation(config, { holds, key, callId, token, tool, domain, args, reason: verdict.reason });
    await writeJson(holdsPath(config, sessionId), holds);
    if (!filed.delegationId) {
      return { action: "block", reason: `${head}. The approval request could not be filed (${filed.error}), so it is blocked` };
    }
    return waiting(filed.delegationId);
  } catch (error) {
    return {
      action: "block",
      reason: `${head}. The approval check failed (${error instanceof Error ? error.message : error}), so it is blocked`
    };
  }
}

/** The workspace approval PreToolUse spent for this call, if any. */
export async function approvedHold(config, input) {
  const sessionId = typeof input.session_id === "string" ? input.session_id : "";
  const holds = await readHolds(config, sessionId);
  const hold = holds[callShape(input.tool_name, input.tool_input)];
  return hold?.state === "approved" ? hold : undefined;
}

/** "approved" once a call that ran on a spent workspace approval finishes. */
export async function settleHold(config, input) {
  const sessionId = typeof input.session_id === "string" ? input.session_id : "";
  if (typeof input.tool_name !== "string") return undefined;
  const shape = callShape(input.tool_name, input.tool_input);
  const holds = await readHolds(config, sessionId);
  if (holds[shape]?.state !== "approved") return undefined;
  delete holds[shape];
  await writeJson(holdsPath(config, sessionId), holds);
  return "approved";
}

const decisionPath = (config, toolUseId) =>
  typeof toolUseId === "string" && /^[A-Za-z0-9_-]+$/.test(toolUseId)
    ? path.join(config.dataDir, "policy-decisions", toolUseId)
    : null;

export async function savePolicyRecord(config, toolUseId, record) {
  const file = decisionPath(config, toolUseId);
  if (file && config.auditEnabled && config.apiKey) {
    await writePrivateFile(file, JSON.stringify(record)).catch(() => {});
  }
}

export async function takePolicyRecord(config, toolUseId) {
  const file = decisionPath(config, toolUseId);
  if (!file) return undefined;
  const text = await readFile(file, "utf8").catch(() => "");
  await unlink(file).catch(() => {});
  try {
    return text ? JSON.parse(text) : undefined;
  } catch {
    return undefined;
  }
}

export function withPolicyRecord(input, record, hold) {
  if (!record && !hold) return input;
  const clean = Object.fromEntries(Object.entries({ ...record, hold }).filter(([, v]) => v !== undefined));
  return isPlainObject(input) ? { ...input, armoriq_policy: clean } : { value: input, armoriq_policy: clean };
}
