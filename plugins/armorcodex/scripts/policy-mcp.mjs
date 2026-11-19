import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { unlink } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { loadSettings, withLogin } from "./lib/config.mjs";
import { ensurePrivateDir, readJson, writeJson } from "./lib/fs-store.mjs";
import { extractAllowedActions, requestIntent } from "./lib/intent.mjs";
import { INTENT_PLAN_ZOD, PLAN_STEP_SCHEMA, normalizeIntentPlan } from "./lib/intent-schema.mjs";
import {
  applyPolicyCommand,
  computePolicyHash,
  loadPolicyState,
  mergeRules,
  normalizeRule,
  parsePolicyTextCommand
} from "./lib/policy.mjs";
import { handleArmorPolicyCommand, stageAndFormat } from "./lib/armor-policy-commands.mjs";
import { createAuditFlusher } from "./lib/audit-flusher.mjs";
import { shipQueuedAudit } from "./lib/audit-delivery.mjs";
import { createPlanRefresher } from "./lib/plan-refresh.mjs";
import { cachedPosture } from "./lib/backend-posture.mjs";
import { getSession, isPromptOpen, matchesSessionGeneration, retireSessionPlan, syncSessionAuth, withRuntimeState } from "./lib/runtime-state.mjs";
import { createPlanRequest, planHash, requestWithRetry, withPlanRequest } from "./lib/plan-request.mjs";

const MATCHER_OPERATORS = z
  .object({
    $equals: z.string().optional(),
    $contains: z.string().optional(),
    $startsWith: z.string().optional(),
    $endsWith: z.string().optional(),
    $matches: z.string().optional(),
    $pathContains: z.string().optional()
  })
  .strict();

const POLICY_RULE_SCHEMA = z.object({
  id: z.string().min(1),
  action: z.enum(["allow", "deny", "require_approval"]),
  tool: z.string().min(1),
  dataClass: z.enum(["PCI", "PAYMENT", "PHI", "PII"]).optional(),
  params: z.record(z.string(), z.unknown()).optional(),
  anyParam: z.union([z.string().min(1), MATCHER_OPERATORS]).optional()
});

const POLICY_UPDATE_SCHEMA = z.object({
  reason: z.string().min(1),
  mode: z.enum(["replace", "merge"]).optional(),
  rules: z.array(POLICY_RULE_SCHEMA)
});

const READ_ONLY_TEXT_COMMANDS = new Set(["none", "help", "list", "get"]);

function proposedPolicy(state, update) {
  const rules = update.rules.map((rule) => normalizeRule(rule)).filter(Boolean);
  return { rules: update.mode === "replace" ? rules : mergeRules(state.policy.rules, rules) };
}

function toTextResult(text, extra = {}) {
  return {
    content: [{ type: "text", text }],
    structuredContent: {
      message: text,
      ...extra
    }
  };
}

/** Codex and some MCP clients send nested tool arguments as JSON strings, so accept either form. */
function coercePlanArgs(args) {
  if (!args || typeof args !== "object") {
    return args;
  }
  if (args.plan !== undefined) {
    let unwrapped = args.plan;
    if (typeof unwrapped === "string") {
      try { unwrapped = JSON.parse(unwrapped); } catch { /* fall through */ }
    }
    if (unwrapped && typeof unwrapped === "object") {
      args = { ...unwrapped, ...args };
      delete args.plan;
    }
  }
  if (typeof args.steps === "string") {
    try { args = { ...args, steps: JSON.parse(args.steps) }; } catch { /* leave as-is */ }
  }
  if (!(typeof args.goal === "string" && args.goal.trim()) && Array.isArray(args.steps)) {
    const goal = deriveGoal(args.steps);
    if (goal) args = { ...args, goal };
  }
  return args;
}

function deriveGoal(steps) {
  const parts = steps
    .map((step) => {
      if (!step || typeof step !== "object") return "";
      return ["description", "rationale", "reason", "why", "action", "tool"]
        .map((key) => (typeof step[key] === "string" ? step[key].trim() : ""))
        .find(Boolean) ?? "";
    })
    .filter(Boolean);
  return parts.join("; ").slice(0, 500);
}

function codexSessionId(extra) {
  const id = extra?._meta?.sessionId;
  return typeof id === "string" && /^[A-Za-z0-9_-]+$/.test(id) ? id : "";
}

const registrations = new Map();

function serializeRegistration(sessionId, task) {
  const run = (registrations.get(sessionId) ?? Promise.resolve()).catch(() => {}).then(task);
  registrations.set(sessionId, run);
  return run;
}

