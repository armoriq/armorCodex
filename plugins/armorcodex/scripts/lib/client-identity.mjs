import { readFileSync } from "node:fs";
import armoriqSdk from "@armoriq/sdk-dev";

const { clientHeaders } = armoriqSdk;

export function clientIdentity(manifest) {
  const channel = manifest.dependencies?.["@armoriq/sdk-dev"] ? "-dev" : "";
  return { product: `armorcodex${channel}`, version: manifest.version };
}

export const CLIENT = clientIdentity(
  JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8"))
);

export const CLIENT_HEADERS = clientHeaders(CLIENT);
