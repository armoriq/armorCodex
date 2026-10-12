import armoriqSdk from "@armoriq/sdk-dev";
import { rolloutMeta } from "./rollout-session.mjs";

const { codexTurnLatencies, turnLatencyPayloads } = armoriqSdk;

function firstOwnTurnMs(transcript, cutoff) {
  const meta = rolloutMeta(transcript);
  const forkedAt = meta?.forked_from_id ? Date.parse(meta.timestamp) : NaN;
  return Number.isNaN(forkedAt) ? cutoff : Math.max(cutoff, forkedAt);
}

export function sessionLatencyPayloads({ transcript, sessionId, cutoff, product, deviceId, deviceName }) {
  const from = firstOwnTurnMs(transcript, cutoff);
  const samples = codexTurnLatencies(transcript).filter((sample) => sample.startedAtMs >= from);
  return turnLatencyPayloads({ product, sessionId, deviceId, deviceName }, samples);
}
