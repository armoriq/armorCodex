import { mock } from "node:test";

mock.timers.enable({ apis: ["setInterval", "Date"], now: Date.now() });
process.on("message", (message) => {
  if (message.type !== "advance") return;
  mock.timers.tick(message.ms);
  process.send({ type: "advanced" });
});
