import { createHash } from "node:crypto";
import path from "node:path";
import { buildAuthHeaders, normalizeToolName, postJson } from "./common.mjs";
import { readJson, writeJson } from "./fs-store.mjs";

export const BACKEND_UNREACHABLE = "backend_unreachable";
export const POSTURE_TIMEOUT_MS = 2000;
export const POSTURE_TTL_MS = 30_000;
export const STATUS_COMMAND = "/armor status";
export const COVERAGE_LINE =
  "Codex hooks only Bash, apply_patch and MCP calls, so ArmorCodex sees no read calls.";

const CAPABILITY_TOOLS = {
  read: ["read", "glob", "grep", "ls", "notebookread"],
  write: ["write", "edit", "multiedit", "notebookedit", "apply_patch"],
  shell: ["bash"],
  web: ["webfetch", "websearch"]
};

export function toolCapability(toolName) {
  if (typeof toolName !== "string") return "other";
  if (/^mcp__/i.test(toolName.trim())) return "mcp";
  const norm = normalizeToolName(toolName);
  for (const [capability, tools] of Object.entries(CAPABILITY_TOOLS)) {
    if (tools.includes(norm)) return capability;
  }
  return "other";
}

const postureFile = (config) => path.join(config.dataDir, "backend-posture.json");
const keyFingerprint = (apiKey) => createHash("sha256").update(apiKey).digest("hex").slice(0, 16);

export function classifyStatus(status) {
  if (status === 401) return "signed_out";
  if (status >= 500) return "unreachable";
  return "ok";
}

export async function recordBackendOutcome(config, state, now = Date.now()) {
  if (!config.apiKey || !config.backendEndpoint) return;
  const saved = await readJson(postureFile(config), null);
  if (saved?.backend === config.backendEndpoint && saved.key === keyFingerprint(config.apiKey) && saved.at > now) return;
  await writeJson(postureFile(config), {
    backend: config.backendEndpoint,
    key: keyFingerprint(config.apiKey),
    state,
    at: now,
    until: now + POSTURE_TTL_MS
  }).catch((error) => process.stderr.write(`[armorcodex] backend posture not saved: ${error?.message ?? error}\n`));
}

export async function cachedPosture(config, now = Date.now()) {
  if (!config.apiKey || !config.backendEndpoint) return null;
  const saved = await readJson(postureFile(config), null);
  if (
    !saved ||
    saved.backend !== config.backendEndpoint ||
    saved.key !== keyFingerprint(config.apiKey) ||
    !(now < saved.until)
  ) {
    return null;
  }
  return saved;
}

export async function probeBackend(config) {
  const started = Date.now();
  let state;
  try {
    const response = await postJson(
      `${config.backendEndpoint}/iap/validate-key`,
      {},
      buildAuthHeaders(config),
      POSTURE_TIMEOUT_MS
    );
    state = classifyStatus(response.status);
  } catch {
    state = "unreachable";
  }
  await recordBackendOutcome(config, state, started);
  return state;
}

export async function backendPosture(config) {
  if (!config.apiKey || !config.backendEndpoint) return "local";
  return (await cachedPosture(config))?.state ?? probeBackend(config);
}

export function localOnly(config) {
  return { ...config, apiKey: "", auditEnabled: false, observabilityEnabled: false, usageSyncEnabled: false };
}

export function unreachableReason(toolName, capability) {
  return (
    `ArmorCodex blocked ${toolName} (${BACKEND_UNREACHABLE}): the ArmorIQ backend did not answer, ` +
    `so ${capability} calls are blocked for up to 30 seconds. Run ${STATUS_COMMAND} for details.`
  );
}

export function isStatusCommand(prompt) {
  return typeof prompt === "string" && /^\s*\/?armor(?:codex:armor)?\s+status\s*$/i.test(prompt);
}

const POSTURE_LINES = {
  ok: "reachable",
  unreachable: `unreachable (${BACKEND_UNREACHABLE}): Bash, apply_patch, MCP and other calls are blocked; rechecked every 30 seconds`,
  signed_out: "rejected the stored key (401): running in local only mode until you sign in again"
};

export async function formatArmorStatus(config, { queuedRows }) {
  const lines = ["ArmorCodex status"];
  if (!config.apiKey) {
    lines.push(`  Signed in: no (local only mode, ${config.backendEndpoint})`);
  } else {
    lines.push(`  Signed in: yes (${config.backendEndpoint})`);
    const started = Date.now();
    const state = await probeBackend(config);
    lines.push(`  Backend: ${POSTURE_LINES[state]} (${Date.now() - started} ms, ${POSTURE_TIMEOUT_MS / 1000} s timeout)`);
  }
  lines.push(`  Audit rows waiting to upload: ${queuedRows}`);
  lines.push(`  Coverage: ${COVERAGE_LINE}`);
  return lines.join("\n");
}