function registeredResult(session) {
  return toTextResult(
    `Intent registered: plan ${session.countedPlanId} (${session.kind}), ${session.plan.steps.length} steps. Token valid until ${session.tokenExpiresAt}.`,
    { planId: session.countedPlanId, kind: session.kind, steps: session.plan.steps.length, expiresAt: session.tokenExpiresAt }
  );
}

function registrationFailure(error, config) {
  const reason = (error instanceof Error ? error.message : String(error)).split(config.apiKey || "\0").join("[redacted]").replace(/[.\s]+$/, "");
  const reply = toTextResult(error.unconfirmed
    ? `Plan registration not confirmed: ${reason}. Register the same plan again to retry it with the same request id, or start a new prompt.`
    : `Plan not registered: ${reason}.`);
  return { ...reply, isError: true };
}

async function registerPlan(currentConfig, sessionId, expected, plan, goal, deadlineAt) {
  let config = currentConfig();
  const pendingPath = path.join(config.dataDir, `pending-plan.${sessionId}.json`);
  const update = (change) => withRuntimeState(config.runtimeFile, async (state) => {
    if (!matchesSessionGeneration(getSession(state, sessionId), expected)) throw new Error("the prompt or login changed while the plan was registering");
    const session = syncSessionAuth(state, sessionId, currentConfig(), { retireOnChange: false });
    if (!matchesSessionGeneration(session, expected)) throw new Error("the prompt or login changed while the plan was registering");
    return change(session);
  });
  let descriptor;
  try {
    const prepared = await update(async (session) => {
      config = { ...config, mode: session.mode ?? config.mode };
      if (session.backendEndpoint && session.backendEndpoint !== config.backendEndpoint) {
        throw new Error("the MCP backend differs from the hook backend; restart Codex with matching settings");
      }
      const posture = await cachedPosture(config);
      const reason = !config.apiKey || posture?.state === "signed_out" ? "logged_out"
        : config.mode === "monitor" ? "monitor_mode"
        : !config.useSdkIntent && !config.intentEndpoint ? "no_transport" : null;
      if (reason) {
        if (session.countedPlanId || session.pendingRequest) retireSessionPlan(session);
        Object.assign(session, {
          unregisteredLocalPlan: { reason, plan, recordedAt: Date.now() }, pendingRequest: null,
          countedPlanId: null, tokenPlanId: null, tokenExpiresAt: null, kind: null, planHash: null,
          intentTokenRaw: "", plan, allowedActions: Array.from(extractAllowedActions(plan)),
          expiresAt: null, planCheck: null, intentExecution: null
        });
        await unlink(pendingPath).catch((error) => { if (error.code !== "ENOENT") throw error; });
        return { reply: toTextResult(`Plan recorded locally, not registered (${reason}).`) };
      }
      if (posture?.state === "unreachable") throw new Error("backend_unreachable; the cached backend check failed, try again after it recovers");
      if (!session.promptId) throw new Error("no current prompt id; submit a prompt before registering a plan");
      const hash = planHash(plan);
      if (!session.pendingRequest && session.countedPlanId && session.planHash === hash && session.intentTokenRaw && Date.parse(session.tokenExpiresAt) > Date.now()) {
        return { reply: registeredResult(session) };
      }
      if (session.pendingRequest) {
        if (session.pendingRequest.planHash !== hash) throw new Error("Register the same plan again to retry it, or start a new prompt");
        return { descriptor: structuredClone(session.pendingRequest) };
      }
      const policyState = await loadPolicyState(config.policyFile);
      session.pendingRequest = createPlanRequest(config, {
        prompt: goal, plan, session_id: sessionId, policy_hash: computePolicyHash(policyState.document),
        policy: policyState.policy, validitySeconds: config.validitySeconds,
        metadata: { source: "codex", planning: "codex-registered" }
      }, session);
      return { descriptor: structuredClone(session.pendingRequest) };
    });
    if (prepared.reply) return prepared.reply;
    descriptor = prepared.descriptor;
    await update(async () => writeJson(pendingPath, { ...expected, status: "issuing", startedAt: Date.now(), deadlineAt }));
    const result = await requestWithRetry(async (timeoutMs) => {
      await update((session) => {
        if (descriptor.kind === "refresh" && !isPromptOpen(session)) throw new Error("the prompt closed while refreshing");
      });
      return requestIntent(config, { plan }, descriptor, { timeoutMs });
    }, { timeoutMs: config.timeoutMs, deadlineAt });
    if (!result?.tokenRaw || !result.planId || !Number.isFinite(result.expiresAt)) {
      throw new Error("the backend returned no token, plan id or expiry");
    }
    return await update(async (session) => {
      if (session.pendingRequest?.key !== descriptor.key) throw new Error("the pending plan changed while the plan was registering");
      if (descriptor.kind === "refresh" && !isPromptOpen(session)) throw new Error("the prompt closed while refreshing");
      const installed = {
        plan: descriptor.body.plan, tokenRaw: result.tokenRaw,
        allowedActions: Array.from(extractAllowedActions(descriptor.body.plan)),
        expiresAt: result.expiresAt, tokenExpiresAt: new Date(result.expiresAt * 1000).toISOString(),
        countedPlanId: descriptor.kind === "refresh" ? session.countedPlanId : result.planId,
        tokenPlanId: result.planId, kind: descriptor.kind === "refresh" ? session.kind : result.kind ?? descriptor.kind,
        planHash: descriptor.planHash, planCheck: result.planCheck ?? null, registeredAt: Date.now()
      };
      await writeJson(pendingPath, { ...expected, ...installed });
      Object.assign(session, installed, { intentTokenRaw: result.tokenRaw, pendingRequest: null, unregisteredLocalPlan: null, intentExecution: null, refreshFailures: 0, refreshRetryAt: null });
      return registeredResult(session);
    });
  } catch (error) {
    if (descriptor) {
      await update(async (session) => {
        if (session.pendingRequest?.key !== descriptor.key) return;
        if (!error.unconfirmed) session.pendingRequest = null;
        const pending = await readJson(pendingPath, null);
        if (matchesSessionGeneration(session, pending)) await unlink(pendingPath);
      }).catch(() => {});
    }
    return registrationFailure(error, config);
  }
}

