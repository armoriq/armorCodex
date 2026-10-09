import { randomUUID } from "node:crypto";
import path from "node:path";
import { isPlainObject, normalizeToolName } from "./common.mjs";
import { readJson, writeJson } from "./fs-store.mjs";
import {
  computePolicyHash,
  formatRule,
  loadPolicyState,
  nextPolicyId,
  normalizeRule,
  persistNextState
} from "./policy.mjs";

// Structured `/armor policy ...` command layer for ArmorCodex.
//
// This mirrors ArmorClaude's `/armor` command UX (staged proposal -> confirm)
// but operates on ArmorCodex's native `{ rules: [] }` schema so the existing
// evaluator (data-class + anyParam matchers) is preserved. Natural-language
// `Policy ...` commands stay handled by policy.mjs for back-compat.

const PROPOSAL_TTL_MS = 30 * 60 * 1000;

const ACTION_WORDS = {
  allow: "allow",
  permit: "allow",
  deny: "deny",
  block: "deny",
  forbid: "deny",
  hold: "require_approval",
  ask: "require_approval",
  require_approval: "require_approval",
  "require approval": "require_approval"
};

const TEMPLATES = {
  "all-allow": [],
  lockdown: [{ action: "require_approval", tool: "*" }],
  "strict-read-only": [
    { action: "deny", tool: "apply_patch" },
    { action: "require_approval", tool: "bash" },
    { action: "deny", tool: "*" }
  ],
  balanced: [
    { action: "require_approval", tool: "apply_patch" },
    { action: "require_approval", tool: "bash" }
  ]
};

function pendingPath(config) {
  return path.join(config.dataDir, "policy-pending.json");
}

function profilesPath(config) {
  return path.join(config.dataDir, "policy-profiles.json");
}

async function loadProfiles(config) {
  const data = await readJson(profilesPath(config), { profiles: {} });
  return isPlainObject(data) && isPlainObject(data.profiles) ? data : { profiles: {} };
}

async function saveProfiles(config, data) {
  await writeJson(profilesPath(config), data);
}

// --- command surface detection ---------------------------------------------

// Matches `/armor ...`, bare `armor policy|yes|no|... ` (guarded by a known
// subcommand so ordinary prose starting with "armor" is not intercepted).
export function isArmorPolicyCommand(prompt) {
  return Boolean(canonicalCommandText(prompt));
}

export function canonicalCommandText(prompt) {
  const trimmed = typeof prompt === "string" ? prompt.trim() : "";
  if (!trimmed) return null;

  let rest = null;
  const slash = trimmed.match(/^\/armor(?:codex:armor)?\b(?:\s+([\s\S]*))?$/i);
  if (slash) {
    rest = (slash[1] || "").trim();
  } else {
    const bare = trimmed.match(
      /^armor\s+(policy|yes|no|profile|mcp|help|list|view|add|remove|reset|default|template|confirm|cancel)\b([\s\S]*)$/i
    );
    if (bare) rest = `${bare[1]}${bare[2] || ""}`.trim();
  }
  if (rest === null) return null;
  if (/^policy\b/i.test(rest)) {
    rest = rest.replace(/^policy\b\s*/i, "").trim();
  }
  return { rest };
}

// --- parsing ----------------------------------------------------------------

function normalizeAction(word) {
  return ACTION_WORDS[word.trim().toLowerCase()] || "";
}

function normalizeToolToken(tool) {
  const t = tool.trim();
  return t;
}

// Parse "allow bash and apply_patch, deny apply_patch" into rule tuples.
function parseNaturalRules(text) {
  const actionAlt = "allow|permit|deny|block|forbid|hold|ask|require[_ ]approval";
  const regex = new RegExp(
    `\\b(${actionAlt})\\b\\s+([\\s\\S]*?)(?=\\s*(?:[,;]\\s*)?\\b(?:${actionAlt})\\b\\s+|$)`,
    "gi"
  );
  const rules = [];
  let match;
  while ((match = regex.exec(text)) !== null) {
    const action = normalizeAction(match[1]);
    if (!action) continue;
    const toolsChunk = match[2] || "";
    const tools = toolsChunk
      .split(/\s*(?:,|;|\band\b)\s*/i)
      .map((t) => normalizeToolToken(t))
      .filter((t) => t && !/^(for|to|the|a|an)$/i.test(t));
    for (const tool of tools) {
      rules.push({ action, tool });
    }
  }
  return rules;
}

