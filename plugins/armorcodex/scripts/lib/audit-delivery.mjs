import { auditLogin, createAuditWal } from "./audit-wal.mjs";
import { publishRunReports } from "./runs.mjs";
import { createIapService } from "./iap-service.mjs";
import { buildAuthHeaders, postJson } from "./common.mjs";
import { cachedPosture, classifyStatus, POSTURE_TIMEOUT_MS, recordBackendOutcome } from "./backend-posture.mjs";

export async function shipQueuedAudit(config, currentConfig = () => config) {
  const attempt = async (name, task) => {
    try { return await task(); }
    catch { process.stderr.write(`[armorcodex] ${name} flush failed\n`); }
  };
  const posture = await attempt("posture", () => cachedPosture(config));
  const wal = createAuditWal({ dataDir: config.dataDir, config });
  const iapService = createIapService(config);
  const probe = async () => {
    const auth = currentConfig();
    if (auditLogin(auth)?.backend !== auditLogin(config)?.backend || auditLogin(auth)?.keyId !== auditLogin(config)?.keyId) return { status: 401 };
    const started = Date.now();
    try {
      const response = await postJson(auth.backendEndpoint + "/iap/validate-key", {}, buildAuthHeaders(auth), POSTURE_TIMEOUT_MS);
      await recordBackendOutcome(auth, classifyStatus(response.status), started);
      return response;
    } catch (error) {
      await recordBackendOutcome(auth, "unreachable", started);
      throw error;
    }
  };
  if (config.apiKey) await attempt("audit", () => wal.drain(async ({ rows }) => {
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
    probe
  }));
  await attempt("audit health", () => wal.reportHealth(posture?.state === "unreachable" ? "backend_unreachable"
    : posture?.state === "signed_out" ? "auth_paused" : undefined));
  if (config.runReportingEnabled) {
    if (config.runtimeFile) await attempt("run receipts", () => publishRunReports(config));
    const runs = createAuditWal({ dataDir: config.dataDir, config, stream: "runs", login: () => auditLogin(currentConfig()) });
    if (config.apiKey) await attempt("runs", () => runs.drain(({ rows, login }) => {
      const auth = currentConfig();
      const current = auditLogin(auth);
      if (!auth.runReportingEnabled || current?.backend !== login.backend || current?.keyId !== login.keyId) return { skipped: true };
      return createIapService(auth).shipRunBatch(rows);
    }, { probe, allowDelivery: !posture || posture.state === "ok" }));
    await attempt("runs health", () => runs.reportHealth(posture?.state === "unreachable" ? "backend_unreachable"
      : posture?.state === "signed_out" ? "auth_paused" : undefined));
  }
  if (config.apiKey) await attempt("health", () => createAuditWal({
    dataDir: config.dataDir, config, stream: "health",
    ...(!config.runReportingEnabled ? { canDeliverRow: (row) => row.queue !== "runs" } : {})
  })
    .drain(({ rows }) => iapService.shipHealthBatch(rows), { probe }));
}
