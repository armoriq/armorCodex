import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { isMatcherSpec, isPlainObject } from "./common.mjs";
import { PRIVATE_FILE_MODE, writeJson } from "./fs-store.mjs";
import {
  POLICY_IR_VERSION,
  canonicalPolicyHash,
  documentToRules,
  evaluatePolicyDocument,
  isPolicyDocument,
  normalizePolicyDocument,
  rulesToDocument
} from "./policy-ir.mjs";

const POLICY_ACTIONS = new Set(["allow", "deny", "require_approval"]);
const POLICY_DATA_CLASSES = new Set(["PCI", "PAYMENT", "PHI", "PII"]);

export function normalizeRule(rule) {
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
  if (isMatcherSpec(rule.anyParam) || typeof rule.anyParam === "string") {
    normalized.anyParam =
      typeof rule.anyParam === "string"
        ? { $contains: rule.anyParam }
        : rule.anyParam;
  }
  // Fields a rule carries only when it was read from an armor.policy.v1
  // statement the legacy shape cannot express; kept so a rewrite round-trips.
  if (isPlainObject(rule.selector)) normalized.selector = rule.selector;
  if (Array.isArray(rule.conditions) && rule.conditions.length) normalized.conditions = rule.conditions;
  if (isPlainObject(rule.principal)) normalized.principal = rule.principal;
  if (isPlainObject(rule.resource)) normalized.resource = rule.resource;
  return normalized;
}

function legacyRules(policyLike) {
  const rules = Array.isArray(policyLike?.rules) ? policyLike.rules : [];
  return rules.map((rule) => normalizeRule(rule)).filter(Boolean);
}

/** The armor.policy.v1 document for a stored policy, a rule list, or a legacy {rules:[]} policy. */
export function toPolicyDocument(policyLike, base) {
  if (isPolicyDocument(policyLike)) return normalizePolicyDocument(policyLike);
  return rulesToDocument(legacyRules(policyLike), base);
}

function stateFrom(raw, document) {
  return {
    version: Number.isFinite(raw.version) ? raw.version : 0,
    updatedAt: typeof raw.updatedAt === "string" ? raw.updatedAt : new Date().toISOString(),
    updatedBy: typeof raw.updatedBy === "string" ? raw.updatedBy : undefined,
    document,
    policy: { rules: documentToRules(document) },
    history: Array.isArray(raw.history) ? raw.history : []
  };
}

function isLegacyStoredPolicy(raw) {
  const policy = raw.policy ?? raw;
  return isPlainObject(policy) && !isPolicyDocument(policy) && Array.isArray(policy.rules);
}

async function backupLegacyFile(policyFilePath) {
  const text = await readFile(policyFilePath, "utf8");
  const first = `${policyFilePath}.legacy.bak`;
  for (const target of [first, `${policyFilePath}.legacy.${Date.now()}.${process.pid}.bak`]) {
    try {
      await writeFile(target, text, { encoding: "utf8", mode: PRIVATE_FILE_MODE, flag: "wx" });
      return target;
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      if ((await readFile(target, "utf8")) === text) return target;
    }
  }
  throw new Error(`could not back up ${policyFilePath} before migrating it`);
}

/**
 * Rewrites a legacy {rules:[]} policy.json as armor.policy.v1 in place, keeping
 * the original beside it. First-match order becomes deny_overrides, which only
 * ever turns an allow into a block, never a block into an allow.
 */
async function migrateLegacyPolicy(policyFilePath, raw) {
  const rules = legacyRules(raw.policy ?? raw);
  const document = rulesToDocument(rules);
  const backup = await backupLegacyFile(policyFilePath);
  const version = (Number.isFinite(raw.version) ? raw.version : 0) + 1;
  const updatedAt = new Date().toISOString();
  const entry = {
    version,
    updatedAt,
    updatedBy: "armorcodex-migration",
    reason: `Migrated legacy {rules:[]} policy to ${POLICY_IR_VERSION}; original kept at ${path.basename(backup)}`,
    policy: document
  };
  const migrated = {
    version,
    updatedAt,
    updatedBy: "armorcodex-migration",
    policy: document,
    history: [...(Array.isArray(raw.history) ? raw.history : []), entry]
  };
  await writeJson(policyFilePath, migrated);
  return migrated;
}

