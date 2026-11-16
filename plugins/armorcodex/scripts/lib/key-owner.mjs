import { buildAuthHeaders, postJson } from "./common.mjs";

function ownerFrom(res) {
  if (!res.ok) return { ok: false, reason: `validate-key returned ${res.status}` };
  const userId = res.data?.userId;
  if (typeof userId !== "string" || !userId) return { ok: false, reason: "validate-key returned no userId" };
  return { ok: true, userId };
}

export async function keyOwner(config) {
  if (!config.apiKey || !config.backendEndpoint) return { ok: false, reason: "no backend configured" };
  try {
    const url = `${config.backendEndpoint.replace(/\/+$/, "")}/iap/validate-key`;
    return ownerFrom(await postJson(url, {}, buildAuthHeaders(config), config.timeoutMs || 8000));
  } catch (err) {
    return { ok: false, reason: String(err?.message || err) };
  }
}