async function run() {
  let stopping;
  const settings = loadSettings();
  const currentConfig = () => withLogin(settings);
  const loadStateAndConfig = async () => {
    const config = currentConfig();
    return { config, state: await loadPolicyState(config.policyFile) };
  };
  await ensurePrivateDir(settings.dataDir);
  const server = new McpServer({
    name: "armorcodex-policy",
    version: "0.1.0"
  });

  server.registerTool(
    "policy_update",
    {
      title: "Policy Update",
      description:
        "Read ArmorCodex policy rules, or stage a rule change (merge or replace) for the user to review. Nothing is applied from here: the user reviews a staged change and applies it in the terminal with `armor policy confirm <id>`.",
      inputSchema: {
        text: z.string().optional(),
        update: POLICY_UPDATE_SCHEMA.optional()
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false
      }
    },
    async (args) => {
      const { config, state } = await loadStateAndConfig();
      if (!config.policyUpdateEnabled) {
        return toTextResult("ArmorCodex policy updates are disabled.");
      }

      if (typeof args.text === "string" && args.text.trim()) {
        const command = parsePolicyTextCommand(args.text, state);
        if (!READ_ONLY_TEXT_COMMANDS.has(command.kind)) {
          return toTextResult(
            "Policy changes from the agent are staged, never applied. Use the policy_command tool (e.g. 'policy remove <id>') or policy_update with `update`, then the user reviews and applies it with `armor policy confirm <id>`."
          );
        }
        const result = await applyPolicyCommand({
          policyFilePath: config.policyFile,
          state,
          command,
          actor: "mcp"
        });
        return toTextResult(result.message, { version: result.state.version });
      }

      if (args.update) {
        let updateInput = args.update;
        if (typeof updateInput === "string") {
          try { updateInput = JSON.parse(updateInput); } catch { updateInput = null; }
        }
        const parsed = POLICY_UPDATE_SCHEMA.safeParse(updateInput);
        if (!parsed.success) {
          return toTextResult(`Policy update rejected: ${parsed.error.message}`);
        }
        const message = await stageAndFormat(config, state, proposedPolicy(state, parsed.data), parsed.data.reason, "mcp");
        return toTextResult(message, { version: state.version, staged: true });
      }

      return toTextResult("Policy update rejected: missing `text` or `update`.");
    }
  );

  server.registerTool(
    "policy_command",
    {
      title: "Policy Command",
      description:
        "Run a structured ArmorCodex /armor policy command. Read and stage are allowed (e.g. 'policy list', 'policy view', 'policy add deny bash', 'policy default deny', 'policy template lockdown'). Applying is human-only: 'confirm'/'yes' are rejected here and must be done from the terminal with armor policy confirm <id>.",
      inputSchema: {
        command: z.string().min(1)
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false
      }
    },
    async (args) => {
      const config = currentConfig();
      if (!config.policyUpdateEnabled) {
        return toTextResult("ArmorCodex policy updates are disabled.");
      }
      const raw = typeof args.command === "string" ? args.command.trim() : "";
      if (!raw) {
        return toTextResult("Provide a command, e.g. 'policy list' or 'policy add deny bash'.");
      }
      const prompt = /^\/?armor\b/i.test(raw) ? raw : `/armor ${raw}`;
      const response = await handleArmorPolicyCommand(prompt, config, "mcp", { allowConfirm: false });
      return toTextResult(response || "No policy command recognized.");
    }
  );

  server.registerTool(
    "policy_read",
    {
      title: "Policy Read",
      description: "Read current ArmorCodex policy state",
      inputSchema: {
        id: z.string().optional()
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false
      }
    },
    async (args) => {
      const { state } = await loadStateAndConfig();
      if (typeof args.id === "string" && args.id.trim()) {
        const rule = state.policy.rules.find((entry) => entry.id === args.id.trim());
        if (!rule) {
          return toTextResult(`Policy rule not found: ${args.id}`);
        }
        return toTextResult(JSON.stringify(rule, null, 2), { rule });
      }
      return toTextResult(JSON.stringify(state, null, 2), {
        version: state.version,
        rules: state.policy.rules
      });
    }
  );

  server.registerTool(
    "register_intent_plan",
    {
      title: "Register Intent Plan",
      description:
        "Declare the tools you intend to use for this task. " +
        "Register before the first tool that needs a plan in this prompt. " +
        "Chat only prompts need no plan.",
      inputSchema: {
        goal: z.string().min(1).optional()
          .describe("One-line summary of what the plan accomplishes"),
        steps: z.union([
          z.array(PLAN_STEP_SCHEMA).min(1),
          z.string().min(1)
        ]).optional()
          .describe("Ordered list of tool calls (array, or JSON-stringified array)"),
        plan: z.union([INTENT_PLAN_ZOD, z.string().min(1)]).optional()
          .describe("Alternative: pass the whole plan as an object or JSON string")
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false
      }
    },
    async (args, extra) => {
      if (stopping) return { ...toTextResult("Plan not registered: ArmorCodex is shutting down."), isError: true };
      const coerced = coercePlanArgs(args);
      const parsed = INTENT_PLAN_ZOD.safeParse(coerced);
      if (!parsed.success) {
        return { ...toTextResult(`Plan not registered: ${parsed.error.message}.`), isError: true };
      }
      const sessionId = codexSessionId(extra);
      if (!sessionId) {
        return { ...toTextResult("Plan not registered: this Codex version sends no session id with MCP calls. Update Codex to 0.162 or later."), isError: true };
      }

      const config = currentConfig();
      const plan = normalizeIntentPlan(parsed.data);
      const expected = withRuntimeState(config.runtimeFile, (state) => {
        const previous = getSession(state, sessionId);
        if (previous?.backendEndpoint && previous.backendEndpoint !== config.backendEndpoint) {
          throw new Error("the MCP backend differs from the hook backend; restart Codex with matching settings");
        }
        const session = syncSessionAuth(state, sessionId, config);
        return { promptId: session.promptId, promptGeneration: session.promptGeneration, authGeneration: session.authGeneration };
      });
      expected.catch(() => {});
      return serializeRegistration(sessionId, async () => withPlanRequest(config.runtimeFile, sessionId,
        async (deadlineAt) => registerPlan(currentConfig, sessionId, await expected, plan, parsed.data.goal, deadlineAt))
        .catch((error) => registrationFailure(error, currentConfig())));
    }
  );

  const flusher = createAuditFlusher({
    ship: () => shipQueuedAudit(currentConfig()),
    onError: (err) => {
      process.stderr.write(`[armorcodex-policy] flusher: ${err instanceof Error ? err.message : err}\n`);
    },
    intervalMs: 5000
  });
  const refresher = createPlanRefresher({
    currentConfig,
    onError: (error) => {
      const config = currentConfig();
      const reason = String(error instanceof Error ? error.message : error).split(config.apiKey || "\0").join("[redacted]");
      process.stderr.write(`[armorcodex-policy] refresh: ${reason}\n`);
    }
  });

  const shutdown = () => {
    stopping ??= Promise.allSettled([
      flusher.stop(), refresher.stop(), ...registrations.values()
    ]).then(async () => {
      await new Promise(setImmediate);
      await server.close();
      process.exit(0);
    });
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
  process.stdin.on("end", shutdown);
  process.stdin.on("close", shutdown);

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

run().catch((error) => {
  const message = error instanceof Error ? error.stack || error.message : String(error);
  process.stderr.write(`[armorcodex-policy] ${message}\n`);
  process.exitCode = 1;
});
