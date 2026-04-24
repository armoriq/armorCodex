import { createHash } from "node:crypto";
import { isPlainObject, isSubsetValue, normalizeToolName } from "./common.mjs";
import { readJson, writeJson } from "./fs-store.mjs";

const POLICY_ACTIONS = new Set(["allow", "deny", "require_approval"]);
const POLICY_DATA_CLASSES = new Set(["PCI", "PAYMENT", "PHI", "PII"]);

function normalizeRule(rule) {
  if (!isPlainObject(rule)) {
    return null;
  }
  const id = typeof rule.id === "string" ? rule.id.trim() : "";
  const action = typeof rule.action === "string" ? rule.action.trim() : "";
  const tool = typeof rule.tool === "string" ? rule.tool.trim() : "";
  if (!id || !tool || !POLICY_ACTIONS.has(action)) {
    return null;
  }
  const normalized = {
    id,
    action,
    tool
  };
  if (typeof rule.dataClass === "string" && POLICY_DATA_CLASSES.has(rule.dataClass.trim())) {
    normalized.dataClass = rule.dataClass.trim();
  }
  if (isPlainObject(rule.params)) {
    normalized.params = rule.params;
  }
  return normalized;
}

function normalizePolicy(policyLike) {
  const input = isPlainObject(policyLike) ? policyLike : {};
  const rulesInput = Array.isArray(input.rules) ? input.rules : [];
  const rules = rulesInput.map((rule) => normalizeRule(rule)).filter(Boolean);
  return { rules };
}

export async function loadPolicyState(policyFilePath) {
  const initial = {
    version: 0,
    updatedAt: new Date().toISOString(),
    policy: { rules: [] },
    history: []
  };
  const raw = await readJson(policyFilePath, initial);
  const state = isPlainObject(raw) ? raw : initial;
  return {
    version: Number.isFinite(state.version) ? state.version : 0,
    updatedAt: typeof state.updatedAt === "string" ? state.updatedAt : new Date().toISOString(),
    updatedBy: typeof state.updatedBy === "string" ? state.updatedBy : undefined,
    policy: normalizePolicy(state.policy || state),
    history: Array.isArray(state.history) ? state.history : []
  };
}

export async function savePolicyState(policyFilePath, state) {
  await writeJson(policyFilePath, state);
}

export function computePolicyHash(policy) {
  return createHash("sha256").update(JSON.stringify(normalizePolicy(policy))).digest("hex");
}

function toolMatches(ruleTool, toolName) {
  if (ruleTool === "*") {
    return true;
  }
  return normalizeToolName(ruleTool) === normalizeToolName(toolName);
}

function extractStrings(value, depth, texts, keys) {
  if (depth > 4) {
    return;
  }
  if (typeof value === "string") {
    texts.push(value);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((entry) => extractStrings(entry, depth + 1, texts, keys));
    return;
  }
  if (isPlainObject(value)) {
    for (const [key, entry] of Object.entries(value)) {
      keys.push(key);
      extractStrings(entry, depth + 1, texts, keys);
    }
  }
}

function luhnCheck(value) {
  let sum = 0;
  let doubleDigit = false;
  for (let i = value.length - 1; i >= 0; i -= 1) {
    let digit = Number.parseInt(value[i] || "", 10);
    if (!Number.isFinite(digit)) {
      return false;
    }
    if (doubleDigit) {
      digit *= 2;
      if (digit > 9) {
        digit -= 9;
      }
    }
    sum += digit;
    doubleDigit = !doubleDigit;
  }
  return sum % 10 === 0;
}

function hasCardNumber(texts) {
  const regex = /\b(?:\d[ -]*?){13,19}\b/g;
  for (const text of texts) {
    const matches = text.match(regex);
    if (!matches) {
      continue;
    }
    for (const match of matches) {
      const digits = match.replace(/[^\d]/g, "");
      if (digits.length >= 13 && digits.length <= 19 && luhnCheck(digits)) {
        return true;
      }
    }
  }
  return false;
}

function hasPaymentKeywords(texts, keys) {
  const keywords = ["card", "credit", "payment", "cvv", "iban", "swift", "bank", "routing"];
  const haystack = [...texts, ...keys].join(" ").toLowerCase();
  return keywords.some((keyword) => haystack.includes(keyword));
}

