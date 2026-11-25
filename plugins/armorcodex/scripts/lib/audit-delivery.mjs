import { createAuditWal } from "./audit-wal.mjs";
import { createIapService } from "./iap-service.mjs";
import { buildAuthHeaders, postJson } from "./common.mjs";
import { cachedPosture, classifyStatus, POSTURE_TIMEOUT_MS, recordBackendOutcome } from "./backend-posture.mjs";

export async function shipQueuedAudit(config) {
  const posture = await cachedPosture(config);
  const wal = createAuditWal({ dataDir: config.dataDir, config });
  const iapService = createIapService(config);
  if (config.apiKey) await wal.drain(async ({ rows }) => {
    const started = Date.now();
    try {
      const response = await iapService.shipAuditBatch(rows);
      await recordBackendOutcome(config, classifyStatus(response.status), started);
      return response;
    } catch (error) {
      await recordBackendOutcome(config, typeof error?.status === "number" ? classifyStatus(error.status) : "unreachable", started);
      throw error;
    }
  }, {
    allowDelivery: !posture || posture.state === "ok",
    probe: async () => {
      const started = Date.now();
      try {
        const response = await postJson(config.backendEndpoint + "/iap/validate-key", {}, buildAuthHeaders(config), POSTURE_TIMEOUT_MS);
        await recordBackendOutcome(config, classifyStatus(response.status), started);
        return response;
      } catch (error) {
        await recordBackendOutcome(config, "unreachable", started);
        throw error;
      }
    }
  });
  await wal.reportHealth(posture?.state === "unreachable" ? "backend_unreachable"
    : posture?.state === "signed_out" ? "auth_paused" : undefined);
  if (config.apiKey) await createAuditWal({ dataDir: config.dataDir, config, stream: "health" })
    .drain(({ rows }) => iapService.shipHealthBatch(rows));
}
