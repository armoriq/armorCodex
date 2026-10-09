import { buildAuthHeaders, postJson } from "./common.mjs";

const endpoint = (config, route) => `${config.backendEndpoint.replace(/\/+$/, "")}${route}`;

async function pendingHistorySync(config, deviceId) {
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
    return { ok: true, requestedAt: typeof data?.requestedAt === "string" ? data.requestedAt : null };
  } catch (err) {
    return { ok: false, reason: String(err?.message || err) };
  } finally {
    clearTimeout(timeout);
  }
}

async function completeHistorySync(config, deviceId, requestedAt) {
  try {
    const url = endpoint(config, "/api-keys/device-history-sync/done");
    const res = await postJson(url, { deviceId, requestedAt }, buildAuthHeaders(config), config.timeoutMs || 8000);
    return res.ok ? { ok: true } : { ok: false, reason: `device-history-sync/done returned ${res.status}` };
  } catch (err) {
    return { ok: false, reason: String(err?.message || err) };
  }
}

/** The dashboard's pending request to upload this device's earlier history, or null. */
export async function historyRequest(config, deviceId, log) {
  const res = await pendingHistorySync(config, deviceId);
  if (res.ok) return res.requestedAt;
  log(`could not read the dashboard's history request (${res.reason}), syncing as usual`);
  return null;
}

/** Clears this user's progress once per request, so every earlier session-hour posts again. */
export function startHistory(state, requestedAt) {
  if (!requestedAt || state.history?.requestedAt === requestedAt) return false;
  state.files = {};
  state.sessions = {};
  state.history = { requestedAt };
  return true;
}

export async function confirmHistory({ config, deviceId, state, report, requestedAt, log }) {
  if (!requestedAt || state.history?.requestedAt !== requestedAt || state.history.confirmed) return;
  if (report.left || report.failed) return;
  const res = await completeHistorySync(config, deviceId, requestedAt);
  if (res.ok) state.history.confirmed = true;
  log(
    res.ok
      ? "uploaded this device's earlier history as the dashboard asked"
      : `could not confirm the dashboard's history request (${res.reason}), retrying next run`
  );
}
