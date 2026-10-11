export function createAuditFlusher({ ship, onError, intervalMs }) {
  let inFlight = null;
  const run = () => Promise.resolve().then(ship).catch(onError);
  const tick = () => {
    inFlight ??= run().finally(() => {
      inFlight = null;
    });
  };
  const timer = setInterval(tick, intervalMs);
  timer.unref?.();
  return {
    async stop() {
      clearInterval(timer);
      await inFlight;
      await run();
    }
  };
}
