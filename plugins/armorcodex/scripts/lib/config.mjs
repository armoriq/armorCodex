import armoriqSdk from "@armoriq/sdk-dev";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import path from "node:path";
import { parseBoolean, parseInteger, parseList } from "./common.mjs";

const { ARMORIQ_ENV: BUILD_ENV, ENDPOINTS } = createRequire(import.meta.url)(
  "@armoriq/sdk-dev/dist/_build_env.js",
);

const ENV_NAMES = {
  "": BUILD_ENV,
  production: "production",
  prod: "production",
  staging: "staging",
  stage: "staging",
  local: "local",
  development: "local",
  dev: "local",
  test: "local",
};

function targetEnv(env) {
  const named = (env.ARMORIQ_ENV || "").trim().toLowerCase();
  if (!Object.hasOwn(ENV_NAMES, named)) {
    throw new Error(
      `ARMORIQ_ENV=${env.ARMORIQ_ENV} is not one of ${Object.keys(ENV_NAMES).filter(Boolean).join(", ")}.`,
    );
  }
  const armoriqEnv = ENV_NAMES[named];
  const useProduction = parseBoolean(
    pluginOpt(env, "USE_PRODUCTION", "ARMORCODEX_USE_PRODUCTION") || undefined,
    armoriqEnv === "production",
  );
  if (useProduction) return "production";
  return armoriqEnv === "production" ? "local" : armoriqEnv;
}

function pairedRow(backend) {
  return Object.values(ENDPOINTS).find((row) => row.backend === backend);
}

const ENDPOINT_VARIABLES = {
  proxyEndpoint: ["proxy", "PROXY_ENDPOINT or ARMORCODEX_PROXY_ENDPOINT"],
  iapEndpoint: ["IAP", "IAP_ENDPOINT or ARMORCODEX_IAP_ENDPOINT"],
  csrgEndpoint: [
    "CSRG endpoint",
    "CSRG_URL, IAP_ENDPOINT or ARMORCODEX_IAP_ENDPOINT",
  ],
};

export function requireEndpoint(config, name) {
  if (config[name]) return config[name];
  const [label, variables] = ENDPOINT_VARIABLES[name];
  throw new Error(
    `${config.backendEndpoint} is not a known ArmorIQ backend, so ArmorCodex has no ${label} for it. Set ${variables}.`,
  );
}

const firstSet = (env, ...names) =>
  names.map((name) => env[name]?.trim()).find(Boolean) || "";

function resolveEndpoints(env) {
  const target = targetEnv(env);
  const backendOverride = firstSet(
    env,
    "ARMORCODEX_BACKEND_ENDPOINT",
    "BACKEND_ENDPOINT",
  ).replace(/\/+$/, "");
  const paired = backendOverride
    ? pairedRow(backendOverride)
    : ENDPOINTS[target];
  const iapEndpoint =
    firstSet(env, "ARMORCODEX_IAP_ENDPOINT", "IAP_ENDPOINT") ||
    paired?.iap ||
    "";
  return {
    useProduction: target === "production",
    backendEndpoint: backendOverride || ENDPOINTS[target].backend,
    iapEndpoint,
    proxyEndpoint:
      firstSet(env, "ARMORCODEX_PROXY_ENDPOINT", "PROXY_ENDPOINT") ||
      paired?.proxy ||
      "",
    csrgEndpoint: pluginOpt(env, "CSRG_ENDPOINT", "CSRG_URL") || iapEndpoint,
  };
}

/**
 * Read a config value from plugin userConfig env, falling back to the
 * ARMORCODEX_* env var used by repo-local hook installs.
 */
function pluginOpt(env, pluginKey, legacyKey) {
  const pluginVal =
    env[`CODEX_PLUGIN_OPTION_${pluginKey}`]?.trim() ||
    env[`CLAUDE_PLUGIN_OPTION_${pluginKey}`]?.trim();
  if (pluginVal) return pluginVal;
  if (legacyKey) return env[legacyKey]?.trim() || "";
  return "";
}

const PRODUCT = "armorcodex";
const { loadLoginContext } = armoriqSdk;