export function parseCommand(prompt) {
  const canonical = canonicalCommandText(prompt);
  if (!canonical) return null;
  const rest = canonical.rest;
  const lower = rest.toLowerCase();

  if (!rest || lower === "help") return { cmd: "help" };
  if (/^(list|show)$/.test(lower)) return { cmd: "list" };
  if (/^(view|export)$/.test(lower)) return { cmd: "view" };
  if (lower === "yes") return { cmd: "confirm" };
  if (lower === "no") return { cmd: "cancel" };

  let m = rest.match(/^confirm(?:\s+(\S+))?$/i);
  if (m) return { cmd: "confirm", id: m[1] || "" };
  m = rest.match(/^cancel(?:\s+(\S+))?$/i);
  if (m) return { cmd: "cancel", id: m[1] || "" };

  if (/^(reset|clear)\b/.test(lower)) return { cmd: "reset" };

  m = rest.match(/^default\s+(\S+)/i);
  if (m) {
    const decision = normalizeAction(m[1]) || (/(^allow$)/i.test(m[1]) ? "allow" : "");
    const value = /^allow$/i.test(m[1]) ? "allow" : normalizeAction(m[1]);
    return { cmd: "default", decision: value };
  }

  m = rest.match(/^(?:remove|delete)\s+(\S+)/i);
  if (m) return { cmd: "remove", id: m[1] };

  m = rest.match(/^template\s+(\S+)/i);
  if (m) return { cmd: "template", name: m[1] };

  m = rest.match(/^profile\s+(save|list|switch|load|delete|remove)(?:\s+(\S+))?/i);
  if (m) {
    const sub = m[1].toLowerCase();
    const name = m[2] || "";
    if (sub === "list") return { cmd: "profile-list" };
    if (sub === "save") return { cmd: "profile-save", name };
    if (sub === "switch" || sub === "load") return { cmd: "profile-switch", name };
    return { cmd: "profile-delete", name };
  }

  m = rest.match(/^mcp\s+(approve|allow|deny|block|list)(?:\s+(\S+))?/i);
  if (m) {
    const sub = m[1].toLowerCase();
    if (sub === "list") return { cmd: "mcp-list" };
    return { cmd: "mcp-trust", server: m[2] || "", action: sub === "deny" || sub === "block" ? "deny" : "allow" };
  }

  if (/^add\b/i.test(rest)) {
    const rules = parseNaturalRules(rest.replace(/^add\b\s*/i, ""));
    return rules.length ? { cmd: "add", rules } : { cmd: "parse-error" };
  }

  // Bare action form: "deny bash", "allow apply_patch and bash"
  const bareRules = parseNaturalRules(rest);
  if (bareRules.length) return { cmd: "add", rules: bareRules };

  return { cmd: "help" };
}

// --- proposed-policy builders (pure; no persistence) ------------------------

function appendRules(currentRules, tuples, state) {
  const rules = [...currentRules];
  let counterState = { policy: { rules } };
  for (const tuple of tuples) {
    const id = nextPolicyId(counterState);
    const rule = normalizeRule({ id, action: tuple.action, tool: normalizeToolToken(tuple.tool) });
    if (rule) {
      rules.push(rule);
      counterState = { policy: { rules } };
    }
  }
  return { rules };
}

function removeRule(currentRules, id) {
  return { rules: currentRules.filter((r) => r.id !== id) };
}

function applyDefault(currentRules, decision) {
  const withoutCatchAll = currentRules.filter((r) => r.tool !== "*");
  if (decision === "allow") return { rules: withoutCatchAll };
  const state = { policy: { rules: withoutCatchAll } };
  const id = nextPolicyId(state);
  return { rules: [...withoutCatchAll, { id, action: decision, tool: "*" }] };
}

