import { createHash } from "node:crypto";
import {
  isMatcherSpec,
  isPlainObject,
  matchParams,
  matchesAnyStringField,
  normalizeToolName
} from "./common.mjs";

export const POLICY_IR_VERSION = "armor.policy.v1";
export const POLICY_PRINCIPAL = { type: "agent", id: "armorcodex" };
const WORKSPACE = { type: "workspace", scope: "current" };

const EFFECTS = new Set(["permit", "forbid", "require_approval"]);
const DEFAULT_DECISIONS = new Set(["allow", "deny", "hold"]);
const ACTION_TYPES = new Set(["tool", "mcp_server", "mcp_tool", "bash_program"]);
// The first seven are the shared armor.policy.v1 fields. The last three carry
// the legacy {rules:[]} matchers so a migrated rule matches exactly what it did.
const CONDITION_FIELDS = new Set([
  "tool.name",
  "bash.program",
  "bash.raw",
  "bash.hasWriteRedirection",
  "file.path",
  "network.host",
  "mcp.server",
  "tool.params",
  "tool.anyParam",
  "data.class"
]);
const CONDITION_OPS = new Set([
  "eq",
  "in",
  "not_in",
  "matches",
  "not_matches",
  "starts_with",
  "within_workspace",
  "match"
]);
const DATA_CLASSES = new Set(["PCI", "PAYMENT", "PHI", "PII"]);

const EFFECT_OF_ACTION = { allow: "permit", deny: "forbid", require_approval: "require_approval" };
const ACTION_OF_EFFECT = { permit: "allow", forbid: "deny", require_approval: "require_approval" };
const DEFAULT_OF_ACTION = { allow: "allow", deny: "deny", require_approval: "hold" };
const ACTION_OF_DEFAULT = { allow: "allow", deny: "deny", hold: "require_approval" };
export const DEFAULT_RULE_ID = "default";

export function isPolicyDocument(value) {
  return isPlainObject(value) && value.schemaVersion === POLICY_IR_VERSION;
}

function selectorValues(selector) {
  if (typeof selector?.eq === "string") return [selector.eq];
  return Array.isArray(selector?.in) ? selector.in.filter((v) => typeof v === "string") : [];
}

function normalizeSelector(selector) {
  const input = isPlainObject(selector) ? selector : {};
  const out = { type: ACTION_TYPES.has(input.type) ? input.type : "tool" };
  if (typeof input.eq === "string" && input.eq.trim()) out.eq = input.eq.trim();
  else if (Array.isArray(input.in)) {
    out.in = input.in.filter((v) => typeof v === "string" && v.trim()).map((v) => v.trim());
  }
  if (!out.eq && !out.in?.length) out.eq = "*";
  return out;
}

function normalizeCondition(condition) {
  if (!isPlainObject(condition)) return null;
  const field = typeof condition.field === "string" ? condition.field.trim() : "";
  const op = typeof condition.op === "string" ? condition.op.trim() : "";
  if (!CONDITION_FIELDS.has(field) || !CONDITION_OPS.has(op)) return null;
  return { field, op, value: condition.value };
}

function normalizeStatement(statement, idx) {
  const input = isPlainObject(statement) ? statement : {};
  const conditions = Array.isArray(input.conditions) ? input.conditions : [];
  return {
    id: typeof input.id === "string" && input.id.trim() ? input.id.trim() : `statement${idx + 1}`,
    // An unreadable effect fails closed rather than silently permitting.
    effect: EFFECTS.has(input.effect) ? input.effect : "forbid",
    principal: isPlainObject(input.principal) ? input.principal : { ...POLICY_PRINCIPAL },
    action: normalizeSelector(input.action),
    resource: isPlainObject(input.resource) ? input.resource : { ...WORKSPACE },
    conditions: conditions.map(normalizeCondition).filter(Boolean)
  };
}

export function normalizePolicyDocument(doc) {
  const input = isPlainObject(doc) ? doc : {};
  const metadata = isPlainObject(input.metadata) ? input.metadata : {};
  const defaults = isPlainObject(input.defaults) ? input.defaults : {};
  const statements = Array.isArray(input.statements) ? input.statements : [];
  return {
    schemaVersion: POLICY_IR_VERSION,
    kind: "PolicyProfile",
    metadata: {
      name: typeof metadata.name === "string" && metadata.name.trim() ? metadata.name.trim() : "current",
      description: typeof metadata.description === "string" ? metadata.description : ""
    },
    defaults: {
      decision: DEFAULT_DECISIONS.has(defaults.decision) ? defaults.decision : "allow",
      conflictResolution: "deny_overrides"
    },
    statements: statements.map(normalizeStatement)
  };
}

function isCatchAll(rule) {
  return rule.tool === "*" && !rule.params && !rule.anyParam && !rule.dataClass && !rule.conditions?.length;
}

