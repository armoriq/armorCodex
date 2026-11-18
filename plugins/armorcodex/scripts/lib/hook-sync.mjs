import { spawn } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { TRUST_TIMEOUT_MS, appServer, hooksToTrust, ourHookStatuses, trustEdits } from "./hook-trust.mjs";
import { parseHooksText, refreshOurHooks, routerCommand, serializeHooks, writeHooksText } from "./hooks-file.mjs";

export const HOOK_SYNC_STATE_FILENAME = "hooks-sync.json";
export const HOOK_SYNC_LOG_FILENAME = "hooks-sync.log";
export const HOOK_SYNC_RETRY_MS = 60 * 60 * 1000;

const PLUGIN_SUBDIR = path.join("plugins", "armorcodex");

export function codexHooksFile(env = process.env) {
  const codexHome = env.CODEX_HOME?.trim() || path.join(env.HOME?.trim() || homedir(), ".codex");
  return path.join(codexHome, "hooks.json");
}

export function pluginScript(installHome, name) {
  return path.join(installHome, PLUGIN_SUBDIR, "scripts", name);
}

export function staleHooksText(text, bootstrapPath) {
  const { config, layout } = parseHooksText(text);
  const refreshed = refreshOurHooks(config.hooks, { onlyCommand: routerCommand(bootstrapPath) });
  return refreshed.length === 0 ? null : { text: serializeHooks(config, layout), refreshed };
}

