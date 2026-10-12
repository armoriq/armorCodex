import { readFileSync } from "node:fs";
import path from "node:path";

const MAX_TITLE = 200;
const ZONED_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})$/;

export function boundedTitle(title) {
  if (title.length <= MAX_TITLE) return title;
  const end = /[\uD800-\uDBFF]/.test(title[MAX_TITLE - 2]) ? MAX_TITLE - 2 : MAX_TITLE - 1;
  return `${title.slice(0, end)}…`;
}

const validRow = (row) =>
  typeof row?.id === "string" &&
  typeof row.thread_name === "string" &&
  row.thread_name.trim() !== "" &&
  typeof row.updated_at === "string" &&
  ZONED_TIMESTAMP.test(row.updated_at) &&
  !Number.isNaN(Date.parse(row.updated_at));

function parseRow(line) {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

export function codexTitles(codexHome) {
  let raw;
  try {
    raw = readFileSync(path.join(codexHome, "session_index.jsonl"), "utf8");
  } catch {
    return new Map();
  }
  const titles = new Map();
  for (const row of raw.split("\n").map(parseRow).filter(validRow)) {
    titles.set(row.id, {
      sessionId: row.id,
      title: boundedTitle(row.thread_name.trim()),
      titleSource: "codex-session-index",
      titleUpdatedAt: row.updated_at
    });
  }
  return titles;
}
