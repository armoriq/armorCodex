import test from "node:test";
import assert from "node:assert/strict";
import {
  extractPlanJsonBlock,
  parsePlanMarkdown
} from "../scripts/lib/planner.mjs";

test("extractPlanJsonBlock extracts fenced JSON from markdown", () => {
  const md = `# My plan
Some text here.

\`\`\`json
{
  "goal": "Read and summarize",
  "steps": [{ "action": "Read", "description": "Read the file" }]
}
\`\`\`

More text.`;
  const result = extractPlanJsonBlock(md);
  assert.ok(result);
  assert.equal(result.goal, "Read and summarize");
  assert.equal(result.steps.length, 1);
  assert.equal(result.steps[0].action, "Read");
});

test("extractPlanJsonBlock returns null when no JSON block", () => {
  assert.equal(extractPlanJsonBlock("just text"), null);
  assert.equal(extractPlanJsonBlock(""), null);
  assert.equal(extractPlanJsonBlock(null), null);
});

test("extractPlanJsonBlock returns null for invalid JSON", () => {
  const md = "```json\n{invalid json}\n```";
  assert.equal(extractPlanJsonBlock(md), null);
});

test("extractPlanJsonBlock prefers last valid JSON block with steps", () => {
  const md = `Intro
\`\`\`json
{"example": true}
\`\`\`
\`\`\`json
{"goal":"Real plan","steps":[{"action":"Read","description":"read"}]}
\`\`\``;
  const result = extractPlanJsonBlock(md);
  assert.ok(result);
  assert.equal(result.goal, "Real plan");
  assert.equal(result.steps.length, 1);
});

test("extractPlanJsonBlock returns null when no JSON block has steps", () => {
  const md = `\`\`\`json
{"example": true}
\`\`\`
\`\`\`json
{"another":"object"}
\`\`\``;
  assert.equal(extractPlanJsonBlock(md), null);
});

test("parsePlanMarkdown extracts tools from backtick references", () => {
  const md = `# Deploy feature
1. \`Read\` the config file
2. \`Edit\` the deployment manifest
3. Run \`Bash\` to execute deploy script
`;
  const plan = parsePlanMarkdown(md);
  assert.ok(plan);
  assert.ok(plan.steps.length >= 3);
  const actions = plan.steps.map((s) => s.action.toLowerCase());
  assert.ok(actions.includes("read"));
  assert.ok(actions.includes("edit"));
  assert.ok(actions.includes("bash"));
  assert.equal(plan.metadata.goal, "Deploy feature");
});

test("parsePlanMarkdown handles plan with no numbered steps", () => {
  const md = `# Simple task
Use \`Grep\` and \`Glob\` to find the file.
`;
  const plan = parsePlanMarkdown(md);
  assert.ok(plan);
  assert.ok(plan.steps.length >= 2);
  const actions = plan.steps.map((s) => s.action.toLowerCase());
  assert.ok(actions.includes("grep"));
  assert.ok(actions.includes("glob"));
});

test("parsePlanMarkdown returns empty steps for unrecognizable plan", () => {
  const md = "Just a note with no tools.";
  const plan = parsePlanMarkdown(md);
  assert.ok(plan);
  assert.equal(plan.steps.length, 0);
});
