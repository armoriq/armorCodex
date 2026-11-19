import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";

export function auditRows(dataDir) {
  const audit = path.join(dataDir, "audit");
  const store = path.join(audit, "outbox-v1");
  const files = [path.join(audit, "current.jsonl")];
  if (existsSync(store)) {
    for (const entry of readdirSync(store, { withFileTypes: true })) {
      if (entry.isDirectory() && /^(queue|legacy)\./.test(entry.name)) {
        files.push(path.join(store, entry.name, "rows.jsonl"));
      }
    }
  }
  return files.filter(existsSync).flatMap((file) => readFileSync(file, "utf8")
    .split("\n").filter(Boolean).map((line) => JSON.parse(line)));
}