// Server-scoped MCP trust: allow/deny every `mcp__<server>__*` tool. The rule
// is inserted before any catch-all `*` rule so its specificity wins.
function setMcpTrust(currentRules, server, action) {
  const glob = `mcp__${server}__*`;
  const rules = currentRules.filter((r) => normalizeToolName(r.tool) !== glob);
  const id = nextPolicyId({ policy: { rules } });
  const rule = { id, action, tool: glob };
  const catchAllIdx = rules.findIndex((r) => r.tool === "*");
  if (catchAllIdx === -1) return { rules: [...rules, rule] };
  return { rules: [...rules.slice(0, catchAllIdx), rule, ...rules.slice(catchAllIdx)] };
}

function applyTemplate(name, state) {
  const tuples = TEMPLATES[name];
  if (!tuples) return null;
  let working = { rules: [] };
  for (const t of tuples) {
    const id = nextPolicyId({ policy: working });
    working = { rules: [...working.rules, { id, action: t.action, tool: t.tool }] };
  }
  return working;
}

// --- diff + risk ------------------------------------------------------------

export function formatRulesDiff(currentPolicy, proposedPolicy) {
  const cur = (currentPolicy.rules || []).map((r) => formatRule(r));
  const prop = (proposedPolicy.rules || []).map((r) => formatRule(r));
  const curSet = new Set(cur);
  const propSet = new Set(prop);
  const lines = [
    ...cur.filter((l) => !propSet.has(l)).map((l) => `- ${l}`),
    ...prop.filter((l) => !curSet.has(l)).map((l) => `+ ${l}`)
  ];
  return lines.length ? lines.join("\n") : "(no changes)";
}

export function riskWarnings(policy) {
  const rules = policy.rules || [];
  const warnings = [];
  const hasCatchAll = rules.some((r) => r.tool === "*");
  if (!hasCatchAll) {
    warnings.push("NOTE Unmatched tools default to allow. Add `armor policy default deny` to fail closed.");
  }
  for (const r of rules) {
    if (r.action === "allow" && r.tool.toLowerCase() === "bash" && !r.params && !r.anyParam) {
      warnings.push("RISK Bash is broadly allowed with no restrictions.");
    }
    if (r.action === "allow" && r.tool.toLowerCase() === "apply_patch") {
      warnings.push("RISK File writes (apply_patch) are allowed.");
    }
    if (r.action === "allow" && r.tool === "*") {
      warnings.push("RISK Default allow permits every tool.");
    }
  }
  return [...new Set(warnings)];
}

// --- staging ----------------------------------------------------------------

async function stagePending(config, state, proposedPolicy, reason, stagedBy) {
  const proposalId = `pol_${randomUUID().slice(0, 8)}`;
  const pending = {
    proposalId,
    reason,
    stagedBy: stagedBy || "unknown",
    baseVersion: state.version,
    basePolicyHash: computePolicyHash(state.policy),
    proposalHash: computePolicyHash(proposedPolicy),
    proposedPolicy,
    stagedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + PROPOSAL_TTL_MS).toISOString()
  };
  await writeJson(pendingPath(config), pending);
  return pending;
}

async function loadPending(config) {
  const pending = await readJson(pendingPath(config), null);
  return pending && typeof pending.proposalId === "string" ? pending : null;
}

async function clearPending(config) {
  await writeJson(pendingPath(config), null).catch(() => {});
}

function formatProposal(pending, currentPolicy) {
  return [
    "Proposed policy change:",
    `Proposal: ${pending.proposalId}`,
    `Base policy: v${pending.baseVersion}`,
    "",
    "Diff:",
    formatRulesDiff(currentPolicy, pending.proposedPolicy),
    "",
    "Risk:",
    riskWarnings(pending.proposedPolicy).map((w) => `- ${w}`).join("\n") || "(none)",
    "",
    "Next:",
    `  armor yes        apply ${pending.proposalId}`,
    `  armor no         discard ${pending.proposalId}`,
    `  armor policy confirm ${pending.proposalId}`,
    `  armor policy cancel ${pending.proposalId}`
  ].join("\n");
}

