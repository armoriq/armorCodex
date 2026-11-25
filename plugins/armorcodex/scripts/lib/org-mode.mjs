import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { readFile, rm, unlink } from "node:fs/promises";
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

export function orgMonitorFor(dataDir, env = process.env) {
  if (orgModeForced(env)) return false;
  return cachedOrg(dataDir).mode !== "enforce";
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

export const leaveOrgMonitor = (config) => ({
  ...config,
  orgMonitor: false,
  orgMonitorNotices: false,
  ...config.beforeOrgMonitor
});

const sessionWouldBeDir = (config, sessionId) =>
  path.join(config.dataDir, "would-be", createHash("sha256").update(String(sessionId ?? "")).digest("hex").slice(0, 32));

const wouldBePath = (config, { session_id: sessionId, tool_use_id: toolUseId }) =>
  typeof toolUseId === "string" && /^[A-Za-z0-9_-]+$/.test(toolUseId)
    ? path.join(sessionWouldBeDir(config, sessionId), toolUseId)
    : null;

const lostVerdict = (why) => process.stderr.write(`[armorcodex] would-be verdict not recorded: ${why}\n`);

export async function rememberWouldBe(config, input, verdict) {
  if (!config.apiKey) return;
  const file = wouldBePath(config, input);
  if (!file) return lostVerdict("no tool_use_id");
  await writePrivateFile(file, JSON.stringify(verdict)).catch((error) =>
    lostVerdict(error instanceof Error ? error.message : String(error))
  );
}

export async function dropWouldBe(config, sessionId) {
  await rm(sessionWouldBeDir(config, sessionId), { recursive: true, force: true });
}

export async function takeWouldBe(config, input) {
  const file = wouldBePath(config, input);
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