function isPaymentTool(toolName) {
  return /pay|payment|transfer|charge|crypto|bank|card|stripe|billing/i.test(toolName);
}

export function detectDataClasses(toolName, toolParams) {
  const texts = [];
  const keys = [];
  extractStrings(toolParams || {}, 0, texts, keys);
  const classes = new Set();
  if (hasCardNumber(texts) || hasPaymentKeywords(texts, keys)) {
    classes.add("PCI");
  }
  if (isPaymentTool(toolName) || hasPaymentKeywords(texts, keys)) {
    classes.add("PAYMENT");
  }
  return classes;
}

export function evaluatePolicy({ policy, toolName, toolParams }) {
  const rules = normalizePolicy(policy).rules;
  const dataClasses = detectDataClasses(toolName, toolParams);

  for (const rule of rules) {
    if (!toolMatches(rule.tool, toolName)) {
      continue;
    }
    if (rule.dataClass && !dataClasses.has(rule.dataClass)) {
      continue;
    }
    if (rule.params && !isSubsetValue(rule.params, toolParams || {})) {
      continue;
    }
    if (rule.action === "allow") {
      return { allowed: true, matchedRule: rule, dataClasses: Array.from(dataClasses) };
    }
    if (rule.action === "deny") {
      return {
        allowed: false,
        reason: `ArmorCodex policy deny: ${rule.id}`,
        matchedRule: rule,
        dataClasses: Array.from(dataClasses)
      };
    }
    if (rule.action === "require_approval") {
      return {
        allowed: false,
        reason: `ArmorCodex policy requires approval: ${rule.id}`,
        matchedRule: rule,
        dataClasses: Array.from(dataClasses)
      };
    }
  }

  return { allowed: true, dataClasses: Array.from(dataClasses) };
}

function truncateReason(text, max = 160) {
  const trimmed = text.trim();
  if (trimmed.length <= max) {
    return trimmed;
  }
  return `${trimmed.slice(0, max)}...`;
}

function formatRule(rule) {
  const parts = [`id=${rule.id}`, `action=${rule.action}`, `tool=${rule.tool}`];
  if (rule.dataClass) {
    parts.push(`dataClass=${rule.dataClass}`);
  }
  return parts.join(" ");
}

function nextPolicyId(state) {
  const ids = state.policy.rules
    .map((rule) => rule.id)
    .map((id) => {
      const match = id.match(/^policy(\d+)$/i);
      return match ? Number.parseInt(match[1] || "", 10) : null;
    })
    .filter((value) => Number.isFinite(value));
  const max = ids.length ? Math.max(...ids) : 0;
  return `policy${max + 1}`;
}

function inferPolicyAction(text) {
  const lower = text.toLowerCase();
  if (/(require\s+approval|needs\s+approval|approval\s+required)/i.test(lower)) {
    return "require_approval";
  }
  if (/(allow|permit|enable|whitelist)/i.test(lower)) {
    return "allow";
  }
  if (/(deny|block|disallow|prevent|prohibit|stop)/i.test(lower)) {
    return "deny";
  }
  return "deny";
}

function inferPolicyDataClass(text) {
  const lower = text.toLowerCase();
  if (/(credit\s*card|card\s*number|pci)/i.test(lower)) {
    return "PCI";
  }
  if (/(payment|billing|bank|iban|swift|routing)/i.test(lower)) {
    return "PAYMENT";
  }
  if (/(phi|health|patient|medical)/i.test(lower)) {
    return "PHI";
  }
  if (/(pii|ssn|personal\s+data|identity)/i.test(lower)) {
    return "PII";
  }
  return undefined;
}

// A tool name must look like a real identifier — letters, digits, underscore,
// hyphen, dot, colon — OR exactly "*". Anything else is rejected so free-text
// like "all tools" or regex fragments can't become rule matchers.
const VALID_TOOL_NAME = /^(?:\*|[A-Za-z][\w.:\-]{0,80})$/;

function sanitizeToolName(candidate) {
  if (typeof candidate !== "string") return null;
  const trimmed = candidate.trim();
  if (!trimmed) return null;
  return VALID_TOOL_NAME.test(trimmed) ? trimmed : null;
}