export const POLICY_UNREADABLE_NOTICE =
  "ArmorCodex could not parse its policy file, so it denies tool calls until the file is fixed or replaced with `armor policy reset` then `armor yes`";

async function readStoredPolicy(policyFilePath) {
  let text;
  try {
    text = await readFile(policyFilePath, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return {};
    throw error;
  }
  try {
    const raw = JSON.parse(text);
    const policy = raw?.policy ?? raw;
    const known = isPolicyDocument(policy) || Array.isArray(policy?.rules) || !Object.keys(raw).length;
    if (isPlainObject(raw) && known) return raw;
  } catch {}
  return null;
}

export async function loadPolicyState(policyFilePath) {
  const raw = await readStoredPolicy(policyFilePath);
  if (raw === null) {
    process.stderr.write(`[armorcodex] ERROR ${policyFilePath}: ${POLICY_UNREADABLE_NOTICE}\n`);
    const denyAll = rulesToDocument([{ id: "deny-all", action: "deny", tool: "*" }]);
    return { ...stateFrom({}, denyAll), unreadable: true };
  }
  if (isLegacyStoredPolicy(raw)) {
    const migrated = await migrateLegacyPolicy(policyFilePath, raw);
    return stateFrom(migrated, migrated.policy);
  }
  return stateFrom(raw, toPolicyDocument(raw.policy));
}

export function computePolicyHash(policy) {
  return canonicalPolicyHash(toPolicyDocument(policy));
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
  const dataClasses = detectDataClasses(toolName, toolParams);
  const decision = evaluatePolicyDocument({
    policy: toPolicyDocument(policy),
    toolName,
    toolParams,
    dataClasses
  });
  return { ...decision, dataClasses: Array.from(dataClasses) };
}

function truncateReason(text, max = 160) {
  const trimmed = text.trim();
  if (trimmed.length <= max) {
    return trimmed;
  }
  return `${trimmed.slice(0, max)}...`;
}

export function formatRule(rule) {
  const parts = [`id=${rule.id}`, `action=${rule.action}`, `tool=${rule.tool}`];
  if (rule.dataClass) {
    parts.push(`dataClass=${rule.dataClass}`);
  }
  if (rule.anyParam) {
    const op = Object.keys(rule.anyParam)[0];
    const val = rule.anyParam[op];
    parts.push(`match=${op}:${val}`);
  }
  if (rule.params) {
    parts.push(`params=${JSON.stringify(rule.params)}`);
  }
  if (rule.selector && rule.selector.type !== "tool") {
    parts.push(`on=${rule.selector.type}`);
  }
  for (const condition of rule.conditions || []) {
    parts.push(`if=${condition.field} ${condition.op} ${JSON.stringify(condition.value)}`);
  }
  return parts.join(" ");
}

export function nextPolicyId(state) {
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

const VALID_TOOL_NAME = /^(?:\*|[A-Za-z][\w.:\-]{0,80})$/;

function sanitizeToolName(candidate) {
  if (typeof candidate !== "string") return null;
  const trimmed = candidate.trim();
  if (!trimmed) return null;
  return VALID_TOOL_NAME.test(trimmed) ? trimmed : null;
}

function inferAnyParamMatcher(text) {
  const quoted =
    text.match(/"([^"\n]{2,80})"/) ||
    text.match(/'([^'\n]{2,80})'/);
  if (quoted && quoted[1]) {
    return inferMatcherForPhrase(quoted[1]);
  }
  const pathMatch = text.match(/((?:~|\$\{?HOME\}?|\/)[\w./@\-+~]{2,120})/);
  if (pathMatch && pathMatch[1]) {
    const candidate = pathMatch[1].replace(/[.,;:)\]}]+$/, "");
    if (candidate.length >= 2) {
      return { $pathContains: candidate };
    }
  }
  return null;
}

