import { z } from "zod";
import { codexHookName } from "./common.mjs";

const PLAN_STEP_TARGET = z.object({
  action: z.string().min(1).describe("Tool name (e.g. Read, Edit, Bash, mcp__server__tool)"),
  description: z.string().optional().describe("Why this step is needed"),
  metadata: z
    .object({
      inputs: z
        .record(z.string(), z.unknown())
        .optional()
        .describe("Expected tool parameters for enforcement")
    })
    .optional()
});

export const PLAN_STEP_SCHEMA = z.preprocess((val) => {
  if (!val || typeof val !== "object" || Array.isArray(val)) {
    return val;
  }
  const v = { ...val };
  if (v.action == null && typeof v.tool === "string") {
    v.action = v.tool;
  }
  if (v.description == null) {
    if (typeof v.rationale === "string") v.description = v.rationale;
    else if (typeof v.reason === "string") v.description = v.reason;
    else if (typeof v.why === "string") v.description = v.why;
  }
  if (v.metadata == null && v.inputs && typeof v.inputs === "object") {
    v.metadata = { inputs: v.inputs };
  }
  return v;
}, PLAN_STEP_TARGET);

export const INTENT_PLAN_ZOD = z.object({
  goal: z.string().min(1).describe("One-line summary of what the plan accomplishes"),
  steps: z
    .array(PLAN_STEP_SCHEMA)
    .min(1)
    .describe("Ordered list of tool calls the agent intends to make")
});

export const INTENT_PLAN_FORMAT = `{
  "goal": "<one-line summary of the task>",
  "steps": [
    {
      "action": "<ToolName e.g. Read, Edit, Bash, Grep, Glob, Write, WebFetch>",
      "description": "<why this step is needed>",
      "metadata": { "inputs": { /* expected tool parameters, optional */ } }
    }
  ]
}`;

export function normalizeIntentPlan(parsed) {
  return {
    steps: parsed.steps.map((s) => {
      const hookName = codexHookName(s.action);
      return {
        action: hookName,
        tool: hookName,
        mcp: "codex",
        description: s.description || "",
        metadata: hookName === s.action ? s.metadata || {} : { ...s.metadata, declaredAction: s.action }
      };
    }),
    metadata: {
      goal: parsed.goal,
      source: "codex-registered"
    }
  };
}