function inferPolicyTool(text) {
  const lower = text.toLowerCase();
  if (/(all\s+tools|any\s+tool|\*\b)/i.test(lower)) {
    return "*";
  }
  const backtickMatch = text.match(/`([A-Za-z][\w.:\-]{0,80})`/);
  const backtickName = sanitizeToolName(backtickMatch?.[1]);
  if (backtickName) {
    return backtickName;
  }
  const toolMatch = text.match(/\btool\s*[:=]?\s*([A-Za-z][\w.:\-]{0,80})/i);
  const toolName = sanitizeToolName(toolMatch?.[1]);
  if (toolName) {
    return toolName;
  }
  const actionMatch = text.match(/\b(?:block|deny|allow|disallow|permit|require)\s+([A-Za-z][\w.:\-]{0,80})/i);
  const actionName = sanitizeToolName(actionMatch?.[1]);
  if (actionName) {
    return actionName;
  }
  return "*";
}

function buildPolicyUpdateFromText(text, state, forceNewId = false) {
  const explicitIdMatch = text.match(/\bpolicy[-_]?(\d+)\b/i);
  const explicitId = explicitIdMatch && explicitIdMatch[1] ? `policy${explicitIdMatch[1]}` : "";
  const id = forceNewId ? nextPolicyId(state) : explicitId || nextPolicyId(state);
  return {
    reason: truncateReason(`User policy update: ${text}`),
    mode: /replace/i.test(text) ? "replace" : "merge",
    rules: [
      {
        id,
        action: inferPolicyAction(text),
        tool: inferPolicyTool(text),
        dataClass: inferPolicyDataClass(text)
      }
    ]
  };
}

export function parsePolicyTextCommand(text, state) {
  const trimmed = text.trim();
  const lower = trimmed.toLowerCase();

  if (!/^policy\b/i.test(trimmed)) {
    return { kind: "none" };
  }

  if (/\b(help|commands)\b/i.test(lower)) {
    return { kind: "help" };
  }
  if (/\b(list|show|view)\b/i.test(lower)) {
    return { kind: "list" };
  }
  if (/\breset|clear\s+all|wipe\b/i.test(lower)) {
    return { kind: "reset", reason: truncateReason(`Policy reset: ${trimmed}`) };
  }
  const reorderMatch = trimmed.match(
    /\bpolicy\s*(?:priorit(?:y|ize|ise)|reorder|move)\s+(policy\d+|[a-z0-9][\w.-]*)\s+(?:to\s+)?(\d+)\b/i
  );
  if (reorderMatch && reorderMatch[1] && reorderMatch[2]) {
    return {
      kind: "reorder",
      id: reorderMatch[1],
      position: Number.parseInt(reorderMatch[2], 10),
      reason: truncateReason(`Policy reorder: ${trimmed}`)
    };
  }
  const deleteMatch = trimmed.match(/\bpolicy\s+delete\s+([a-z0-9][\w.-]*)\b/i);
  if (deleteMatch && deleteMatch[1]) {
    return {
      kind: "delete",
      id: deleteMatch[1],
      reason: truncateReason(`Policy delete: ${trimmed}`)
    };
  }
  const getMatch = trimmed.match(/\bpolicy\s+get\s+([a-z0-9][\w.-]*)\b/i);
  if (getMatch && getMatch[1]) {
    return { kind: "get", id: getMatch[1] };
  }
  const newMatch = trimmed.match(/\bpolicy\s+new\s*:\s*(.+)$/i);
  if (newMatch && newMatch[1]) {
    return { kind: "update", update: buildPolicyUpdateFromText(newMatch[1], state, true) };
  }
  const updateMatch = trimmed.match(/\bpolicy\s+update(?:\s+([a-z0-9][\w.-]*))?\s*:\s*(.+)$/i);
  if (updateMatch && updateMatch[2]) {
    const [_, maybeId, body] = updateMatch;
    const full = maybeId ? `${maybeId} ${body}` : body;
    return { kind: "update", update: buildPolicyUpdateFromText(full, state, false), hasId: Boolean(maybeId) };
  }

  return { kind: "help" };
}

