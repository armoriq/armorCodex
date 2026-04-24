import { createHash } from "node:crypto";

export function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function normalizeToolName(name) {
  return typeof name === "string" ? name.trim().toLowerCase() : "";
}

export function parseBoolean(value, defaultValue = false) {
  if (typeof value !== "string") {
    return defaultValue;
  }
  const normalized = value.trim().toLowerCase();
  if (!normalized) {
    return defaultValue;
  }
  if (["1", "true", "yes", "y", "on"].includes(normalized)) {
    return true;
  }
  if (["0", "false", "no", "n", "off"].includes(normalized)) {
    return false;
  }
  return defaultValue;
}

export function parseInteger(value, defaultValue) {
  if (typeof value !== "string") {
    return defaultValue;
  }
  const parsed = Number.parseInt(value.trim(), 10);
  return Number.isFinite(parsed) ? parsed : defaultValue;
}

export function parseList(value) {
  if (typeof value !== "string") {
    return [];
  }
  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

export function isSubsetValue(candidate, target) {
  if (candidate === undefined) {
    return true;
  }
  if (candidate === null || target === null) {
    return candidate === target;
  }
  if (Array.isArray(candidate)) {
    if (!Array.isArray(target)) {
      return false;
    }
    return candidate.every((value) => target.some((item) => isSubsetValue(value, item)));
  }
  if (isPlainObject(candidate)) {
    if (!isPlainObject(target)) {
      return false;
    }
    for (const [key, value] of Object.entries(candidate)) {
      if (!isSubsetValue(value, target[key])) {
        return false;
      }
    }
    return true;
  }
  return candidate === target;
}

function sanitizeValue(value, limits, depth) {
  if (depth > limits.maxDepth) {
    return "<max-depth>";
  }
  if (value == null) {
    return value;
  }
  if (typeof value === "string") {
    return value.length > limits.maxChars ? `${value.slice(0, limits.maxChars)}...` : value;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "bigint") {
    return value.toString();
  }
  if (typeof value === "symbol") {
    return value.toString();
  }
  if (typeof value === "function") {
    return "<function>";
  }
  if (value instanceof Uint8Array) {
    return `<binary:${value.length}>`;
  }
  if (Array.isArray(value)) {
    return value.slice(0, limits.maxItems).map((entry) => sanitizeValue(entry, limits, depth + 1));
  }
  if (isPlainObject(value)) {
    const out = {};
    for (const [key, item] of Object.entries(value).slice(0, limits.maxKeys)) {
      out[key] = sanitizeValue(item, limits, depth + 1);
    }
    return out;
  }
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return "<unserializable>";
  }
}

export function sanitizeParams(params, limits) {
  const input = isPlainObject(params) ? params : {};
  const sanitized = sanitizeValue(input, limits, 0);
  return isPlainObject(sanitized) ? sanitized : {};
}

// ---------------------------------------------------------------------------
// Secret redaction — applied to audit payloads before they leave the host.
// Kept deliberately cheap: a handful of regexes run against strings only,
// no deep rebuild when nothing matches.
// ---------------------------------------------------------------------------

const SECRET_PATTERNS = [
  // Bearer / Authorization tokens in free text
  /\b(Bearer\s+)[A-Za-z0-9._\-+/=]{12,}/gi,
  // AWS access keys
  /\bAKIA[0-9A-Z]{16}\b/g,
  // Generic long hex / base64 tokens prefixed by common secret field names
  /\b((?:api[_-]?key|secret|token|password|passwd|pwd|authorization)\s*[:=]\s*)["']?[A-Za-z0-9._\-+/=]{12,}["']?/gi,
  // GitHub personal access tokens
  /\bghp_[A-Za-z0-9]{30,}\b/g,
  // JWT-ish three-part tokens
  /\beyJ[A-Za-z0-9_\-]{8,}\.[A-Za-z0-9_\-]{8,}\.[A-Za-z0-9_\-]{8,}\b/g,
  // Private key blocks
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g
];

function redactString(text) {
  let out = text;
  for (const pattern of SECRET_PATTERNS) {
    out = out.replace(pattern, (match, prefix) => `${prefix || ""}<redacted>`);
  }
  return out;
}

function redactValue(value, depth = 0) {
  if (depth > 8) return value;
  if (typeof value === "string") {
    return redactString(value);
  }
  if (Array.isArray(value)) {
    return value.map((entry) => redactValue(entry, depth + 1));
  }
  if (isPlainObject(value)) {
    const out = {};
    for (const [key, entry] of Object.entries(value)) {
      out[key] = redactValue(entry, depth + 1);
    }
    return out;
  }
  return value;
}

export function redactSecrets(value) {
  return redactValue(value, 0);
}

export function nowEpochSeconds() {
  return Math.floor(Date.now() / 1000);
}

export function readString(value) {
  return typeof value === "string" ? value.trim() || undefined : undefined;
}

export function parseStepIndex(value) {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string") {
    const parsed = Number.parseInt(value.trim(), 10);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return null;
}

export function sha256Hex(value) {
  return createHash("sha256").update(value).digest("hex");
}

// ---------------------------------------------------------------------------
// HTTP helpers (shared by intent.mjs and iap-service.mjs)
// ---------------------------------------------------------------------------

export async function postJson(url, payload, headers, timeoutMs) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
      signal: controller.signal
    });
    const text = await response.text();
    let data = null;
    if (text) {
      try {
        data = JSON.parse(text);
      } catch {
        data = null;
      }
    }
    return { ok: response.ok, status: response.status, text, data };
  } finally {
    clearTimeout(timeout);
  }
}

export function buildAuthHeaders(config) {
  const headers = { "Content-Type": "application/json" };
  if (config.apiKey) {
    headers.Authorization = `Bearer ${config.apiKey}`;
    headers["X-API-Key"] = config.apiKey;
    headers["x-api-key"] = config.apiKey;
  }
  return headers;
}