function readText(file) {
  try {
    return readFileSync(file, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

async function restoreTrust(server, prior, options) {
  const edits = trustEdits(prior);
  if (edits.length === 0) return;
  try {
    await server.request("config/batchWrite", { edits });
  } catch {
    const fresh = appServer(options);
    try {
      await fresh.request("initialize", { clientInfo: { name: "armorcodex-hook-sync", version: "1" } });
      fresh.notify("initialized", {});
      await fresh.request("config/batchWrite", { edits });
    } finally {
      fresh.close();
    }
  }
}

export async function syncOurHooks({
  hooksFile,
  bootstrapPath,
  codexBin = "codex",
  cwd = process.env.HOME ?? process.cwd(),
  env = process.env,
  timeoutMs = TRUST_TIMEOUT_MS
}) {
  const original = readText(hooksFile);
  if (original === null) return { status: "absent" };
  const stale = staleHooksText(original, bootstrapPath);
  if (!stale) return { status: "current" };

  const scope = { hooksFile, bootstrapPath };
  const serverOptions = { codexBin, env, timeoutMs };
  const server = appServer(serverOptions);
  const list = () => server.request("hooks/list", { cwds: [cwd] });
  let written = false;
  let trustSent = false;
  let prior = [];
  try {
    await server.request("initialize", { clientInfo: { name: "armorcodex-hook-sync", version: "1" } });
    server.notify("initialized", {});

    const listedBefore = await list();
    const before = ourHookStatuses(listedBefore, scope);
    if (before.size === 0) return { status: "skipped", reason: "codex lists no ArmorCodex hooks from this file" };
    const notTrusted = [...before].filter(([, status]) => status !== "trusted").map(([key]) => key);
    if (notTrusted.length > 0) {
      return { status: "skipped", reason: `ArmorCodex hooks were not trusted before the update: ${notTrusted.join(", ")}` };
    }
    prior = trustedHashes(listedBefore, scope);

    if (readText(hooksFile) !== original) return { status: "skipped", reason: "hooks.json changed while syncing" };
    writeHooksText(hooksFile, stale.text);
    written = true;

    const toTrust = hooksToTrust(await list(), scope).filter((hook) => before.has(hook.key));
    trustSent = true;
    if (toTrust.length > 0) await server.request("config/batchWrite", { edits: trustEdits(toTrust) });

    const after = ourHookStatuses(await list(), scope);
    const untrusted = [...after].filter(([, status]) => status !== "trusted").map(([key]) => key);
    if (after.size !== before.size || untrusted.length > 0) {
      throw new Error(`hooks not trusted after rewrite: ${untrusted.join(", ") || `${after.size} of ${before.size} listed`}`);
    }
    return { status: "synced", refreshed: stale.refreshed, trusted: toTrust.map((hook) => hook.eventName) };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    if (!written) return { status: "failed", reason };
    const rollback = [];
    try {
      if (readText(hooksFile) === stale.text) writeHooksText(hooksFile, original);
      else rollback.push("hooks.json changed again, not restored");
    } catch (restoreError) {
      rollback.push(`hooks.json not restored: ${restoreError?.message ?? restoreError}`);
    }
    if (trustSent) {
      try {
        await restoreTrust(server, prior, serverOptions);
      } catch (restoreError) {
        rollback.push(`trust not restored: ${restoreError?.message ?? restoreError}`);
      }
    }
    return { status: "rolled-back", reason: [reason, ...rollback].join("; ") };
  } finally {
    server.close();
  }
}

function trustedHashes(listResponse, { hooksFile, bootstrapPath }) {
  const command = routerCommand(bootstrapPath);
  const hooksPath = path.resolve(hooksFile);
  const picked = new Map();
  for (const entry of listResponse?.data ?? []) {
    for (const hook of entry?.hooks ?? []) {
      if (hook?.command !== command || path.resolve(hook?.sourcePath ?? "") !== hooksPath) continue;
      if (hook.trustStatus !== "trusted" || typeof hook.currentHash !== "string" || !hook.currentHash) continue;
      picked.set(hook.key, { key: hook.key, currentHash: hook.currentHash });
    }
  }
  return [...picked.values()];
}

export function readSyncState(stateFile) {
  try {
    return JSON.parse(readFileSync(stateFile, "utf8"));
  } catch {
    return null;
  }
}

export function recordSyncResult({ stateFile, logFile, result, version, now = new Date() }) {
  mkdirSync(path.dirname(stateFile), { recursive: true });
  const record = { ...result, version, at: now.toISOString() };
  writeFileSync(stateFile, `${JSON.stringify(record, null, 2)}\n`, "utf8");
  if (logFile && result.status !== "current" && result.status !== "absent") {
    const detail = result.reason ?? (result.refreshed ?? []).join(", ");
    appendFileSync(logFile, `${record.at} ${version} ${result.status}${detail ? ` ${detail}` : ""}\n`, "utf8");
  }
  return record;
}

function recentlyFailed(state, now) {
  if (!state || state.status === "synced" || state.status === "current" || state.status === "absent") return false;
  const at = Date.parse(state.at ?? "");
  return Number.isFinite(at) && now - at < HOOK_SYNC_RETRY_MS;
}

export function scheduleHookSync({ installHome, dataDir, env = process.env, now = Date.now(), spawnChild = spawn }) {
  try {
    const script = pluginScript(installHome, "sync-hooks.mjs");
    if (!existsSync(script)) return { started: false, reason: "no-sync-script" };
    const hooksFile = codexHooksFile(env);
    const text = readText(hooksFile);
    if (text === null) return { started: false, reason: "absent" };
    if (!staleHooksText(text, pluginScript(installHome, "bootstrap.mjs"))) return { started: false, reason: "current" };
    const stateFile = path.join(dataDir, HOOK_SYNC_STATE_FILENAME);
    if (recentlyFailed(readSyncState(stateFile), now)) return { started: false, reason: "backoff" };

    const child = spawnChild(process.execPath, [script], {
      detached: true,
      stdio: "ignore",
      env: { ...env, ARMORCODEX_SYNC_HOOKS_FILE: hooksFile, ARMORCODEX_SYNC_DATA_DIR: dataDir }
    });
    child.unref?.();
    return { started: true };
  } catch {
    return { started: false, reason: "error" };
  }
}
