const canonical = (at) =>
  typeof at === "string" && !Number.isNaN(Date.parse(at)) && new Date(at).toISOString() === at;

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
