import {
  buildAuthHeaders,
  isPlainObject,
  parseStepIndex,
  postJson,
  readString
} from "./common.mjs";
import { auditLogin, createAuditWal } from "./audit-wal.mjs";
import { CAPTURE_ROW_BYTES } from "./audit-contract.mjs";
import { recordBackendOutcome } from "./backend-posture.mjs";
import { requireEndpoint } from "./config.mjs";

function getAuditWal(config) {
  return createAuditWal({ dataDir: config.dataDir, config, contentLimitBytes: CAPTURE_ROW_BYTES });
}

export function createIapService(config) {
  const backendEndpoint = config.backendEndpoint || config.verifyStepEndpoint?.replace(/\/iap\/verify-step$/, "") || "";
  const timeoutMs = config.timeoutMs || 8000;
  const headers = buildAuthHeaders(config);
  const authenticated = async (response, endpoint = backendEndpoint) => {
    const backend = backendEndpoint.replace(/\/+$/, "");
    if (response.ok && config.dataDir && config.apiKey && backend &&
      (endpoint === backend || endpoint.startsWith(backend + "/"))) {
      await getAuditWal(config).authenticationSucceeded(auditLogin(config));
      await recordBackendOutcome(config, "ok");
    }
  };

  return {
    async verifyStep(intentTokenRaw, csrgProofs, toolName) {
      const endpoint = config.verifyStepEndpoint;
      if (!endpoint || !config.csrgVerifyEnabled) {
        return { skipped: true };
      }

      const { token, tokenObj } = getTokenForVerification(intentTokenRaw);
      if (!token) {
        return { skipped: false, allowed: false, reason: "ArmorIQ intent token missing" };
      }

      const payload = { token };
      if (csrgProofs?.path) {
        payload.path = csrgProofs.path;
        const stepMatch = csrgProofs.path.match(/\/steps\/\[(\d+)\]/);
        if (stepMatch) {
          payload.step_index = Number.parseInt(stepMatch[1] || "0", 10);
        }
      }
      if (toolName) {
        payload.tool_name = toolName;
      }
      if (Array.isArray(csrgProofs?.proof)) {
        payload.proof = csrgProofs.proof;
      }
      if (csrgProofs?.valueDigest) {
        payload.context = {
          csrg_value_digest: csrgProofs.valueDigest,
          proof_source: "client"
        };
      }

      const response = await postJson(endpoint, payload, headers, timeoutMs);
      await authenticated(response, endpoint);
      if (!response.ok && !isPlainObject(response.data)) {
        throw new Error(
          response.text || `IAP verify-step failed with status ${response.status}`
        );
      }

      const data = isPlainObject(response.data) ? response.data : {};
      const tokenRaw =
        typeof data.intentTokenRaw === "string"
          ? data.intentTokenRaw
          : typeof data.tokenRaw === "string"
            ? data.tokenRaw
            : isPlainObject(data.token)
              ? JSON.stringify(data.token)
              : undefined;
      const parsedFromResponse = tokenRaw ? extractPlanFromResponse(tokenRaw) : null;
      const fallbackPlan = isPlainObject(tokenObj?.plan)
        ? tokenObj.plan
        : isPlainObject(tokenObj?.rawToken?.plan)
          ? tokenObj.rawToken.plan
          : undefined;
      const stepIndex =
        parseStepIndex(data?.step?.step_index) ??
        parseStepIndex(data?.execution_state?.current_step) ??
        parseStepIndexFromPath(csrgProofs?.path) ??
        undefined;

      return {
        skipped: false,
        allowed: data.allowed !== false,
        reason: typeof data.reason === "string" ? data.reason : "",
        tokenRaw,
        plan: isPlainObject(data.plan) ? data.plan : parsedFromResponse?.plan || fallbackPlan,
        expiresAt: Number.isFinite(data.expiresAt) ? data.expiresAt : parsedFromResponse?.expiresAt,
        stepIndex
      };
    },

    async verifyWithCsrg(path, value, proof, token, context) {
      if (!config.csrgVerifyEnabled) {
        throw new Error("CSRG verification is disabled");
      }

      const payload = { path, value, proof, token, context };
      const response = await postJson(
        `${requireEndpoint(config, "csrgEndpoint")}/verify/action`,
        payload,
        { "Content-Type": "application/json" },
        Math.min(timeoutMs, 15000)
      );

      if (response.ok && response.data) {
        return response.data;
      }

      if (response.data) {
        return {
          allowed: false,
          reason:
            response.data.reason ||
            `CSRG verification failed: ${response.text || "unknown error"}`
        };
      }

      return {
        allowed: false,
        reason: response.text
          ? `CSRG verification failed: ${response.text}`
          : `CSRG verification failed with status ${response.status}`
      };
    },

    async createAuditLog(dto) {
      const response = await postJson(
        `${backendEndpoint}/iap/audit`,
        dto,
        headers,
        timeoutMs
      );

      if (!response.ok || !response.data) {
        const message = response.text
          ? `IAP audit creation failed: ${response.text}`
          : `IAP audit creation failed with status ${response.status}`;
        throw new Error(message);
      }

      await authenticated(response);
      return response.data;
    },

    async enqueueAudit(dto, options) {
      const wal = getAuditWal(config);
      await wal.appendLine(dto, options);
    },

    /** Preserve status, outcomes and Retry-After so the outbox never acknowledges an unproved delivery. */
    async shipAuditBatch(rows) {
      if (!Array.isArray(rows) || rows.length === 0) {
        return { status: 200, body: { written: 0, failures: [] }, headers: {} };
      }
      const response = await postJson(
        `${backendEndpoint}/iap/audit/batch`,
        { rows },
        headers,
        timeoutMs
      );
      await authenticated(response);
      return { status: response.status, body: response.data, headers: response.headers };
    },

    csrgProofsRequired() {
      return Boolean(config.requireCsrgProofs);
    },

    csrgVerifyIsEnabled() {
      return Boolean(config.csrgVerifyEnabled);
    }
  };
}

function getTokenForVerification(intentTokenRaw) {
  if (typeof intentTokenRaw !== "string") {
    return { token: "", tokenObj: null };
  }
  try {
    const parsed = JSON.parse(intentTokenRaw);
    if (isPlainObject(parsed)) {
      const jwtToken = readString(parsed.jwtToken) || readString(parsed.jwt_token);
      if (jwtToken) {
        return { token: jwtToken, tokenObj: parsed };
      }
      return { token: intentTokenRaw, tokenObj: parsed };
    }
    return { token: intentTokenRaw, tokenObj: null };
  } catch {
    return { token: intentTokenRaw, tokenObj: null };
  }
}

function extractPlanFromResponse(tokenRaw) {
  try {
    const parsed = JSON.parse(tokenRaw);
    if (!isPlainObject(parsed)) return null;
    const plan =
      isPlainObject(parsed.plan)
        ? parsed.plan
        : isPlainObject(parsed.rawToken?.plan)
          ? parsed.rawToken.plan
          : null;
    const expiresAt =
      Number.isFinite(parsed.expiresAt) ? parsed.expiresAt :
      Number.isFinite(parsed.token?.expires_at) ? parsed.token.expires_at :
      undefined;
    return plan ? { plan, expiresAt } : null;
  } catch {
    return null;
  }
}

function parseStepIndexFromPath(path) {
  if (!path) return null;
  const match = path.match(/\/steps\/\[(\d+)\]/);
  if (!match) return null;
  const index = Number.parseInt(match[1] || "", 10);
  return Number.isFinite(index) ? index : null;
}
