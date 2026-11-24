import { readFileSync } from "node:fs";
import { readFile, unlink } from "node:fs/promises";
import path from "node:path";
import { buildAuthHeaders } from "./common.mjs";
import { writePrivateFile } from "./fs-store.mjs";

const ORG_MODES = new Set(["shadow", "enforce"]);
const FETCH_TIMEOUT_MS = 3000;

const modeFile = (dataDir) => path.join(dataDir, "org-mode.json");

function cachedOrg(dataDir) {
  try {
    const { mode, notices } = JSON.parse(readFileSync(modeFile(dataDir), "utf8"));
    return { mode: ORG_MODES.has(mode) ? mode : null, notices: notices === true };
  } catch {
    return { mode: null, notices: false };
  }
}

export const orgModeForced = (env = process.env) => env.ARMORIQ_ORG_MODE?.trim() === "enforce";

export const orgModeKnown = (dataDir) => cachedOrg(dataDir).mode !== null;

export function orgMonitorFor(dataDir, env = process.env) {
  if (orgModeForced(env)) return false;
  return cachedOrg(dataDir).mode === "shadow";
}

export const orgMonitorNoticesFor = (dataDir, env = process.env) =>
  orgMonitorFor(dataDir, env) && cachedOrg(dataDir).notices;

export async function refreshOrgMode(config) {
  if (!config.apiKey) return;
  try {
    const res = await fetch(`${config.backendEndpoint}/policies/profiles/active`, {
      headers: buildAuthHeaders(config),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS)
    });
    if (!res.ok) return;
    const body = await res.json();
    if (!ORG_MODES.has(body?.enforcementMode)) return;
    await writePrivateFile(
      modeFile(config.dataDir),
      JSON.stringify({ mode: body.enforcementMode, notices: body.monitorNotices === true, at: new Date().toISOString() })
    );
  } catch (error) {
    process.stderr.write(`[armorcodex] workspace mode not read: ${error instanceof Error ? error.message : error}\n`);
  }
}

const wouldBePath = (config, toolUseId) =>
  typeof toolUseId === "string" && /^[A-Za-z0-9_-]+$/.test(toolUseId)
    ? path.join(config.dataDir, "would-be", toolUseId)
    : null;

export async function rememberWouldBe(config, toolUseId, verdict) {
  const file = wouldBePath(config, toolUseId);
  if (file && config.apiKey) await writePrivateFile(file, JSON.stringify(verdict)).catch(() => {});
}

export async function takeWouldBe(config, toolUseId) {
  const file = wouldBePath(config, toolUseId);
  if (!file) return null;
  const text = await readFile(file, "utf8").catch(() => "");
  await unlink(file).catch(() => {});
  try {
    return text ? JSON.parse(text) : null;
  } catch {
    return null;
  }
}

const MONITOR_NOTE = { block: "ArmorIQ would block this call in Enforce", hold: "ArmorIQ would ask for approval here in Enforce" };

export function monitorNote(action, reason) {
  const why = String(reason ?? "").split("\n")[0].slice(0, 200);
  return `${MONITOR_NOTE[action]}${why ? ` (${why})` : ""}. Monitor let it run.`;
}
