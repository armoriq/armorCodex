import armoriqSdk from "@armoriq/sdk-dev";
import { statSync } from "node:fs";
import path from "node:path";

const { codexSessionTitle } = armoriqSdk;

const MAX_TITLE = 200;
const ZONED = /(?:Z|[+-]\d{2}:\d{2})$/;

export function boundedTitle(title) {
  if (title.length <= MAX_TITLE) return title;
  const end = /[\uD800-\uDBFF]/.test(title[MAX_TITLE - 2]) ? MAX_TITLE - 2 : MAX_TITLE - 1;
  return `${title.slice(0, end)}…`;
}

export function titleIndexStamp(codexHome) {
  const st = statSync(path.join(codexHome, "session_index.jsonl"), { throwIfNoEntry: false });
  return st ? `${st.size}:${st.mtimeMs}` : null;
}

export function changedTitles(codexHome, sessionIds, sent) {
  return sessionIds.flatMap((sessionId) => {
    const found = codexSessionTitle(codexHome, sessionId);
    const at = found?.titleUpdatedAt;
    if (!at || !ZONED.test(at) || Number.isNaN(Date.parse(at)) || sent[sessionId] === at) return [];
    return [{ sessionId, title: boundedTitle(found.title), titleSource: found.titleSource, titleUpdatedAt: at }];
  });
}
