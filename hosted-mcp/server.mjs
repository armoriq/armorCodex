import express from "express";
import { randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";

const PORT = Number(process.env.PORT) || 8080;
const DOMAIN_VERIFICATION_TOKEN = process.env.OPENAI_DOMAIN_VERIFICATION_TOKEN || "";

const POLICY_RULE_SCHEMA = z.object({
  id: z.string().min(1),
  action: z.enum(["allow", "deny", "require_approval"]),
  tool: z.string().min(1),
  dataClass: z.enum(["PCI", "PAYMENT", "PHI", "PII"]).optional(),
  params: z.record(z.string(), z.unknown()).optional(),
  anyParam: z.union([z.string().min(1), z.record(z.string(), z.unknown())]).optional()
});

const POLICY_UPDATE_SCHEMA = z.object({
  reason: z.string().min(1),
  mode: z.enum(["replace", "merge"]).optional(),
  rules: z.array(POLICY_RULE_SCHEMA)
});

const PLAN_STEP_SCHEMA = z.object({
  tool: z.string().min(1),
  rationale: z.string().optional(),
  params: z.record(z.string(), z.unknown()).optional()
});

const INTENT_PLAN_SCHEMA = z.object({
  goal: z.string().min(1),
  steps: z.array(PLAN_STEP_SCHEMA).min(1)
});

const seededPolicy = {
  version: 1,
  policy: {
    rules: [
      {
        id: "deny-prod-db",
        action: "deny",
        tool: "Bash",
        anyParam: { $contains: "DATABASE_URL=prod" }
      },
      {
        id: "approve-webfetch",
        action: "require_approval",
        tool: "WebFetch"
      },
      {
        id: "allow-read-only-fs",
        action: "allow",
        tool: "Read"
      }
    ]
  }
};

const state = {
  policy: structuredClone(seededPolicy),
  plans: []
};

function toTextResult(text, extra = {}) {
  return {
    content: [{ type: "text", text }],
    structuredContent: { message: text, ...extra }
  };
}

function buildServer() {
  const server = new McpServer({
    name: "armorcodex-policy",
    version: "0.3.0"
  });

  server.registerTool(
    "policy_update",
    {
      title: "Policy Update",
      description: "Updates the ArmorCodex policy rule set held in this server's in-memory store. Supports two modes: `merge` (default) upserts the submitted rules into the existing set, and `replace` overwrites the entire rule set with the submitted payload. The previous rules are not snapshotted, so `replace` cannot be undone from this tool. Annotations: readOnlyHint=false because the tool mutates server state; destructiveHint=true because replace mode irreversibly drops the prior rule set; openWorldHint=false because all state lives in this MCP server's memory and no external system is contacted.",
      inputSchema: { update: POLICY_UPDATE_SCHEMA },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false
      }
    },
    async (args) => {
      const parsed = POLICY_UPDATE_SCHEMA.safeParse(args?.update);
      if (!parsed.success) {
        return toTextResult(`Policy update rejected: ${parsed.error.message}`);
      }
      const { mode = "merge", rules, reason } = parsed.data;
      if (mode === "replace") {
        state.policy.policy.rules = rules;
      } else {
        const byId = new Map(state.policy.policy.rules.map((r) => [r.id, r]));
        for (const r of rules) byId.set(r.id, r);
        state.policy.policy.rules = Array.from(byId.values());
      }
      state.policy.version += 1;
      return toTextResult(
        `Policy updated (${mode}) - ${rules.length} rules. Reason: ${reason}. Version: ${state.policy.version}.`,
        { version: state.policy.version }
      );
    }
  );

  server.registerTool(
    "policy_read",
    {
      title: "Policy Read",
      description: "Returns the current ArmorCodex policy rule set held in this server's in-memory store. With no arguments, returns the full policy object including all rules and the current version. With an `id` argument, returns the single rule matching that id. Annotations: readOnlyHint=true because the tool only reads server state without modifying anything; destructiveHint=false because no state changes; idempotentHint=true because repeated calls with the same input return the same result without side effects; openWorldHint=false because all reads come from this MCP server's memory and no external system is contacted.",
      inputSchema: { id: z.string().optional() },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false
      }
    },
    async (args) => {
      if (typeof args?.id === "string" && args.id.trim()) {
        const rule = state.policy.policy.rules.find((r) => r.id === args.id.trim());
        if (!rule) return toTextResult(`Policy rule not found: ${args.id}`);
        return toTextResult(JSON.stringify(rule, null, 2), { rule });
      }
      return toTextResult(JSON.stringify(state.policy, null, 2), {
        version: state.policy.version,
        rules: state.policy.policy.rules
      });
    }
  );

  server.registerTool(
    "register_intent_plan",
    {
      title: "Register Intent Plan",
      description: "Records a structured intent plan (goal plus an ordered list of steps describing the tools the agent intends to call) into this server's in-memory plan list and returns the generated plan id. This hosted server stores the plan only; it does not enforce or block subsequent tool calls. The companion local Codex plugin uses these plans to gate tool execution via PreToolUse hooks on the user's machine, but that enforcement is out of scope for this hosted MCP. Annotations: readOnlyHint=false because the tool appends a new record to the in-memory plan list; destructiveHint=false because each call appends a new plan and never modifies or deletes prior plans; idempotentHint=false because calling the tool twice with identical inputs produces two distinct plan ids and two records; openWorldHint=false because all state lives in this MCP server's memory and no external system is contacted.",
      inputSchema: {
        goal: z.string().min(1).describe("One-line summary of what the plan accomplishes"),
        steps: z.array(PLAN_STEP_SCHEMA).min(1).describe("Ordered list of tool calls")
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false
      }
    },
    async (args) => {
      const parsed = INTENT_PLAN_SCHEMA.safeParse(args);
      if (!parsed.success) {
        return toTextResult(`Plan rejected: ${parsed.error.message}`);
      }
      const planId = randomUUID();
      state.plans.push({ id: planId, ...parsed.data, registeredAt: Date.now() });
      return toTextResult(
        `Intent registered: ${parsed.data.steps.length} steps for "${parsed.data.goal}".`,
        { planId, steps: parsed.data.steps.length, goal: parsed.data.goal }
      );
    }
  );

  return server;
}

const app = express();
app.use(express.json({ limit: "1mb" }));

app.get("/health", (_req, res) => {
  res.json({ ok: true, service: "armorcodex-hosted-mcp", version: "0.3.0" });
});

app.get("/.well-known/openai-apps-challenge", (_req, res) => {
  if (!DOMAIN_VERIFICATION_TOKEN) {
    res.status(503).type("text/plain").send("verification token not configured");
    return;
  }
  res.type("text/plain").send(DOMAIN_VERIFICATION_TOKEN);
});

app.all("/mcp", async (req, res) => {
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined
  });
  res.on("close", () => transport.close().catch(() => {}));
  try {
    const server = buildServer();
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    if (!res.headersSent) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  }
});

app.listen(PORT, () => {
  console.log(`[armorcodex-hosted-mcp] listening on :${PORT}`);
});
