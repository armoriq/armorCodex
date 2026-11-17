import { createHash } from "node:crypto";
import { readFile, unlink } from "node:fs/promises";
import path from "node:path";
import { isPlainObject, normalizeToolName } from "./common.mjs";
import { readJson, writeJson, writePrivateFile } from "./fs-store.mjs";
import { VERDICT_RANK } from "./v2-decision.mjs";

const HOLD_RELEASE_MS = 10 * 60 * 1000;

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
        source: "v2",
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
    Object.entries(isPlainObject(holds) ? holds : {}).filter(([, h]) => now - (h?.at ?? 0) < HOLD_RELEASE_MS)
  );
}

/**
 * Codex PreToolUse cannot ask the user, and it does not show whether a call
 * requested escalation, so a held call is first refused with instructions to
 * re-run it with escalated permissions. Codex only runs an escalated command
 * after its approval prompt, where the PermissionRequest hook leaves the
 * decision to the person. The identical retry in the same turn is let through
 * once; whether it then reached a prompt is recorded on its audit row.
 */
export async function resolveHold(config, input, decision) {
  const toolName = input.tool_name;
  const name = decision.record.policy_name ? `"${decision.record.policy_name}" ` : "";
  const head = `ArmorIQ policy ${name}holds ${toolName} for approval (${decision.reason})`;
  if (input.permission_mode !== "default") {
    return { action: "block", reason: `${head}. Approvals are off in this Codex session, so it is blocked` };
  }
  if (normalizeToolName(toolName) !== "bash") {
    return {
      action: "block",
      reason: `${head}. Codex can only route shell commands to an approval prompt, so it is blocked`
    };
  }
  const sessionId = typeof input.session_id === "string" ? input.session_id : "";
  const shape = callShape(toolName, input.tool_input);
  const holds = await readHolds(config, sessionId);
  const turn = typeof input.turn_id === "string" ? input.turn_id : "";
  if (holds[shape]?.state === "held" && holds[shape].turn === turn) {
    holds[shape] = { state: "released", at: Date.now(), turn };
    await writeJson(holdsPath(config, sessionId), holds);
    return { action: "release" };
  }
  holds[shape] = { state: "held", at: Date.now(), turn };
  await writeJson(holdsPath(config, sessionId), holds);
  return {
    action: "block",
    reason:
      `${head}. Re-run the same command with escalated permissions (sandbox_permissions: require_escalated) ` +
      "and a justification, so the user can approve or decline it in Codex"
  };
}

/** True, and noted, when this approval prompt is for a call PreToolUse released under a hold. */
export async function markHoldPrompted(config, input) {
  const sessionId = typeof input.session_id === "string" ? input.session_id : "";
  const shape = callShape(input.tool_name, input.tool_input);
  const holds = await readHolds(config, sessionId);
  if (holds[shape]?.state !== "released") return false;
  holds[shape] = { ...holds[shape], state: "prompted" };
  await writeJson(holdsPath(config, sessionId), holds);
  return true;
}

/** How a released hold ended once its call ran: through Codex's prompt, or without one. */
export async function settleHold(config, input) {
  const sessionId = typeof input.session_id === "string" ? input.session_id : "";
  if (typeof input.tool_name !== "string") return undefined;
  const shape = callShape(input.tool_name, input.tool_input);
  const holds = await readHolds(config, sessionId);
  const state = holds[shape]?.state;
  if (state !== "released" && state !== "prompted") return undefined;
  delete holds[shape];
  await writeJson(holdsPath(config, sessionId), holds);
  if (state === "released") {
    process.stderr.write(
      `[armorcodex] held ${input.tool_name} call ran without a Codex approval prompt (it was not re-run with escalated permissions)\n`
    );
    return "ran_without_prompt";
  }
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