export function ruleToStatement(rule) {
  const conditions = [...(Array.isArray(rule.conditions) ? rule.conditions : [])];
  if (rule.dataClass) conditions.push({ field: "data.class", op: "eq", value: rule.dataClass });
  if (rule.params) conditions.push({ field: "tool.params", op: "match", value: rule.params });
  if (rule.anyParam) conditions.push({ field: "tool.anyParam", op: "match", value: rule.anyParam });
  const keepSelector = rule.selector && selectorValues(rule.selector).join("|") === rule.tool;
  return {
    id: rule.id,
    effect: EFFECT_OF_ACTION[rule.action] || "forbid",
    principal: rule.principal || { ...POLICY_PRINCIPAL },
    action: keepSelector ? rule.selector : { type: "tool", eq: rule.tool },
    resource: rule.resource || { ...WORKSPACE },
    conditions
  };
}

export function statementToRule(statement) {
  const rule = {
    id: statement.id,
    action: ACTION_OF_EFFECT[statement.effect],
    tool: selectorValues(statement.action).join("|")
  };
  if (statement.action.type !== "tool" || !statement.action.eq) rule.selector = statement.action;
  const extra = [];
  for (const condition of statement.conditions) {
    if (condition.field === "data.class" && condition.op === "eq" && DATA_CLASSES.has(condition.value)) {
      rule.dataClass = condition.value;
    } else if (condition.field === "tool.params" && condition.op === "match" && isPlainObject(condition.value)) {
      rule.params = condition.value;
    } else if (condition.field === "tool.anyParam" && condition.op === "match" && isMatcherSpec(condition.value)) {
      rule.anyParam = condition.value;
    } else {
      extra.push(condition);
    }
  }
  if (extra.length) rule.conditions = extra;
  if (JSON.stringify(statement.principal) !== JSON.stringify(POLICY_PRINCIPAL)) rule.principal = statement.principal;
  if (JSON.stringify(statement.resource) !== JSON.stringify(WORKSPACE)) rule.resource = statement.resource;
  return rule;
}

/**
 * The rule list the policy commands edit. A trailing unconditioned `*` rule is
 * the document's default decision, which is how those commands have always
 * expressed "unmatched tools are denied".
 */
export function documentToRules(doc) {
  const normalized = normalizePolicyDocument(doc);
  const rules = normalized.statements.map(statementToRule);
  if (normalized.defaults.decision !== "allow") {
    rules.push({ id: DEFAULT_RULE_ID, action: ACTION_OF_DEFAULT[normalized.defaults.decision], tool: "*" });
  }
  return rules;
}

export function rulesToDocument(rules, base = {}) {
  const list = Array.isArray(rules) ? rules.filter(isPlainObject) : [];
  const last = list[list.length - 1];
  const trailingDefault = last && isCatchAll(last) ? last : null;
  const body = trailingDefault ? list.slice(0, -1) : list;
  const metadata = isPlainObject(base.metadata) ? base.metadata : {};
  return normalizePolicyDocument({
    schemaVersion: POLICY_IR_VERSION,
    metadata,
    defaults: { decision: trailingDefault ? DEFAULT_OF_ACTION[trailingDefault.action] : "allow" },
    statements: body.map(ruleToStatement)
  });
}

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (isPlainObject(value)) {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, stable(value[key])])
    );
  }
  return value;
}

export function canonicalPolicyHash(doc) {
  return createHash("sha256")
    .update(JSON.stringify(stable(normalizePolicyDocument(doc))))
    .digest("hex");
}

function toolMatches(pattern, toolName) {
  if (pattern === "*") return true;
  const rule = normalizeToolName(pattern);
  const actual = normalizeToolName(toolName);
  if (rule.length > 1 && rule.endsWith("*")) return actual.startsWith(rule.slice(0, -1));
  return rule === actual;
}

function mcpParts(toolName) {
  const match = /^mcp__(.+?)__(.+)$/i.exec(String(toolName).trim());
  return match ? { server: match[1], tool: match[2] } : null;
}

function commandText(params) {
  const command = params?.command ?? params?.cmd;
  return Array.isArray(command) ? command.join(" ") : typeof command === "string" ? command : "";
}

