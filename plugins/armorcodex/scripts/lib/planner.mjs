import { readFile } from "node:fs/promises";
import { normalizeToolName } from "./common.mjs";

export function extractPlanJsonBlock(markdown) {
  if (!markdown) return null;
  const matches = Array.from(markdown.matchAll(/```json\s*([\s\S]*?)```/g));
  if (matches.length === 0) return null;
  for (let i = matches.length - 1; i >= 0; i -= 1) {
    const raw = matches[i][1]?.trim();
    if (!raw) continue;
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      continue;
    }
    if (parsed && typeof parsed === "object" && Array.isArray(parsed.steps)) {
      return parsed;
    }
  }
  return null;
}

export async function parsePlanFile(planFilePath) {
  if (!planFilePath) return null;
  let content;
  try {
    content = await readFile(planFilePath, "utf8");
  } catch {
    return null;
  }
  if (!content.trim()) return null;
  return parsePlanMarkdown(content);
}

export function parsePlanMarkdown(markdown) {
  const steps = [];
  const seenTools = new Set();

  const backtickPattern = /`([A-Za-z][A-Za-z0-9_]*(?:__[A-Za-z0-9_]+)*)`/g;
  for (const match of markdown.matchAll(backtickPattern)) {
    const name = match[1]?.trim();
    if (name && name.length > 1 && name.length < 80) {
      seenTools.add(normalizeToolName(name));
    }
  }

  const stepPattern = /^[\s]*(?:\d+[.)]\s+|[-*]\s+)(.+)/gm;
  for (const match of markdown.matchAll(stepPattern)) {
    const text = match[1]?.trim();
    if (!text || text.length < 3) continue;
    const toolRef = extractToolFromStepText(text);
    if (toolRef) {
      seenTools.add(normalizeToolName(toolRef));
      steps.push({
        action: toolRef,
        mcp: "codex",
        description: text,
        metadata: {}
      });
    }
  }

  if (steps.length === 0) {
    for (const toolName of seenTools) {
      steps.push({
        action: toolName,
        mcp: "codex",
        description: `Use ${toolName}`,
        metadata: {}
      });
    }
  }

  const headingMatch = markdown.match(/^#+\s+(.+)/m);
  const goal = headingMatch ? headingMatch[1].trim() : markdown.split("\n")[0]?.trim() || "Plan";

  return {
    steps,
    metadata: { goal, source: "plan-file-heuristic" }
  };
}

const KNOWN_TOOLS = new Set([
  "read", "write", "edit", "bash", "glob", "grep", "agent",
  "webfetch", "websearch", "notebookedit", "askuserquestion",
  "taskcreate", "taskupdate", "skill"
]);

function extractToolFromStepText(text) {
  const backtickMatch = text.match(/`([A-Za-z][A-Za-z0-9_]*(?:__[A-Za-z0-9_]+)*)`/);
  if (backtickMatch) return backtickMatch[1];

  const mcpMatch = text.match(/\b(mcp__[a-z0-9_]+__[a-z0-9_]+)\b/i);
  if (mcpMatch) return mcpMatch[1];

  const words = text.split(/\s+/);
  const firstWord = words[0]?.toLowerCase().replace(/[^a-z]/g, "");
  if (KNOWN_TOOLS.has(firstWord)) {
    return firstWord.charAt(0).toUpperCase() + firstWord.slice(1);
  }

  return null;
}

export function resolvePlanFilePath(input) {
  const transcriptPath =
    typeof input?.transcript_path === "string" ? input.transcript_path : "";

  const sessionMatch = transcriptPath.match(
    /sessions\/([^/]+?)(?:\.jsonl)?$/
  );
  const sessionName = sessionMatch ? sessionMatch[1] : null;

  if (sessionName) {
    const homeDir = process.env.HOME || process.env.USERPROFILE || "/tmp";
    return `${homeDir}/.codex/plans/${sessionName}.md`;
  }

  return null;
}
