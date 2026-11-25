import { createAuditWal } from "../../plugins/armorcodex/scripts/lib/audit-wal.mjs";

const [dataDir, operation, now = "1000"] = process.argv.slice(2);
const wal = createAuditWal({
  dataDir,
  login: { backend: "https://a.invalid", keyId: "key-a" },
  clock: { now: () => Number(now), random: () => 0.5 }
});
if (operation === "append") {
  await wal.appendLine({ tool: "Bash", input: { command: "pwd" } });
} else {
  await wal.drain(async ({ rows }) => {
    process.send({ type: "sending", count: rows.length });
    await new Promise((resolve) => process.once("message", resolve));
    return { status: 200, body: { results: rows.map(({ client_row_id }) => ({ client_row_id, outcome: "accepted" })) } };
  });
}
process.disconnect();