function mergeRules(existing, updates) {
  const byId = new Map();
  for (const rule of existing) {
    byId.set(rule.id, rule);
  }
  const newRules = [];
  for (const rule of updates) {
    if (byId.has(rule.id)) {
      byId.set(rule.id, rule);
    } else {
      newRules.push(rule);
    }
  }
  return [...newRules, ...Array.from(byId.values())];
}

async function persistNextState(policyFilePath, oldState, nextPolicy, actor, reason) {
  const version = oldState.version + 1;
  const updatedAt = new Date().toISOString();
  const entry = {
    version,
    updatedAt,
    updatedBy: actor,
    reason,
    policy: nextPolicy
  };
  const nextState = {
    version,
    updatedAt,
    updatedBy: actor,
    policy: nextPolicy,
    history: [...oldState.history, entry]
  };
  await savePolicyState(policyFilePath, nextState);
  return nextState;
}

function formatPolicyHelp() {
  return [
    "Policy commands:",
    "1. Policy list",
    "2. Policy get policy1",
    "3. Policy delete policy1",
    "4. Policy reset",
    "5. Policy update policy1: block send_email for payment data",
    "6. Policy new: block web_fetch for PII",
    "7. Policy prioritize policy2 1"
  ].join("\n");
}

export async function applyPolicyCommand({ policyFilePath, state, command, actor }) {
  if (command.kind === "none") {
    return { state, message: "" };
  }
  if (command.kind === "help") {
    return { state, message: formatPolicyHelp() };
  }
  if (command.kind === "list") {
    if (!state.policy.rules.length) {
      return { state, message: `Policy version ${state.version}. No explicit rules.` };
    }
    const lines = state.policy.rules.map((rule, idx) => `${idx + 1}. ${formatRule(rule)}`);
    return { state, message: `Policy version ${state.version}:\n${lines.join("\n")}` };
  }
  if (command.kind === "get") {
    const rule = state.policy.rules.find((entry) => entry.id === command.id);
    return {
      state,
      message: rule ? `Policy rule:\n- ${formatRule(rule)}` : `Policy rule not found: ${command.id}`
    };
  }
  if (command.kind === "reset") {
    const nextState = await persistNextState(
      policyFilePath,
      state,
      { rules: [] },
      actor,
      command.reason || "Policy reset"
    );
    return { state: nextState, message: `Policy reset. Version ${nextState.version}.` };
  }
  if (command.kind === "delete") {
    const rules = state.policy.rules.filter((rule) => rule.id !== command.id);
    const nextState = await persistNextState(
      policyFilePath,
      state,
      { rules },
      actor,
      command.reason || `Policy delete: ${command.id}`
    );
    return {
      state: nextState,
      message:
        rules.length === state.policy.rules.length
          ? `No matching rule removed (${command.id}).`
          : `Policy rule removed: ${command.id}. Version ${nextState.version}.`
    };
  }
  if (command.kind === "reorder") {
    const rules = [...state.policy.rules];
    const index = rules.findIndex((rule) => rule.id === command.id);
    if (index === -1) {
      return { state, message: `Policy rule not found: ${command.id}` };
    }
    const clamped = Math.min(Math.max(command.position, 1), rules.length);
    const [rule] = rules.splice(index, 1);
    rules.splice(clamped - 1, 0, rule);
    const nextState = await persistNextState(
      policyFilePath,
      state,
      { rules },
      actor,
      command.reason || `Policy reorder: ${command.id}`
    );
    return { state: nextState, message: `Policy ${command.id} moved to position ${clamped}.` };
  }
  if (command.kind === "update") {
    if (!isPlainObject(command.update)) {
      return { state, message: "Policy update rejected: invalid payload." };
    }
    const mode = command.update.mode === "replace" ? "replace" : "merge";
    const updates = Array.isArray(command.update.rules)
      ? command.update.rules.map((rule) => normalizeRule(rule)).filter(Boolean)
      : [];
    if (!updates.length) {
      return { state, message: "Policy update rejected: no valid rules." };
    }
    const nextRules = mode === "replace" ? updates : mergeRules(state.policy.rules, updates);
    const nextState = await persistNextState(
      policyFilePath,
      state,
      { rules: nextRules },
      actor,
      command.update.reason || "Policy update"
    );
    return { state: nextState, message: `Policy updated. Version ${nextState.version}.` };
  }
  return { state, message: "No policy changes applied." };
}