export function loadConfig(env = process.env) {
  const mode = (
    pluginOpt(env, "MODE", "ARMORCODEX_MODE") || "enforce"
  ).toLowerCase();
  const {
    useProduction,
    backendEndpoint,
    iapEndpoint,
    proxyEndpoint,
    csrgEndpoint,
  } = resolveEndpoints(env);

  // Data directory: prefer plugin-injected storage, then
  // ARMORCODEX_DATA_DIR, then default ~/.codex/armorcodex.
  const dataDir =
    env.CODEX_PLUGIN_DATA?.trim() ||
    env.CLAUDE_PLUGIN_DATA?.trim() ||
    env.ARMORCODEX_DATA_DIR?.trim() ||
    path.join(homedir(), ".codex", "armorcodex");

  const policyFile =
    env.ARMORCODEX_POLICY_FILE?.trim() || path.join(dataDir, "policy.json");
  const runtimeFile =
    env.ARMORCODEX_RUNTIME_FILE?.trim() || path.join(dataDir, "runtime.json");

  const timeoutMs = parseInteger(env.ARMORCODEX_TIMEOUT_MS, 8000);

  const login = loadLoginContext({
    backend: backendEndpoint,
    product: PRODUCT,
  });
  const profile = login?.profile;
  const apiKey = profile?.apiKey ?? "";

  // Observability ("Model A" trace export) is ON by default whenever an API
  // key is configured — opt out via the `disable_observability` plugin
  // option or the ARMORCODEX_OBSERVABILITY_DISABLED env var. Mirrors
  // armorClaude's config shape (`observabilityEnabled`/`observabilityEndpoint`/
  // `observabilityProduct`) so the bridge module is a drop-in sibling.
  const observabilityDisabled = parseBoolean(
    pluginOpt(
      env,
      "DISABLE_OBSERVABILITY",
      "ARMORCODEX_OBSERVABILITY_DISABLED",
    ) || undefined,
    false,
  );
  const usageSyncDisabled = parseBoolean(
    pluginOpt(env, "DISABLE_USAGE_SYNC", "ARMORCODEX_USAGE_SYNC_DISABLED") || undefined,
    false
  );

  return {
    mode: mode === "monitor" ? "monitor" : "enforce",
    dataDir,
    policyFile,
    runtimeFile,
    useProduction,
    backendEndpoint,
    iapEndpoint,
    proxyEndpoint,
    csrgEndpoint,
    apiKey,
    orgId: profile?.orgId ?? "",

    // Observability ("Model A" trace export, per-plan via disk — see
    // scripts/lib/observability.mjs). Default ON whenever an API key is
    // present; opt out via `disable_observability` plugin option or
    // ARMORCODEX_OBSERVABILITY_DISABLED.
    observabilityEnabled: !observabilityDisabled && Boolean(apiKey),
    observabilityEndpoint: backendEndpoint,
    observabilityProduct: "armorcodex",
    usageSyncEnabled: !observabilityDisabled && !usageSyncDisabled && Boolean(apiKey),

    useSdkIntent: parseBoolean(env.ARMORCODEX_USE_SDK_INTENT, true),
    intentEndpoint: env.ARMORCODEX_INTENT_URL?.trim() || "",
    verifyStepEndpoint:
      env.ARMORCODEX_VERIFY_STEP_URL?.trim() ||
      `${backendEndpoint}/iap/verify-step`,
    // 1 hour covers a full working session without forcing a mid-turn replan.
    // Set ARMORCODEX_VALIDITY_SECONDS to tighten for compliance environments.
    validitySeconds: parseInteger(env.ARMORCODEX_VALIDITY_SECONDS, 3600),
    // Proactively refresh the intent token when it has less than this many
    // seconds of life left, so tool calls don't hit the expiry boundary.
    refreshThresholdSeconds: parseInteger(
      env.ARMORCODEX_REFRESH_THRESHOLD_SECONDS,
      30,
    ),
    timeoutMs,
    // One attempt per tool call is usually right — a hung backend shouldn't
    // stall Codex for timeout * retries. Users who really want retries can
    // opt in via ARMORCODEX_MAX_RETRIES.
    maxRetries: parseInteger(env.ARMORCODEX_MAX_RETRIES, 1),
    verifySsl: parseBoolean(env.ARMORCODEX_VERIFY_SSL, true),
    llmId: env.ARMORCODEX_LLM_ID?.trim() || "openai-codex",
    // Sent on dashboard telemetry (token usage) and in the intent plan metadata
    // so attribution works with a single generic API key (no per-product key).
    productSlug: "armorcodex",
    mcpName: env.ARMORCODEX_MCP_NAME?.trim() || "codex",
    userId: profile?.userId ?? "",
    loggedInAt: profile?.loggedInAt ?? "",
    loginHistory: login?.loginHistory ?? null,
    agentId: env.ARMORCODEX_AGENT_ID?.trim() || "codex",
    contextId: env.ARMORCODEX_CONTEXT_ID?.trim() || "default",

    // Intent enforcement — default true (enforce plan mode)
    intentRequired: parseBoolean(
      pluginOpt(env, "INTENT_REQUIRED", "ARMORCODEX_INTENT_REQUIRED") ||
        undefined,
      true,
    ),
    // CSRG verification disabled by default until tenant OPA policies are
    // configured to allow Codex tools. The OPA default-deny behavior
    // blocks all tools when no matching policy exists. Enable once your
    // tenant has allow-rules for the tools Codex uses.
    requireCsrgProofs: parseBoolean(env.REQUIRE_CSRG_PROOFS, false),
    csrgVerifyEnabled: parseBoolean(env.CSRG_VERIFY_ENABLED, false),

    // Policy management
    policyUpdateEnabled: parseBoolean(
      env.ARMORCODEX_POLICY_UPDATE_ENABLED,
      true,
    ),
    policyUpdateAllowList: parseList(
      env.ARMORCODEX_POLICY_UPDATE_ALLOWLIST || "*",
    ),
    contextHintsEnabled: parseBoolean(
      env.ARMORCODEX_CONTEXT_HINTS_ENABLED,
      true,
    ),

    // Crypto policy binding (Merkle tree)
    cryptoPolicyEnabled: parseBoolean(
      pluginOpt(
        env,
        "CRYPTO_POLICY_ENABLED",
        "ARMORCODEX_CRYPTO_POLICY_ENABLED",
      ) || undefined,
      false,
    ),

    // Audit logging
    auditEnabled: parseBoolean(env.ARMORCODEX_AUDIT_ENABLED, Boolean(apiKey)),

    // Plan directive injection (tells Codex to register a plan via MCP tool)
    planningEnabled: parseBoolean(env.ARMORCODEX_PLANNING_ENABLED, true),

    // Param sanitization limits
    sanitize: {
      maxChars: parseInteger(env.ARMORCODEX_MAX_PARAM_CHARS, 2000),
      maxDepth: parseInteger(env.ARMORCODEX_MAX_PARAM_DEPTH, 4),
      maxKeys: parseInteger(env.ARMORCODEX_MAX_PARAM_KEYS, 50),
      maxItems: parseInteger(env.ARMORCODEX_MAX_PARAM_ITEMS, 50),
    },

    debug: parseBoolean(env.ARMORCODEX_DEBUG, false),
  };
}
