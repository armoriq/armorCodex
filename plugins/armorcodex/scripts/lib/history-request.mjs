import { buildAuthHeaders } from "./common.mjs";

const endpoint = (config, route) => `${config.backendEndpoint.replace(/\/+$/, "")}${route}`;

export async function pendingHistorySync(config, deviceId) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.timeoutMs || 8000);
  try {
    const query = `?deviceId=${encodeURIComponent(deviceId)}`;
    const res = await fetch(endpoint(config, `/api-keys/device-history-sync${query}`), {
      headers: buildAuthHeaders(config),
      signal: controller.signal
    });
    const data = await res.json().catch(() => null);
    if (!res.ok) return { ok: false, reason: `device-history-sync returned ${res.status}` };
    return {
      ok: true,
      requestedAt: typeof data?.requestedAt === "string" ? data.requestedAt : null,
      requestId: typeof data?.requestId === "string" ? data.requestId : null
    };
  } catch (err) {
    return { ok: false, reason: String(err?.message || err) };
  } finally {
    clearTimeout(timeout);
  }
}
