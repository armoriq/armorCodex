import { readFileSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { createHash } from "node:crypto";
import path from "node:path";

/**
 * This machine's identity for token-usage rows. Prefers the id the ArmorIQ CLI
 * persisted at login, so the plugin, the usage sync and the CLI all write
 * the same row key; falls back to a hostname hash when the CLI never ran.
 */
export function deviceIdentity(env = process.env) {
  const deviceName = hostname().trim().slice(0, 120);
  const idPath =
    env.ARMORIQ_DEVICE_ID_PATH?.trim() || path.join(homedir(), ".armoriq", "device-id");
  try {
    const persisted = readFileSync(idPath, "utf8").trim();
    if (persisted) return { deviceId: persisted.slice(0, 128), deviceName };
  } catch {
    // no CLI identity on this machine
  }
  return {
    deviceId: "dev_" + createHash("sha256").update(deviceName).digest("hex").slice(0, 16),
    deviceName,
  };
}