function helpText() {
  return [
    "ArmorCodex policy commands:",
    "  armor policy list                 - show current rules",
    "  armor policy view                 - show policy as JSON",
    "  armor policy add deny bash        - stage a rule (allow|deny|hold <tool>)",
    "  armor policy add allow bash and apply_patch, deny apply_patch",
    "  armor policy remove policy1       - stage removing a rule",
    "  armor policy reset                - stage clearing all rules",
    "  armor policy default deny|allow|hold - stage the unmatched-tool default",
    "  armor policy template <name>      - stage a template",
    "  armor profile save|list|switch|delete <name> - manage saved policy profiles",
    "  armor mcp approve|deny <server>   - trust or block an MCP server (mcp__<server>__*)",
    "  armor mcp list                    - show MCP trust rules",
    "  armor yes | armor no             - apply or discard the staged change",
    "",
    `Templates: ${Object.keys(TEMPLATES).join(", ")}`,
    "Natural language still works too, e.g. `Policy new: block bash for PII`."
  ].join("\n");
}

// --- main dispatcher --------------------------------------------------------

export async function handleArmorPolicyCommand(prompt, config, actor = "unknown", { allowConfirm = true } = {}) {
  const parsed = parseCommand(prompt);
  if (!parsed) return null;

  const state = await loadPolicyState(config.policyFile);

  // Applying a staged change is human-only. Read + stage are allowed from any
  // caller (e.g. the MCP tool), but confirm/cancel must come from a human
  // prompt so the model cannot self-approve a policy change.
  if (!allowConfirm && (parsed.cmd === "confirm" || parsed.cmd === "cancel")) {
    return "Applying policy changes is human-only. Confirm from the terminal with `armor yes` (or `armor policy confirm <id>`).";
  }

  switch (parsed.cmd) {
    case "help":
      return helpText();

    case "parse-error":
      return "Could not parse that policy command. Try `armor policy add deny bash`, or `armor` for help.";

    case "list": {
      if (!state.policy.rules.length) {
        return `Policy v${state.version}: no rules configured. Unmatched tools default to allow.\nUse armor policy add or armor policy template to get started.`;
      }
      const lines = state.policy.rules.map((r, i) => `  ${i + 1}. ${formatRule(r)}`);
      return `Policy v${state.version}:\n${lines.join("\n")}`;
    }

    case "view":
      return `Policy v${state.version}:\n${JSON.stringify(state.policy, null, 2)}`;

    case "confirm":
      return confirmPending(config, state, parsed.id, actor);

    case "cancel": {
      const pending = await loadPending(config);
      if (!pending) return "No staged policy change to cancel.";
      if (parsed.id && parsed.id !== pending.proposalId) {
        return `Staged proposal is ${pending.proposalId}, not ${parsed.id}.`;
      }
      await clearPending(config);
      return `Discarded staged proposal ${pending.proposalId}.`;
    }

    case "add":
      return stageAndFormat(config, state, appendRules(state.policy.rules, parsed.rules, state), `add ${parsed.rules.map((r) => `${r.action} ${r.tool}`).join(", ")}`, actor);

    case "remove": {
      if (!state.policy.rules.some((r) => r.id === parsed.id)) {
        return `Rule not found: ${parsed.id}. Use armor policy list.`;
      }
      return stageAndFormat(config, state, removeRule(state.policy.rules, parsed.id), `remove ${parsed.id}`, actor);
    }

    case "reset":
      return stageAndFormat(config, state, { rules: [] }, "reset policy", actor);

    case "default": {
      if (!["allow", "deny", "require_approval"].includes(parsed.decision)) {
        return "Unknown default. Use `armor policy default allow|deny|hold`.";
      }
      return stageAndFormat(config, state, applyDefault(state.policy.rules, parsed.decision), `default ${parsed.decision}`, actor);
    }

    case "template": {
      const proposed = applyTemplate(parsed.name, state);
      if (!proposed) {
        return `Unknown template: ${parsed.name}. Available: ${Object.keys(TEMPLATES).join(", ")}.`;
      }
      return stageAndFormat(config, state, proposed, `template ${parsed.name}`, actor);
    }

    case "profile-list": {
      const { profiles } = await loadProfiles(config);
      const names = Object.keys(profiles);
      if (!names.length) return "No saved profiles. Save one with armor profile save <name>.";
      return `Saved profiles:\n${names.map((n) => `  - ${n} (${(profiles[n].rules || []).length} rules)`).join("\n")}`;
    }

    case "profile-save": {
      if (!parsed.name) return "Usage: armor profile save <name>";
      const data = await loadProfiles(config);
      data.profiles[parsed.name] = { rules: state.policy.rules };
      await saveProfiles(config, data);
      return `Saved current policy (v${state.version}, ${state.policy.rules.length} rules) as profile '${parsed.name}'.`;
    }

    case "profile-delete": {
      if (!parsed.name) return "Usage: armor profile delete <name>";
      const data = await loadProfiles(config);
      if (!data.profiles[parsed.name]) return `Profile not found: ${parsed.name}.`;
      delete data.profiles[parsed.name];
      await saveProfiles(config, data);
      return `Deleted profile '${parsed.name}'.`;
    }

    case "profile-switch": {
      if (!parsed.name) return "Usage: armor profile switch <name>";
      const data = await loadProfiles(config);
      const prof = data.profiles[parsed.name];
      if (!prof) return `Profile not found: ${parsed.name}. Use armor profile list.`;
      const rules = (prof.rules || []).map((r) => normalizeRule(r)).filter(Boolean);
      return stageAndFormat(config, state, { rules }, `switch to profile ${parsed.name}`, actor);
    }

    case "mcp-list": {
      const mcpRules = state.policy.rules.filter((r) => /^mcp__/i.test(r.tool));
      if (!mcpRules.length) return "No MCP trust rules. Use armor mcp approve|deny <server>.";
      return `MCP trust rules:\n${mcpRules.map((r) => `  - ${formatRule(r)}`).join("\n")}`;
    }

    case "mcp-trust": {
      if (!parsed.server) return "Usage: armor mcp approve|deny <server>";
      return stageAndFormat(config, state, setMcpTrust(state.policy.rules, parsed.server, parsed.action), `mcp ${parsed.action} ${parsed.server}`, actor);
    }

    default:
      return helpText();
  }
}

