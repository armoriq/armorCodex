import { isPlainObject, normalizeToolName, nowEpochSeconds, redactSecrets, sanitizeParams } from "./common.mjs";
import { addPromptContext, blockPrompt, denyPermissionRequest, denyPreTool, withSystemMessage } from "./hook-output.mjs";
import {
  checkIntentTokenPlan,
  checkToolAgainstPlan,
  extractAllowedActions,
  findPlanStepIndices,
  getSessionTokenUsedStepIndices,
  parseCsrgProofHeaders,
  recordSessionTokenUsedStepIndices,
  resolveCsrgProofsFromToken,
  validateCsrgProofHeaders
} from "./intent.mjs";
import { createIapService } from "./iap-service.mjs";
import {
  applyPolicyCommand,
  computePolicyHash,
  evaluatePolicy,
  loadPolicyState,
  parsePolicyTextCommand,
  POLICY_UNREADABLE_NOTICE
} from "./policy.mjs";
import { handleArmorPolicyCommand, isArmorPolicyCommand } from "./armor-policy-commands.mjs";
import { createAuditWal, fitAuditRow } from "./audit-wal.mjs";
import {
  BACKEND_UNREACHABLE,
  backendPosture,
  formatArmorStatus,
  isStatusCommand,
  localOnly,
  toolCapability,
  unreachableReason
} from "./backend-posture.mjs";
import { appendNdjsonLine, readJson, writePrivateFile } from "./fs-store.mjs";
import { readFile, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { autoUpdate } from "./update-apply.mjs";
import { monitorNote, orgMonitorFor, refreshOrgMode, rememberWouldBe, takeWouldBe } from "./org-mode.mjs";
import { invokesPolicyAdmin, isProtectedPath, writesProtectedPath } from "./shell-guard.mjs";
import { VERDICT_RANK, decideV2, logShadow } from "./v2-decision.mjs";
import {
  approvedHold,
  combinePolicyDecisions,
  resolveHold,
  savePolicyRecord,
  settleHold,
  takePolicyRecord,
  v2BlockReason,
  withPolicyRecord
} from "./policy-gate.mjs";
import path from "node:path";
import {
  getSession,
  loadRuntimeState,
  saveRuntimeState,
  upsertDiscoveredTool,
  upsertSession
} from "./runtime-state.mjs";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function shouldDeny(config) {
  return config.mode === "enforce";
}

function buildPolicyContextHints() {
  return "For policy changes call `policy_update` or `policy_command`: they only stage a change, which the user reviews and applies with `armor policy confirm <id>`.";
}

function actorCandidates(input) {
  const out = [];
  for (const key of ["session_id", "user_id", "actor_id", "cwd"]) {
    const value = input && typeof input[key] === "string" ? input[key].trim() : "";
    if (value) {
      out.push(value);
    }
  }
  return out;
}

function policyCommandLooksLikePrompt(prompt) {
  return typeof prompt === "string" && /^\s*policy\b/i.test(prompt);
}

function isPolicyUpdateAllowed(config, input) {
  if (!config.policyUpdateEnabled) {
    return { allowed: false, reason: "ArmorCodex policy updates disabled" };
  }
  const allowList = config.policyUpdateAllowList;
  if (!Array.isArray(allowList) || allowList.length === 0 || allowList.includes("*")) {
    return { allowed: true };
  }
  const candidates = actorCandidates(input);
  const allowed = candidates.some((entry) => allowList.includes(entry));
  return allowed
    ? { allowed: true }
    : {
        allowed: false,
        reason: "ArmorCodex policy update denied",
        candidates
      };
}

const MCP_TOOL_RE = /^mcp__(.+?)__(.+)$/i;

function ruleNamesTool(ruleTool, toolName) {
  const rule = normalizeToolName(ruleTool);
  const tool = normalizeToolName(toolName);
  if (rule.length > 1 && rule.endsWith("*")) return tool.startsWith(rule.slice(0, -1));
  return rule === tool;
}

const MCP_RESOURCE_TOOLS = new Set(["list_mcp_resources", "list_mcp_resource_templates", "read_mcp_resource"]);

function mcpServerCall(toolName, toolInput) {
  const match = MCP_TOOL_RE.exec(toolName);
  if (match) return { server: match[1], tool: toolName };
  if (!MCP_RESOURCE_TOOLS.has(normalizeToolName(toolName))) return null;
  const server = typeof toolInput?.server === "string" ? toolInput.server.trim() : "";
  return { server: server || "*", tool: server ? `mcp__${server}__*` : "" };
}

function unapprovedMcpServer(toolName, toolInput, rules) {
  const call = mcpServerCall(toolName, toolInput);
  if (!call) return "";
  if (!call.tool) return call.server;
  const approved = rules.some(
    (rule) =>
      rule.action === "allow" &&
      rule.tool !== "*" &&
      !rule.params &&
      !rule.anyParam &&
      !rule.dataClass &&
      !rule.conditions?.length &&
      ruleNamesTool(rule.tool, call.tool)
  );
  return approved ? "" : call.server;
}

const PATCH_TARGET_RE = /^[ \t]*\*\*\* (?:Add File|Update File|Delete File|Move to): (.+)$/gm;

function patchTargets(toolInput) {
  const text = isPlainObject(toolInput)
    ? [toolInput.command, toolInput.input, toolInput.patch].find((value) => typeof value === "string") ?? ""
    : typeof toolInput === "string"
      ? toolInput
      : "";
  return [...text.matchAll(PATCH_TARGET_RE)].map((match) => match[1].trim());
}

function protectedWriteReason(norm, toolInput, cwd, config) {
  const protectedPaths = [
    config.dataDir,
    config.policyFile,
    config.runtimeFile,
    path.join(homedir(), ".armoriq", "credentials.json")
  ].filter((entry) => typeof entry === "string" && entry);
  if (norm === "bash") {
    const command = typeof toolInput?.command === "string" ? toolInput.command : "";
    if (invokesPolicyAdmin(command)) {
      return "ArmorCodex: policy management is human-only. Type `armor policy` at the Codex prompt.";
    }
    if (writesProtectedPath(command, cwd, protectedPaths)) {
      return "ArmorCodex: shell commands that write, move or delete ArmorCodex policy, state or credential files are blocked. Use policy_update, which stages a change for the user to confirm.";
    }
  }
  if (norm === "apply_patch") {
    const names = new Set(protectedPaths.map((entry) => path.basename(entry)));
    const hit = patchTargets(toolInput).some((target) => {
      if (path.isAbsolute(target)) return isProtectedPath(target, protectedPaths);
      return cwd ? isProtectedPath(path.resolve(cwd, target), protectedPaths) : names.has(path.basename(target));
    });
    if (hit) {
      return "ArmorCodex: apply_patch cannot change ArmorCodex policy, state or credential files. Use policy_update, which stages a change for the user to confirm.";
    }
  }
  return "";
}

function mergeIntentIntoSession(session, intentResponse) {
  if (!intentResponse || intentResponse.skipped) {
    return session;
  }
  const next = { ...session };
  if (typeof intentResponse.tokenRaw === "string") {
    next.intentTokenRaw = intentResponse.tokenRaw;
  }
  if (intentResponse.plan && typeof intentResponse.plan === "object") {
    next.plan = intentResponse.plan;
    next.allowedActions = Array.from(extractAllowedActions(intentResponse.plan));
  }
  if (Number.isFinite(intentResponse.expiresAt)) {
    next.expiresAt = intentResponse.expiresAt;
  }
  return next;
}

function readIntentTokenRaw(input, session) {
  const candidates = [
    input.intentTokenRaw,
    input.intent_token_raw,
    input.intent_token,
    input.intentToken,
    session.intentTokenRaw
  ];
  for (const value of candidates) {
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return "";
}

async function monitorInstead(input, config, action, reason, code = null) {
  await rememberWouldBe(config, input.tool_use_id, { action, code, reason });
  return config.orgMonitorNotices ? withSystemMessage({}, monitorNote(action, reason)) : null;
}

async function denyAndAudit(input, config, reason, errorMessage = reason, status = "blocked") {
  if (config.orgMonitor) return monitorInstead(input, config, "block", reason, errorMessage === reason ? null : errorMessage);
  await auditToolCall(input, config, { status, output: null, error_message: redactSecrets(errorMessage) }, null);
  return denyPreTool(reason);
}

function denyOrAllow(input, config, reason) {
  return shouldDeny(config) ? denyAndAudit(input, config, reason) : null;
}

async function decideV2OrBlock(config, toolName, toolInput) {
  try {
    return await decideV2(config, toolName, toolInput);
  } catch (error) {
    return { verdict: "block", reason: `policy-v2-error: ${error instanceof Error ? error.message : error}` };
  }
}

/** The org's v2 policy and the local policy file, strictest wins. */
async function decidePolicy(input, config, toolName, toolInput, { logShadows = true } = {}) {
  // v2 rules see the raw input: sanitizeParams truncates long values a rule could miss.
  const v2 = await decideV2OrBlock(config, toolName, input.tool_input);
  if (logShadows && v2?.shadow?.length) {
    await logShadow(config, toolName, input.session_id, v2.shadow, v2.verdict ?? "allow");
  }
  const policyState = await loadPolicyState(config.policyFile);
  const local = evaluatePolicy({ policy: policyState.document, toolName, toolParams: toolInput });
  return { policyState, decision: combinePolicyDecisions(v2, local) };
}

function planCheckDenial(planCheck, toolName) {
  const name = normalizeToolName(toolName);
  const denied = (planCheck?.deniedTools ?? []).find((tool) => normalizeToolName(tool) === name);
  if (!denied) return null;
  const reason = (planCheck.deniedReasons ?? []).find((line) => line.startsWith(`${denied}: `));
  return `ArmorIQ plan check denied ${toolName}${reason ? ` (${reason.slice(denied.length + 2)})` : ""}`;
}

function unenforced(record, verdict, reason) {
  const kept = record?.enforced === false && VERDICT_RANK[record.verdict] >= VERDICT_RANK[verdict];
  return {
    ...record,
    verdict: kept ? record.verdict : verdict,
    enforced: false,
    unenforced_reasons: [...(record?.unenforced_reasons ?? []), reason]
  };
}

async function recordUnenforced(input, config, record, verdict, reason) {
  const next = unenforced(record, verdict, reason);
  await savePolicyRecord(config, input.tool_use_id, next);
  return next;
}

async function enforcePlanCheck(input, config, planCheck, record) {
  const reason = planCheckDenial(planCheck, input.tool_name);
  if (!reason) return null;
  if (shouldDeny(config)) return denyAndAudit(input, config, reason);
  process.stderr.write(`[armorcodex] monitor mode: ${reason}; allowing it\n`);
  await recordUnenforced(input, config, record, "block", reason);
  await appendNdjsonLine(path.join(config.dataDir, "monitor.jsonl"), {
    at: Date.now(),
    session_id: input.session_id,
    tool: input.tool_name,
    tool_use_id: input.tool_use_id,
    reason
  }).catch((err) => process.stderr.write(`[armorcodex] monitor log not written: ${err?.message ?? err}\n`));
  return null;
}

function debugLog(config, message) {
  if (config.debug) {
    process.stderr.write(`[armorcodex] ${message}\n`);
  }
}

function matchedStepIndex(plan, toolName, toolInput) {
  if (!plan || typeof plan !== "object") return undefined;
  const { matches, paramMatches } = findPlanStepIndices(plan, toolName, toolInput);
  return paramMatches[0] ?? matches[0];
}

// ---------------------------------------------------------------------------
// SessionStart
// ---------------------------------------------------------------------------

const LOCAL_ONLY_SCOPE = "only the local policy and intent plan apply; org policies, approvals and audit upload are off";

export function sessionBanner(config, { unreadable = false, posture = null } = {}) {
  const enforcing = shouldDeny(config);
  const intent = config.intentRequired ? "required" : "optional";
  const head = `ArmorCodex active (${enforcing ? "ENFORCING" : "MONITORING"}, intent=${intent})`;
  const notes = [];
  if (unreadable) notes.push(POLICY_UNREADABLE_NOTICE);
  if (!enforcing) {
    notes.push(
      "Monitor mode: the local policy still blocks; intent drift, org policy blocks and holds, and backend outages are allowed, not blocked"
    );
  }
  if (posture === "unreachable" && enforcing) {
    notes.push("The ArmorIQ backend is not answering: every tool call except ArmorCodex's own tools is blocked until it answers");
  }
  if (config.keyRejected || posture === "signed_out") {
    notes.push(`ArmorIQ rejected the stored key: ${LOCAL_ONLY_SCOPE} until you sign in again`);
  } else if (!config.apiKey) {
    notes.push(`Not signed in to ArmorIQ: ${LOCAL_ONLY_SCOPE}`);
  } else if (config.policyV2Enabled === false) {
    notes.push("Org policies are off (ARMORCODEX_POLICY_V2=false): only the local policy and intent plan apply");
  }
  return notes.length ? `${head}. ${notes.join(". ")}.` : head;
}

export async function handleSessionStart(input, config, updateOptions = {}) {
  const sessionId = typeof input.session_id === "string" ? input.session_id : "";
  if (!sessionId) return null;

  const runtimeState = await loadRuntimeState(config.runtimeFile);
  upsertSession(runtimeState, sessionId, {
    startedAt: nowEpochSeconds(),
    discoveredTools: []
  });
  await saveRuntimeState(config.runtimeFile, runtimeState);

  debugLog(config, `session started: ${sessionId}, mode=${config.mode}`);

  await refreshOrgMode(config);
  if (config.apiKey && orgMonitorFor(config.dataDir)) {
    await autoUpdate(config, updateOptions);
    return null;
  }

  // The update notice is for the person, not the model: handed to the model it
  // reads as an instruction to run the install command mid-session.
  const update = await autoUpdate(config, updateOptions);
  const { unreadable } = config.policyFile ? await loadPolicyState(config.policyFile) : {};
  const posture = config.apiKey ? await backendPosture(config) : null;
  const banner = sessionBanner(config, { unreadable, posture });
  return withSystemMessage(
    addPromptContext(banner, "SessionStart"),
    [unreadable && POLICY_UNREADABLE_NOTICE, update.notice].filter(Boolean).join("\n") || undefined
  );
}

// ---------------------------------------------------------------------------
// UserPromptSubmit
// ---------------------------------------------------------------------------

export async function handleUserPromptSubmit(input, config) {
  const prompt = typeof input.prompt === "string" ? input.prompt : "";
  const sessionId = typeof input.session_id === "string" ? input.session_id : "";
  if (!prompt || !sessionId) {
    return null;
  }

  if (isStatusCommand(prompt)) {
    const { rows } = await createAuditWal({ dataDir: config.dataDir }).readBatch(Number.MAX_SAFE_INTEGER);
    return blockPrompt(await formatArmorStatus(config, { queuedRows: rows.length }));
  }

  // --- Structured /armor policy commands (staged proposal -> confirm) ---
  if (isArmorPolicyCommand(prompt)) {
    const allowed = isPolicyUpdateAllowed(config, input);
    if (!allowed.allowed) {
      return blockPrompt(allowed.reason || "ArmorCodex policy update denied");
    }
    const actor = actorCandidates(input)[0] || "unknown";
    const response = await handleArmorPolicyCommand(prompt, config, actor);
    if (response !== null) {
      return blockPrompt(response);
    }
  }

  // --- Natural-language `Policy ...` commands (immediate; back-compat) ---
  if (policyCommandLooksLikePrompt(prompt)) {
    const allowed = isPolicyUpdateAllowed(config, input);
    if (!allowed.allowed) {
      return blockPrompt(allowed.reason || "ArmorCodex policy update denied");
    }
    const policyState = await loadPolicyState(config.policyFile);
    const command = parsePolicyTextCommand(prompt, policyState);
    const actor = actorCandidates(input)[0] || "unknown";
    const result = await applyPolicyCommand({
      policyFilePath: config.policyFile,
      state: policyState,
      command,
      actor
    });
    return blockPrompt(result.message);
  }

  // --- Store prompt in session ---
  const runtimeState = await loadRuntimeState(config.runtimeFile);
  upsertSession(runtimeState, sessionId, {
    lastPrompt: prompt,
    lastPromptAt: nowEpochSeconds()
  });
  await saveRuntimeState(config.runtimeFile, runtimeState);

  // --- Inject directive: tell Codex to register its intent plan ---
  // Codex will call the `register_intent_plan` MCP tool as its first action.
  // The MCP tool's inputSchema already describes the JSON shape, so we don't
  // duplicate it here — keeps the visible prompt context short.
  const parts = [];
  if (config.planningEnabled) {
    parts.push(
      "ArmorCodex active. Before using any tool, call `register_intent_plan` once, " +
        "listing every tool you expect to use as a step (register them all up front). " +
        "For each step set `action` to the canonical tool name: use `Bash` for shell / " +
        "command execution (not `exec_command`), `apply_patch` for file edits, and the " +
        "exact MCP tool name for MCP calls. Set `metadata.inputs` to `{}` to match by " +
        "tool name only."
    );
  }
  if (config.contextHintsEnabled && config.policyUpdateEnabled) {
    parts.push(buildPolicyContextHints());
  }
  if (parts.length > 0) {
    return addPromptContext(parts.join("\n\n"));
  }
  return null;
}

// ---------------------------------------------------------------------------
// PreToolUse
// ---------------------------------------------------------------------------

async function readIssuedPlan(pendingPath) {
  for (;;) {
    const pending = await readJson(pendingPath, null);
    if (pending?.status !== "issuing" || !(Date.now() < pending.deadlineAt)) return pending;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

export async function handlePreToolUse(input, config) {
  const sessionId = typeof input.session_id === "string" ? input.session_id : "";
  const toolName = typeof input.tool_name === "string" ? input.tool_name : "";
  const toolInput = sanitizeParams(input.tool_input, config.sanitize);
  if (!toolName) {
    // Missing tool_name on a PreToolUse event means the payload shape is
    // unexpected. Fail-closed in enforce mode instead of silently allowing.
    return denyOrAllow(input, config, "ArmorCodex: missing tool_name on PreToolUse");
  }

  // --- Whitelist: ArmorCodex's own MCP tools must never be blocked,
  //     otherwise the agent can't register a plan or read/update policy.
  //     Match the exact MCP prefix from .mcp.json (armorcodex-policy),
  //     not any suffix — an evil server called evil__policy_update would
  //     previously have been whitelisted. ---
  const norm = normalizeToolName(toolName);
  const armorTools = ["register_intent_plan", "policy_read", "policy_update", "policy_command"];
  // Codex MCP namespace is `mcp__<server>__` and the underlying MCP server name
  // can carry hyphens (`armorcodex-policy`) or be sanitized to underscores
  // (`armorcodex_policy`). Codex's TUI display also surfaces `<server>.<tool>`
  // in user-facing strings. Match all reasonable forms — but only accept names
  // anchored to our own server identifier so this can't whitelist a malicious
  // MCP server that happens to expose a same-named tool.
  const ARMOR_SERVER_RE = /(mcp__armorcodex[-_]policy__|armorcodex[-_]policy[._])/;
  if (
    armorTools.some(
      (t) =>
        norm === t ||
        (norm.endsWith(t) && ARMOR_SERVER_RE.test(norm))
    )
  ) {
    await savePolicyRecord(config, input.tool_use_id, { source: "builtin" });
    return null;
  }

  const cwd = typeof input.cwd === "string" && input.cwd ? input.cwd : null;
  const protectedWrite = protectedWriteReason(norm, input.tool_input, cwd, config);
  if (protectedWrite) return denyAndAudit(input, config, protectedWrite);

  // Reads run while the backend is down; every other capability, the web tools
  // whitelisted below included, waits on the backend posture first.
  const capability = toolCapability(toolName);
  if (capability !== "read") {
    const posture = await backendPosture(config);
    if (posture === "unreachable") {
      const reason = unreachableReason(toolName, capability);
      if (shouldDeny(config)) return denyAndAudit(input, config, reason, BACKEND_UNREACHABLE);
      process.stderr.write(`[armorcodex] monitor mode: ${reason}; allowing it\n`);
    } else if (posture === "signed_out") {
      config = localOnly(config);
    }
  }

  // --- Whitelist: Codex introspection / coordination tools that have
  //     no side effects on user files or systems. Blocking these makes the
  //     agent fight itself (e.g. ToolSearch is needed to fetch deferred MCP
  //     tool schemas before they can be called). ---
  const safeInternalTools = new Set([
    "toolsearch",
    "todowrite",
    "listmcpresourcestool",
    "readmcpresourcetool",
    "read",
    "grep",
    "glob",
    "websearch",
    "webfetch"
  ]);
  if (safeInternalTools.has(norm)) {
    await savePolicyRecord(config, input.tool_use_id, { source: "builtin" });
    return null;
  }

  // --- Consume pending plan from register_intent_plan MCP tool ---
  // Always consume if a pending file exists — the MCP handler only writes
  // it when Codex has registered a NEW plan, and stale plans must be
  // overwritten so each prompt gets its own plan boundary.
  // This load is reused for the rest of the PreToolUse handler instead of
  // reloading from disk below (fewer disk reads on the hot path).
  const runtimeState = await loadRuntimeState(config.runtimeFile);
  const pendingPath = sessionId
    ? path.join(config.dataDir, `pending-plan.${sessionId}.json`)
    : null;
  const pending = pendingPath ? await readIssuedPlan(pendingPath) : null;
  if (pending?.status === "issuing") {
    const deny = await denyOrAllow(
      input,
      config,
      "ArmorCodex intent token was not issued in time: call register_intent_plan again, then retry the tool"
    );
    if (deny) {
      return deny;
    }
  }
  if (pending && (pending.tokenRaw || pending.plan)) {
    upsertSession(runtimeState, sessionId, {
      intentTokenRaw: pending.tokenRaw || "",
      plan: pending.plan,
      allowedActions: Array.isArray(pending.allowedActions) ? pending.allowedActions : [],
      expiresAt: pending.expiresAt,
      planCheck: pending.planCheck,
      // Reset per-token execution tracking when a new plan replaces the old.
      intentExecution: undefined
    });
    await saveRuntimeState(config.runtimeFile, runtimeState);
    await unlink(pendingPath).catch(() => {});
    debugLog(config, "consumed pending plan from register_intent_plan");
  }

  // --- Policy: org v2 bundle and local armor.policy.v1, strictest wins ---
  const { policyState, decision } = await decidePolicy(input, config, toolName, toolInput);
  let policyRecord = decision.record;
  await savePolicyRecord(config, input.tool_use_id, policyRecord);

  const mcpServer = config.mcpDenyByDefault ? unapprovedMcpServer(toolName, input.tool_input, policyState.policy.rules) : "";
  if (mcpServer) {
    const deny = await denyOrAllow(
      input,
      config,
      mcpServer === "*"
        ? "ArmorCodex: listing MCP resources across every server is blocked while unapproved MCP servers are gated. Name an approved server."
        : `ArmorCodex: MCP server "${mcpServer}" is not approved. The user can approve it by typing \`armor mcp approve ${mcpServer}\`, then \`armor yes\``
    );
    if (deny) return deny;
  }

  // Crypto policy digest check (Phase 4 integration point)
  if (config.cryptoPolicyEnabled) {
    try {
      const { createCryptoPolicyService } = await import("./crypto-policy.mjs");
      const cryptoService = createCryptoPolicyService(config);
      const currentDigest = computePolicyHash(policyState.document);
      const cachedState = await cryptoService.loadCachedState();
      if (cachedState?.policyDigest) {
        const check = cryptoService.verifyPolicyDigest(currentDigest, cachedState.policyDigest);
        if (!check.valid) {
          return denyOrAllow(input, config, `ArmorCodex crypto policy mismatch: ${check.reason}`);
        }
      }
    } catch (error) {
      debugLog(config, `crypto policy check error: ${error}`);
    }
  }

  if (decision.verdict === "block") {
    if (decision.record.source !== "v2") {
      const reason = policyState.unreadable ? POLICY_UNREADABLE_NOTICE : decision.reason;
      return denyAndAudit(input, config, reason || "ArmorCodex policy denied");
    }
    const reason = v2BlockReason(toolName, decision);
    // The local file has always blocked in monitor mode too; v2 sharing the verdict does not change that.
    if (shouldDeny(config) || decision.localBlocks) return denyAndAudit(input, config, reason);
    process.stderr.write(`[armorcodex] monitor mode: ${reason}; allowing it\n`);
    policyRecord = await recordUnenforced(input, config, policyRecord, "block", reason);
  }
  // --- Intent token verification ---
  // Reuse the runtimeState loaded above instead of re-reading from disk.
  const session = getSession(runtimeState, sessionId) || {};
  const intentTokenRaw = readIntentTokenRaw(input, session);

  if (decision.verdict === "hold" && config.orgMonitor) {
    const notice = await monitorInstead(input, config, "hold", v2BlockReason(toolName, decision, "holds"));
    if (notice) return notice;
  } else if (decision.verdict === "hold") {
    if (!shouldDeny(config)) {
      const reason = v2BlockReason(toolName, decision, "holds");
      process.stderr.write(`[armorcodex] monitor mode: ${reason}; allowing it\n`);
      policyRecord = await recordUnenforced(input, config, policyRecord, "hold", reason);
    } else {
      const held = await resolveHold(config, input, decision, intentTokenRaw);
      if (held.delegationId) {
        await savePolicyRecord(config, input.tool_use_id, { ...decision.record, delegation_id: held.delegationId });
      }
      // A blocked row fails the plan on the backend; a held one keeps it open for the approved retry.
      if (held.action === "block") return denyAndAudit(input, config, held.reason, held.reason, held.delegationId ? "held" : "blocked");
    }
  }

  const planCheckDeny = await enforcePlanCheck(input, config, session.planCheck, policyRecord);
  if (planCheckDeny) return planCheckDeny;
  let localPlan = session.plan;
  let localExpiresAt = session.expiresAt;
  let remoteAllowed = false;
  let tokenCheckMatched = false;
  const usedStepIndices =
    intentTokenRaw && localPlan
      ? getSessionTokenUsedStepIndices(session, intentTokenRaw)
      : undefined;

  // Validate tool against intent token plan
  if (intentTokenRaw) {
    const tokenCheck = checkIntentTokenPlan({
      intentTokenRaw,
      toolName,
      toolParams: toolInput
    });
    if (tokenCheck.matched) {
      tokenCheckMatched = true;
      if (tokenCheck.blockReason) {
        return denyOrAllow(input, config, tokenCheck.blockReason);
      }
      localPlan = tokenCheck.plan || localPlan;
      remoteAllowed = true;
    }
  }

  // --- CSRG proof handling ---
  const parsedProofs = parseCsrgProofHeaders(input);
  if (parsedProofs.error) {
    return denyOrAllow(input, config, parsedProofs.error);
  }
  let csrgProofs = parsedProofs.proofs;
  if (!csrgProofs && intentTokenRaw && localPlan && typeof localPlan === "object") {
    const resolved = resolveCsrgProofsFromToken({
      intentTokenRaw,
      plan: localPlan,
      toolName,
      toolParams: toolInput,
      usedStepIndices
    });
    if (resolved) {
      csrgProofs = resolved;
    }
  }
  const proofError = validateCsrgProofHeaders(
    csrgProofs,
    config.requireCsrgProofs &&
      config.csrgVerifyEnabled &&
      Boolean(config.verifyStepEndpoint) &&
      Boolean(intentTokenRaw)
  );
  if (proofError) {
    return denyOrAllow(input, config, proofError);
  }

  // --- Remote step verification ---
  if (intentTokenRaw && config.verifyStepEndpoint && config.csrgVerifyEnabled) {
    try {
      const iapService = createIapService(config);
      const verifyResult = await iapService.verifyStep(intentTokenRaw, csrgProofs, toolName);
      if (!verifyResult.skipped) {
        remoteAllowed = verifyResult.allowed === true;
      }
      if (verifyResult.allowed === false) {
        return denyOrAllow(
          input,
          config,
          verifyResult.reason || `ArmorCodex intent verification denied for ${toolName}`
        );
      }
      const merged = mergeIntentIntoSession(session, verifyResult);
      upsertSession(runtimeState, sessionId, merged);
      localPlan = merged.plan || localPlan;
      localExpiresAt = merged.expiresAt || localExpiresAt;
      if (typeof verifyResult.stepIndex === "number") {
        const indices = usedStepIndices || new Set();
        indices.add(verifyResult.stepIndex);
        recordSessionTokenUsedStepIndices(merged, intentTokenRaw, indices);
      } else if (usedStepIndices && intentTokenRaw) {
        recordSessionTokenUsedStepIndices(merged, intentTokenRaw, usedStepIndices);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const deny = await denyOrAllow(input, config, `ArmorCodex verify-step failed: ${message}`);
      if (deny) {
        return deny;
      }
    }
  }

  // --- Expiry check ---
  if (Number.isFinite(localExpiresAt) && nowEpochSeconds() > localExpiresAt) {
    const deny = await denyOrAllow(
      input,
      config,
      "ArmorCodex intent token expired — call register_intent_plan with your current plan to refresh, then retry the tool"
    );
    if (deny) {
      return deny;
    }
  }

  // --- Local plan enforcement (no backend / no token) ---
  // When a plan was registered via register_intent_plan but ArmorIQ is not
  // configured, enforce the plan locally: tool must be in plan, and params
  // (if declared in step.metadata.inputs) must match.
  let localPlanMatched = false;
  if (!intentTokenRaw && localPlan && typeof localPlan === "object") {
    const localCheck = checkToolAgainstPlan({
      plan: localPlan,
      toolName,
      toolInput
    });
    if (localCheck.allowed) {
      localPlanMatched = true;
    } else {
      const deny = await denyOrAllow(input, config, localCheck.reason || "ArmorCodex intent drift");
      if (deny) {
        return deny;
      }
    }
  }

  // --- Enforce intent requirement ---
  if (config.intentRequired && !remoteAllowed && !tokenCheckMatched && !localPlanMatched) {
    const deny = await denyOrAllow(
      input,
      config,
      "ArmorCodex intent plan missing for this session: call register_intent_plan first, then retry the tool"
    );
    if (deny) {
      return deny;
    }
  }

  // --- Record tool for discovery ---
  upsertDiscoveredTool(runtimeState, toolName);
  await saveRuntimeState(config.runtimeFile, runtimeState);
  await recordToolStart(config, input.tool_use_id);
  return null;
}

// ---------------------------------------------------------------------------
// PermissionRequest
// ---------------------------------------------------------------------------

export async function handlePermissionRequest(input, config) {
  const toolName = typeof input.tool_name === "string" ? input.tool_name : "";
  const toolInput = sanitizeParams(input.tool_input, config.sanitize);
  if (!toolName || config.orgMonitor) {
    return null;
  }

  const { decision } = await decidePolicy(input, config, toolName, toolInput, { logShadows: false });
  if (decision.verdict === "hold") {
    const approved = await approvedHold(config, input);
    if (approved) {
      const request = approved.delegationId ? ` (request ${approved.delegationId})` : "";
      return withSystemMessage({}, `ArmorIQ: a workspace member approved this ${toolName} call${request}.`);
    }
  }
  if (decision.verdict !== "allow" && shouldDeny(config)) {
    const reason =
      decision.record.source === "v2"
        ? v2BlockReason(toolName, decision)
        : decision.reason || "ArmorCodex policy denied approval request";
    await auditToolCall(input, config, { status: "blocked", output: null, error_message: reason }, null, undefined, decision.record);
    return denyPermissionRequest(reason);
  }

  return null;
}

// ---------------------------------------------------------------------------
// PostToolUse — audit logging
// ---------------------------------------------------------------------------

function auditLink(config, sessionId, intentTokenRaw) {
  let planId;
  try {
    planId = JSON.parse(intentTokenRaw).planId;
  } catch {
    planId = undefined;
  }
  return {
    plan_id: planId,
    session_id: sessionId,
    user_id: config.userId,
    agent_id: config.agentId,
    client_id: config.mcpName || config.llmId
  };
}

const toolStartPath = (config, toolUseId) =>
  typeof toolUseId === "string" && /^[A-Za-z0-9_-]+$/.test(toolUseId)
    ? path.join(config.dataDir, "tool-starts", toolUseId)
    : null;

async function recordToolStart(config, toolUseId) {
  const startPath = toolStartPath(config, toolUseId);
  if (startPath && config.auditEnabled && config.apiKey) {
    await writePrivateFile(startPath, String(Date.now())).catch(() => {});
  }
}

async function takeToolDuration(config, toolUseId) {
  const startPath = toolStartPath(config, toolUseId);
  if (!startPath) return undefined;
  const started = Number(await readFile(startPath, "utf8").catch(() => ""));
  await unlink(startPath).catch(() => {});
  return started > 0 ? Date.now() - started : undefined;
}

async function buildAuditRow(input, config, outcome, unknownStep, hold, record) {
  const toolName = input.tool_name;
  const sessionId = typeof input.session_id === "string" ? input.session_id : "";
  const session = getSession(await loadRuntimeState(config.runtimeFile), sessionId) || {};
  const inputs = sanitizeParams(input.tool_input, config.sanitize);
  const wouldBe = await takeWouldBe(config, input.tool_use_id);
  return fitAuditRow({
    ...auditLink(config, sessionId, session.intentTokenRaw || ""),
    step_index: matchedStepIndex(session.plan, toolName, inputs) ?? unknownStep,
    action: toolName,
    tool: toolName,
    capability: toolCapability(toolName),
    input: withPolicyRecord(redactSecrets(inputs), record ?? (await takePolicyRecord(config, input.tool_use_id)), hold),
    executed_at: new Date().toISOString(),
    duration_ms: await takeToolDuration(config, input.tool_use_id),
    ...outcome,
    ...(wouldBe && {
      would_be: wouldBe.action,
      would_be_code: wouldBe.code ?? null,
      would_be_reason: redactSecrets(String(wouldBe.reason ?? "")).slice(0, 1000)
    })
  });
}

async function auditToolCall(input, config, outcome, unknownStep = 0, hold = undefined, record = undefined) {
  if (!config.auditEnabled || !config.apiKey || typeof input.tool_name !== "string" || !input.tool_name) return;
  try {
    await createIapService(config).enqueueAudit(await buildAuditRow(input, config, outcome, unknownStep, hold, record));
  } catch (error) {
    process.stderr.write(`[armorcodex] audit row rejected: ${error instanceof Error ? error.message : error}\n`);
  }
}

export async function handlePostToolUse(input, config) {
  const hold = await settleHold(config, input);
  await auditToolCall(
    input,
    config,
    { status: "success", output: redactSecrets(sanitizeParams(input.tool_response, config.sanitize)) },
    0,
    hold
  );
  return null;
}

// ---------------------------------------------------------------------------
// PostToolUseFailure — audit logging for failed tool calls
// ---------------------------------------------------------------------------

export async function handlePostToolUseFailure(input, config) {
  const hold = await settleHold(config, input);
  await auditToolCall(
    input,
    config,
    {
      status: "failed",
      output: null,
      error_message: typeof input.error === "string" ? redactSecrets(input.error) : "Unknown error"
    },
    0,
    hold
  );
  return null;
}

// ---------------------------------------------------------------------------
// Stop — end of turn
// ---------------------------------------------------------------------------

export async function handleStop(input, config) {
  const sessionId = typeof input.session_id === "string" ? input.session_id : "";
  if (!sessionId) return null;

  const runtimeState = await loadRuntimeState(config.runtimeFile);
  const session = getSession(runtimeState, sessionId);
  if (!session) return null;

  // Check if token expired mid-turn
  if (Number.isFinite(session.expiresAt) && nowEpochSeconds() > session.expiresAt) {
    debugLog(config, "intent token expired during turn");
  }

  upsertSession(runtimeState, sessionId, { lastStopAt: nowEpochSeconds() });
  await saveRuntimeState(config.runtimeFile, runtimeState);
  return null;
}

// ---------------------------------------------------------------------------
// SessionEnd — cleanup
// ---------------------------------------------------------------------------

export async function handleSessionEnd(input, config) {
  const sessionId = typeof input.session_id === "string" ? input.session_id : "";
  if (!sessionId) return null;

  const runtimeState = await loadRuntimeState(config.runtimeFile);
  // Remove the session entirely
  if (runtimeState.sessions && runtimeState.sessions[sessionId]) {
    delete runtimeState.sessions[sessionId];
  }
  await saveRuntimeState(config.runtimeFile, runtimeState);

  debugLog(config, `session ended: ${sessionId}`);
  return null;
}
