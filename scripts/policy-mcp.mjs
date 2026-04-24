import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import path from "node:path";
import { z } from "zod";
import { loadConfig } from "./lib/config.mjs";
import { writeJson } from "./lib/fs-store.mjs";
import { extractAllowedActions, requestIntent } from "./lib/intent.mjs";
import { INTENT_PLAN_ZOD, PLAN_STEP_SCHEMA, normalizeIntentPlan } from "./lib/intent-schema.mjs";
import { applyPolicyCommand, computePolicyHash, loadPolicyState, parsePolicyTextCommand } from "./lib/policy.mjs";

const POLICY_RULE_SCHEMA = z.object({
  id: z.string().min(1),
  action: z.enum(["allow", "deny", "require_approval"]),
  tool: z.string().min(1),
  dataClass: z.enum(["PCI", "PAYMENT", "PHI", "PII"]).optional(),
  params: z.record(z.string(), z.unknown()).optional()
});

const POLICY_UPDATE_SCHEMA = z.object({
  reason: z.string().min(1),
  mode: z.enum(["replace", "merge"]).optional(),
  rules: z.array(POLICY_RULE_SCHEMA)
});

function toTextResult(text, extra = {}) {
  return {
    content: [{ type: "text", text }],
    structuredContent: {
      message: text,
      ...extra
    }
  };
}

/**
 * Some MCP clients (and Codex itself) sometimes pass complex tool arguments
 * as JSON-encoded strings instead of structured objects. Accept either form.
 *
 *   { goal: "...", steps: "[{...}]" }   → parse steps as JSON
 *   { plan:  "{\"goal\":...}" }         → parse plan envelope as JSON
 *   { goal: "...", steps: [{...}] }     → pass through
 */
function coercePlanArgs(args) {
  if (!args || typeof args !== "object") {
    return args;
  }
  // If caller wrapped the entire plan in a `plan` field (string or object),
  // unwrap it.
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
  // Coerce stringified arrays/objects on known fields.
  if (typeof args.steps === "string") {
    try { args = { ...args, steps: JSON.parse(args.steps) }; } catch { /* leave as-is */ }
  }
  return args;
}

async function loadStateAndConfig() {
  const config = loadConfig();
  const state = await loadPolicyState(config.policyFile);
  return { config, state };
}

async function run() {
  const server = new McpServer({
    name: "armorcodex-policy",
    version: "0.1.0"
  });

  server.registerTool(
    "policy_update",
    {
      title: "Policy Update",
      description: "Manage ArmorCodex policy rules (update/list/delete/reset)",
      inputSchema: {
        text: z.string().optional(),
        update: POLICY_UPDATE_SCHEMA.optional()
      }
    },
    async (args) => {
      const { config, state } = await loadStateAndConfig();
      if (!config.policyUpdateEnabled) {
        return toTextResult("ArmorCodex policy updates are disabled.");
      }

      if (typeof args.text === "string" && args.text.trim()) {
        const command = parsePolicyTextCommand(args.text, state);
        const result = await applyPolicyCommand({
          policyFilePath: config.policyFile,
          state,
          command,
          actor: "mcp"
        });
        return toTextResult(result.message, { version: result.state.version });
      }

      if (args.update) {
        // Tolerate JSON-string update payloads (some clients stringify objects).
        let updateInput = args.update;
        if (typeof updateInput === "string") {
          try { updateInput = JSON.parse(updateInput); } catch { /* let validator complain */ }
        }
        const parsed = POLICY_UPDATE_SCHEMA.safeParse(updateInput);
        if (!parsed.success) {
          return toTextResult(`Policy update rejected: ${parsed.error.message}`);
        }
        const result = await applyPolicyCommand({
          policyFilePath: config.policyFile,
          state,
          command: {
            kind: "update",
            update: parsed.data
          },
          actor: "mcp"
        });
        return toTextResult(result.message, { version: result.state.version });
      }

      return toTextResult("Policy update rejected: missing `text` or `update`.");
    }
  );

  server.registerTool(
    "policy_read",
    {
      title: "Policy Read",
      description: "Read current ArmorCodex policy state",
      inputSchema: {
        id: z.string().optional()
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

  // -----------------------------------------------------------------
  // register_intent_plan — Codex calls this to declare its plan
  // -----------------------------------------------------------------
  server.registerTool(
    "register_intent_plan",
    {
      title: "Register Intent Plan",
      description:
        "Declare the tools you intend to use for this task. " +
        "Required by ArmorCodex before any other tool call. " +
        "Without a registered plan, all tool calls will be blocked.",
      // Accept the canonical {goal, steps} shape AND the string-serialized
      // variants Codex sometimes emits (steps as a JSON string, or the
      // whole plan wrapped in a `plan` field). The handler below coerces
      // them to the canonical shape before validating with INTENT_PLAN_ZOD.
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
      }
    },
    async (args) => {
      // Codex sometimes serializes complex tool arguments as JSON strings
      // (e.g. steps: "[{...}]" instead of steps: [{...}]). Tolerate both.
      const coerced = coercePlanArgs(args);
      const parsed = INTENT_PLAN_ZOD.safeParse(coerced);
      if (!parsed.success) {
        return toTextResult(`Plan rejected: ${parsed.error.message}`);
      }

      const config = loadConfig();
      const plan = normalizeIntentPlan(parsed.data);

      // Send to ArmorIQ for signed intent token (if SDK/endpoint configured)
      let intentResult = { skipped: true };
      if (config.intentEndpoint || (config.useSdkIntent && config.apiKey)) {
        try {
          const policyState = await loadPolicyState(config.policyFile);
          intentResult = await requestIntent(config, {
            prompt: parsed.data.goal,
            plan,
            session_id: "mcp",
            policy_hash: computePolicyHash(policyState.policy),
            policy: policyState.policy,
            validitySeconds: config.validitySeconds,
            metadata: { source: "codex", planning: "codex-registered" }
          });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          process.stderr.write(`[armorcodex] intent capture in register_intent_plan: ${msg}\n`);
        }
      }

      // Write to pending-plan.json — PreToolUse hook will pick it up
      const pendingPath = path.join(config.dataDir, "pending-plan.json");
      await writeJson(pendingPath, {
        plan: intentResult.plan || plan,
        tokenRaw: intentResult.tokenRaw || "",
        allowedActions: Array.from(extractAllowedActions(intentResult.plan || plan)),
        expiresAt: intentResult.expiresAt,
        registeredAt: Date.now()
      });

      const tokenInfo = intentResult.tokenRaw
        ? `Token valid ${config.validitySeconds}s.`
        : "No ArmorIQ backend configured — plan stored locally.";

      return toTextResult(
        `Intent registered: ${plan.steps.length} steps. ${tokenInfo}`,
        { steps: plan.steps.length, goal: parsed.data.goal }
      );
    }
  );

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

run().catch((error) => {
  const message = error instanceof Error ? error.stack || error.message : String(error);
  process.stderr.write(`[armorcodex-policy] ${message}\n`);
  process.exitCode = 1;
});
