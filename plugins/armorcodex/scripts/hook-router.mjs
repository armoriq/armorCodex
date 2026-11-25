import { emitJson } from "./lib/hook-stdout.mjs";
import { cachedPosture, localOnly } from "./lib/backend-posture.mjs";
import { dataDirectory, loadConfig, loadSettings } from "./lib/config.mjs";
import { isPlainObject } from "./lib/common.mjs";
import { createAuditEnvelope } from "./lib/audit-wal.mjs";
import { denyPermissionRequest, denyPreTool } from "./lib/hook-output.mjs";
import {
  auditFallbackStop,
  handlePermissionRequest,
  handlePreToolUse,
  handlePostToolUse,
  handlePostToolUseFailure,
  handleSessionEnd,
  handleSessionStart,
  handleStop,
  handleUserPromptSubmit
} from "./lib/engine.mjs";
import { ensurePrivateDir } from "./lib/fs-store.mjs";
import { observeHook } from "./lib/observability.mjs";
import { withReach } from "./lib/reach.mjs";
import { launchLiveUsage, trackUsageSession } from "./lib/usage-sync-launch.mjs";

let currentEvent = "";
let currentConfig;
let currentInput = {};
let currentEnvelope = createAuditEnvelope({});

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function debugLog(config, message) {
  if (!config.debug) {
    return;
  }
  process.stderr.write(`[armorcodex] ${message}\n`);
}

async function main() {
  const rawInput = await readStdin();
  let input;
  let invalidPayload = false;
  try {
    input = JSON.parse(rawInput);
    if (!isPlainObject(input)) throw new Error("Hook payload must be an object");
    currentInput = input;
    currentEnvelope = createAuditEnvelope(input, currentEnvelope.toolCallId);
    currentEvent = typeof input.hook_event_name === "string" ? input.hook_event_name : "";
  } catch {
    invalidPayload = true;
  }
  let config = loadConfig();
  currentConfig = config;
  config.readCurrentAuth = () => loadConfig();
  await ensurePrivateDir(config.dataDir);
  if (invalidPayload) {
    // Fail closed: in enforce mode a malformed PreToolUse payload is denied, not silently allowed.
    if (config.mode === "enforce" && !config.orgMonitor) {
      if ((await cachedPosture(config))?.state === "signed_out") config = localOnly(config);
      await auditFallbackStop({}, config, "invalid_payload", "ArmorCodex hook payload invalid JSON or object", currentEnvelope);
      emitJson(denyPreTool("ArmorCodex hook payload invalid JSON"));
    }
    return;
  }
  const event = currentEvent;
  debugLog(config, `hook=${event}`);
  if ((await cachedPosture(config))?.state === "signed_out") config = localOnly(config);
  currentConfig = config;
  await trackUsageSession(event, input, config);

  let output;

  switch (event) {
    case "SessionStart":
      output = await handleSessionStart(input, config);
      break;
    case "UserPromptSubmit":
      output = await handleUserPromptSubmit(input, config);
      break;
    case "PreToolUse":
      output = await handlePreToolUse(input, config, currentEnvelope);
      break;
    case "PermissionRequest":
      output = await handlePermissionRequest(input, config, currentEnvelope);
      break;
    case "PostToolUse":
      output = await handlePostToolUse(input, config, currentEnvelope);
      break;
    case "PostToolUseFailure":
      output = await handlePostToolUseFailure(input, config, currentEnvelope);
      break;
    case "Stop":
      output = await handleStop(input, config);
      break;
    case "SessionEnd":
      output = await handleSessionEnd(input, config);
      break;
    default:
      debugLog(config, `unhandled hook event: ${event}`);
      return;
  }

  output = withReach(event, input, config, output);
  if (output) {
    emitJson(output);
  }
  if (event === "Stop") launchLiveUsage(config, input);

  await observeHook(event, input, output, config);
}

main().catch(async (error) => {
  const message = error instanceof Error ? error.message : String(error);
  let mode = "enforce";
  let debug = false;
  try {
    const config = currentConfig || loadSettings();
    mode = config.orgMonitor ? "monitor" : config.mode;
    debug = config.debug;
  } catch {
    // loadConfig itself threw (e.g. malformed credentials file). Stay
    // fail-closed: default to enforce rather than a silent allow.
  }
  if (debug) {
    process.stderr.write(`[armorcodex] error=${message}\n`);
  }
  if (mode === "enforce" && (currentEvent === "PreToolUse" || currentEvent === "")) {
    try {
      const config = currentConfig || { dataDir: dataDirectory(), identityUnknown: true };
      await auditFallbackStop(currentInput, config, "internal_error", "ArmorCodex internal hook error", currentEnvelope);
    } catch {
      process.stderr.write("[armorcodex] audit capture failed: internal_error\n");
    }
    emitJson(denyPreTool(`ArmorCodex internal error: ${message}`));
  } else if (mode === "enforce" && currentEvent === "PermissionRequest") {
    emitJson(denyPermissionRequest(`ArmorCodex internal error: ${message}`));
  } else {
    process.stderr.write(`[armorcodex] hook failed: ${currentEvent || "unknown"}\n`);
  }
});