function inferMatcherForPhrase(phrase) {
  const trimmed = phrase.trim();
  if (!trimmed) return null;
  if (/^(?:~|\$\{?HOME\}?|\/)/.test(trimmed)) {
    return { $pathContains: trimmed };
  }
  if (/[\\^$+?(){}[\]|]/.test(trimmed)) {
    return { $matches: trimmed };
  }
  return { $contains: trimmed };
}

const KNOWN_CODEX_TOOLS = new Set([
  "*",
  "bash", "apply_patch", "list_dir", "view_image", "mcp_resource",
  "update_plan", "create_goal", "update_goal", "get_goal",
  "spawn_agents_on_csv", "tool_search", "tool_suggest",
  "register_intent_plan", "policy_read", "policy_update"
]);

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
  const inferredTool = inferPolicyTool(text);
  const anyParam = inferAnyParamMatcher(text);

  let tool = inferredTool;
  if (anyParam && tool !== "*") {
    const normalized = tool.toLowerCase();
    if (!KNOWN_CODEX_TOOLS.has(normalized)) {
      tool = "*";
    }
  }

  const rule = {
    id,
    action: inferPolicyAction(text),
    tool,
    dataClass: inferPolicyDataClass(text)
  };
  if (anyParam) {
    rule.anyParam = anyParam;
  }
  return {
    reason: truncateReason(`User policy update: ${text}`),
    mode: /replace/i.test(text) ? "replace" : "merge",
    rules: [rule]
  };
}

export function parsePolicyTextCommand(text, state) {
  const trimmed = text.trim();
  const lower = trimmed.toLowerCase();

  if (!/^policy\b/i.test(trimmed)) {
    return { kind: "none" };
  }

  if (/^\s*policy\s+(help|commands)\s*$/i.test(trimmed)) {
    return { kind: "help" };
  }
  if (/^\s*policy\s+(list|show|view)\s*$/i.test(trimmed)) {
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

export function mergeRules(existing, updates) {
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

export async function persistNextState(policyFilePath, oldState, nextPolicy, actor, reason) {
  const version = oldState.version + 1;
  const updatedAt = new Date().toISOString();
  const document = toPolicyDocument(nextPolicy, oldState.document);
  const entry = {
    version,
    updatedAt,
    updatedBy: actor,
    reason,
    policy: document
  };
  const nextState = {
    version,
    updatedAt,
    updatedBy: actor,
    policy: document,
    history: [...oldState.history, entry]
  };
  await writeJson(policyFilePath, nextState);
  return stateFrom(nextState, document);
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
    return {
      state: nextState,
      message: `Policy ${command.id} moved to position ${clamped}. Order only changes the listing, except that a final rule for every tool (\`*\`) is the default for unmatched tools: a deny always wins over an allow.`
    };
  }
  if (command.kind === "update") {
    if (!isPlainObject(command.update)) {
      return { state, message: "Policy update rejected: invalid payload." };
    }
    const mode = command.update.mode === "replace" ? "replace" : "merge";
    const updates = Array.isArray(command.update.rules)
      ? command.update.rules.map((rule) => normalizeRule(rule)).filter(Boolean)
      : [];
    if (!updates.length && mode !== "replace") {
      return { state, message: "Policy update rejected: no valid rules." };
    }
    const nextRules = mode === "replace" ? updates : mergeRules(state.policy.rules, updates);
    const action = mode === "replace" && updates.length === 0 ? "cleared" : "updated";
    const nextState = await persistNextState(
      policyFilePath,
      state,
      { rules: nextRules },
      actor,
      command.update.reason || "Policy update"
    );
    return { state: nextState, message: `Policy ${action}. Version ${nextState.version}.` };
  }
  return { state, message: "No policy changes applied." };
}