async function stageAndFormat(config, state, proposedPolicy, reason, actor) {
  if (computePolicyHash(proposedPolicy) === computePolicyHash(state.policy)) {
    return "No changes: the proposed policy is identical to the active policy.";
  }
  const pending = await stagePending(config, state, proposedPolicy, reason, actor);
  return formatProposal(pending, state.policy);
}

async function confirmPending(config, state, id, actor) {
  const pending = await loadPending(config);
  if (!pending) return "No staged policy change to confirm. Stage one with armor policy add|remove|reset.";
  if (id && id !== pending.proposalId) {
    return `Staged proposal is ${pending.proposalId}, not ${id}. Use armor policy list to review.`;
  }
  if (Date.now() > Date.parse(pending.expiresAt)) {
    await clearPending(config);
    return `Proposal ${pending.proposalId} expired. Re-stage the change.`;
  }
  if (pending.baseVersion !== state.version) {
    await clearPending(config);
    return `Policy changed since ${pending.proposalId} was staged (base v${pending.baseVersion}, now v${state.version}). Re-stage.`;
  }
  if (pending.basePolicyHash !== computePolicyHash(state.policy)) {
    await clearPending(config);
    return `Active policy changed since ${pending.proposalId} was staged. Re-stage.`;
  }
  if (pending.proposalHash !== computePolicyHash(pending.proposedPolicy)) {
    await clearPending(config);
    return `Proposal ${pending.proposalId} failed its integrity check. Re-stage.`;
  }
  const diff = formatRulesDiff(state.policy, pending.proposedPolicy);
  const nextState = await persistNextState(
    config.policyFile,
    state,
    pending.proposedPolicy,
    actor,
    pending.reason
  );
  await clearPending(config);
  const stagedNote = pending.stagedBy && pending.stagedBy !== actor ? ` (staged by ${pending.stagedBy})` : "";
  return `Policy updated to v${nextState.version}. ${pending.reason}${stagedNote}\n\nApplied:\n${diff}`;
}
