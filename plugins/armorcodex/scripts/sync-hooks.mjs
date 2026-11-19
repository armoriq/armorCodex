import { mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { HOOK_SYNC_LOG_FILENAME, HOOK_SYNC_STATE_FILENAME, codexHooksFile, recordSyncResult, syncOurHooks } from "./lib/hook-sync.mjs";
import { acquireSwapLock } from "./lib/update-apply.mjs";

const scriptsDir = path.dirname(fileURLToPath(import.meta.url));
const bootstrapPath = path.join(scriptsDir, "bootstrap.mjs");
const hooksFile = process.env.ARMORCODEX_SYNC_HOOKS_FILE?.trim() || codexHooksFile();
const dataDir = process.env.ARMORCODEX_SYNC_DATA_DIR?.trim();
if (!dataDir) process.exit(2);

let version = "";
try {
  version = JSON.parse(readFileSync(path.join(scriptsDir, "..", "package.json"), "utf8")).version ?? "";
} catch {}

mkdirSync(dataDir, { recursive: true });
const stateFile = path.join(dataDir, HOOK_SYNC_STATE_FILENAME);
const release = acquireSwapLock(`${stateFile}.lock`);
if (!release) process.exit(0);

let result;
try {
  result = await syncOurHooks({ hooksFile, bootstrapPath, cwd: process.env.HOME ?? process.cwd() });
} catch (error) {
  result = { status: "failed", reason: error instanceof Error ? error.message : String(error) };
}
try {
  recordSyncResult({ stateFile, logFile: path.join(dataDir, HOOK_SYNC_LOG_FILENAME), result, version });
} finally {
  release();
}
process.exit(result.status === "failed" || result.status === "rolled-back" ? 1 : 0);
