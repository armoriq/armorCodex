import { keyOwner } from "./key-owner.mjs";
import { loadConfig } from "./config.mjs";
import { deviceIdentity } from "./device.mjs";
import { getSdkClient } from "./intent.mjs";
import { liveDir, loginCutoff } from "./live-usage.mjs";

export async function prepareUsage(log) {
  const config = loadConfig(process.env);
  if (!config.usageSyncEnabled) return null;
  const cutoff = loginCutoff(config);
  if (cutoff === null) return log("the saved login has no usable login history, nothing sent");
  const owner = await keyOwner(config);
  if (!owner.ok || owner.userId !== config.userId)
    return log("the API key does not belong to the saved login's user, nothing sent");
  const { deviceId, deviceName } = deviceIdentity();
  const dir = liveDir(config.dataDir, {
    backend: config.backendEndpoint,
    product: config.productSlug,
    userId: config.userId,
    deviceId,
  });
  return { config, client: getSdkClient(config), dir, cutoff, deviceId, deviceName };
}