export function parseBashCommand(command) {
  const raw = command.trim();
  const withoutEnv = raw.replace(/^(?:[A-Za-z_][A-Za-z0-9_]*=[^\s]+\s+)*/, "");
  const program = (withoutEnv.split(/\s+/)[0] || "").replace(/^["'`]+|["'`]+$/g, "");
  return {
    raw,
    program,
    hasWriteRedirection: /(^|[^<])>{1,2}|\btee\b|\bsed\s+-i\b|\btruncate\b|\bdd\b/.test(raw)
  };
}

function selectorMatches(selector, toolName, params) {
  const values = selectorValues(selector);
  if (values.includes("*")) return true;
  const mcp = mcpParts(toolName);
  switch (selector.type) {
    case "mcp_server":
      return Boolean(mcp) && values.some((v) => v.toLowerCase() === mcp.server.toLowerCase());
    case "mcp_tool":
      return Boolean(mcp) && values.some((v) => toolMatches(v, mcp.tool) || toolMatches(v, toolName));
    case "bash_program":
      return (
        normalizeToolName(toolName) === "bash" &&
        values.includes(parseBashCommand(commandText(params)).program)
      );
    default:
      return values.some((v) => toolMatches(v, toolName));
  }
}

function conditionValue(field, toolName, params) {
  const bash = parseBashCommand(commandText(params));
  switch (field) {
    case "tool.name":
      return toolName;
    case "bash.program":
      return bash.program;
    case "bash.raw":
      return bash.raw;
    case "bash.hasWriteRedirection":
      return bash.hasWriteRedirection;
    case "file.path":
      return params.file_path || params.path || "";
    case "network.host": {
      const url = params.url || bash.raw.match(/https?:\/\/[^\s'"]+/)?.[0] || "";
      try {
        return url ? new URL(url).host : "";
      } catch {
        return "";
      }
    }
    case "mcp.server":
      return mcpParts(toolName)?.server || "";
    default:
      return undefined;
  }
}

function regexTest(pattern, value) {
  try {
    return new RegExp(pattern).test(String(value));
  } catch {
    return false;
  }
}

function conditionMatches(condition, ctx) {
  const { toolName, params, dataClasses, warnings, statementId } = ctx;
  if (condition.field === "tool.params") {
    const result = matchParams(condition.value, params);
    if (!result.matched && result.missingKeys.length > 0) {
      warnings.push({
        ruleId: statementId,
        missingKeys: result.missingKeys,
        message: `Rule ${statementId} references keys absent from ${toolName} input: ${result.missingKeys.join(", ")}. Consider using anyParam or operator-based matchers.`
      });
    }
    return result.matched;
  }
  if (condition.field === "tool.anyParam") return matchesAnyStringField(condition.value, params);
  if (condition.field === "data.class") return dataClasses.has(condition.value);
  const actual = conditionValue(condition.field, toolName, params);
  const expected = condition.value;
  switch (condition.op) {
    case "eq":
      return actual === expected;
    case "in":
      return Array.isArray(expected) && expected.includes(actual);
    case "not_in":
      return Array.isArray(expected) && !expected.includes(actual);
    case "matches":
      return typeof expected === "string" && regexTest(expected, actual);
    case "not_matches":
      return typeof expected === "string" && !regexTest(expected, actual);
    case "starts_with":
      return typeof expected === "string" && String(actual).startsWith(expected);
    case "within_workspace":
      return typeof actual === "string" && !actual.startsWith("/") && !actual.includes("..");
    default:
      return false;
  }
}

/** deny_overrides: forbid beats require_approval beats permit beats the default. */
export function evaluatePolicyDocument({ policy, toolName, toolParams, dataClasses = new Set() }) {
  const doc = normalizePolicyDocument(policy);
  const params = isPlainObject(toolParams) ? toolParams : {};
  const warnings = [];
  const matches = doc.statements.filter((statement) => {
    if (!selectorMatches(statement.action, toolName, params)) return false;
    const ctx = { toolName, params, dataClasses, warnings, statementId: statement.id };
    return statement.conditions.every((condition) => conditionMatches(condition, ctx));
  });
  const forbid = matches.find((s) => s.effect === "forbid");
  if (forbid) {
    return {
      allowed: false,
      effect: "forbid",
      reason: `ArmorCodex policy deny: ${forbid.id}`,
      matchedRule: statementToRule(forbid),
      warnings
    };
  }
  const approval = matches.find((s) => s.effect === "require_approval");
  if (approval) {
    return {
      allowed: false,
      effect: "require_approval",
      reason: `ArmorCodex policy requires approval: ${approval.id}`,
      matchedRule: statementToRule(approval),
      warnings
    };
  }
  const permit = matches.find((s) => s.effect === "permit");
  if (permit) return { allowed: true, effect: "permit", matchedRule: statementToRule(permit), warnings };
  const decision = doc.defaults.decision;
  if (decision === "allow") return { allowed: true, effect: "default", warnings };
  return {
    allowed: false,
    effect: decision === "hold" ? "require_approval" : "forbid",
    reason: `ArmorCodex policy default ${decision}: no rule matched ${toolName}`,
    matchedRule: { id: DEFAULT_RULE_ID, action: ACTION_OF_DEFAULT[decision], tool: "*" },
    warnings
  };
}
