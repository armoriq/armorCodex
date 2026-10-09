import path from "node:path";
import { readJson, writeJson } from "./fs-store.mjs";

const canonical = (at) =>
  typeof at === "string" && !Number.isNaN(Date.parse(at)) && new Date(at).toISOString() === at;
const sameEvent = (a, b) => a.sequence === b.sequence && a.at === b.at && a.userId === b.userId;

export function validHistory(history) {
  if (typeof history?.id !== "string" || !history.id) return false;
  if (!["fresh", "unknown"].includes(history.origin)) return false;
  const events = history.events;
  if (!Array.isArray(events) || events.length === 0) return false;
  return events.every(
    (e, i) =>
      e?.sequence === i + 1 &&
      canonical(e.at) &&
      (e.userId === null || (typeof e.userId === "string" && e.userId !== ""))
  );
}

/**
 * The anchors after seeing `history` at `now` (ISO). A history that doesn't
 * extend the current anchor's id and events is a gap: the old anchor is kept
 * as proof of its intervals up to when it was seen, and the new history counts
 * as origin unknown.
 */
export function observeHistory(anchors, history, now) {
  const current = anchors?.current;
  const archived = anchors?.archived ?? [];
  const seen = { id: history.id, origin: history.origin, events: history.events, observedAt: now };
  if (!current) return { anchors: { current: seen, archived }, gap: false };
  const extended =
    current.id === history.id &&
    current.events.every((e, i) => history.events[i] && sameEvent(e, history.events[i]));
  if (extended)
    return { anchors: { current: { ...seen, origin: current.origin }, archived }, gap: false };
  return {
    anchors: { current: { ...seen, origin: "unknown" }, archived: [...archived, current] },
    gap: true,
  };
}

const AMBIGUOUS = Symbol("ambiguous");
const time = (e) => Date.parse(e.at);

/** Clock ranges a rolled-back login shares with the logins before it. */
function overlaps(events) {
  const ranges = [];
  let latest = -Infinity;
  for (const e of events) {
    if (time(e) < latest) ranges.push([time(e), latest]);
    latest = Math.max(latest, time(e));
  }
  return ranges;
}

function ownerWithin(events, t, until, ambiguous) {
  if (t > until) return undefined;
  if (ambiguous.some(([from, to]) => t >= from && t <= to)) return AMBIGUOUS;
  return events.findLast((e) => time(e) <= t)?.userId;
}

const firstUserIfFresh = (anchor, t) =>
  anchor.origin === "fresh" && t < Date.parse(anchor.events[0].at) ? anchor.events[0].userId : null;

/**
 * The user who owned instant `t` (epoch ms), null when it was logged out or is
 * unknown, or AMBIGUOUS inside a clock rollback's overlap. Up to the last time
 * an archived history was seen, that history decides; after it, only logins
 * newer than that proof count.
 */
export function ownerAt({ current, archived }, t) {
  const provenUntil = Math.max(-Infinity, ...archived.map((a) => Date.parse(a.observedAt)));
  if (t <= provenUntil) {
    for (const anchor of [...archived].reverse()) {
      const owner = ownerWithin(anchor.events, t, Date.parse(anchor.observedAt), overlaps(anchor.events));
      if (owner !== undefined) return owner;
    }
    return firstUserIfFresh(archived[0], t);
  }
  const trusted = current.events.filter((e) => time(e) > provenUntil);
  const owner = ownerWithin(trusted, t, Infinity, overlaps(current.events));
  if (owner !== undefined) return owner;
  return archived.length ? null : firstUserIfFresh(current, t);
}

export const ownedBy = (anchors, userId) => (t) => ownerAt(anchors, t) === userId;

/** A dashboard history request also claims time no recorded login owns. */
export const ownedOrUnassigned = (anchors, userId) => (t) => {
  const owner = ownerAt(anchors, t);
  return owner === userId || owner === null;
};

/**
 * Which messages `userId` owns, from the accepted profile's login history and
 * the anchors this data dir has recorded; with a pending dashboard history
 * request, also the unassigned ones. Null when the profile has no usable
 * history for this user.
 */
export async function loginOwnership({ config, userId, request, log }) {
  const history = config.loginHistory;
  const last = history?.events?.at(-1);
  const accepted =
    validHistory(history) &&
    last.userId === config.userId &&
    last.at === config.loggedInAt &&
    config.userId === userId;
  if (!accepted) {
    log("the login history doesn't match this key's owner, nothing synced");
    return null;
  }
  const anchorsPath = path.join(config.dataDir, "usage-sync-login.json");
  const stored = await readJson(anchorsPath, null);
  const { anchors, gap } = observeHistory(stored, history, new Date().toISOString());
  if (gap)
    log("the login history doesn't extend the one seen before, earlier usage stays unassigned");
  await writeJson(anchorsPath, anchors);
  return request ? ownedOrUnassigned(anchors, userId) : ownedBy(anchors, userId);
}
