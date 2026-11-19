import { after, describe, it } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createAuditWal } from "../plugins/armorcodex/scripts/lib/audit-wal.mjs";
import { defineOutboxConformance } from "./helpers/outbox-conformance.mjs";

const stores = [];
after(async () => {
  await Promise.all(stores.map((dir) => rm(dir, { recursive: true, force: true })));
});

async function makeAdapter({ login, clock, sizeLimits, timing }) {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "armorcodex-outbox-"));
  stores.push(dataDir);
  const context = { login, fault: null };
  const reopen = () => {
    const wal = createAuditWal({
      dataDir, clock, sizeLimits, timing,
      login: () => context.login,
      beforeCommit(point) {
        if (context.fault !== point) return;
        context.fault = null;
        throw new Error(`injected ${point} storage failure`);
      }
    });
    return {
      append: (row, options) => options?.loggedOut ? Promise.resolve() : wal.appendLine(row, options),
      drain: (send, options) => wal.drain(send, options),
      readPending: () => wal.readPending(),
      readDeadLetters: () => wal.readDeadLetters(),
      status: () => wal.status(),
      async switchLogin(next) {
        context.login = next;
        await wal.authenticationSucceeded(next);
      },
      authenticationSucceeded: (login) => wal.authenticationSucceeded(login),
      async failNext(point) { context.fault = point; },
      async restart() { return reopen(); },
      async secondDrainer() { return reopen(); }
    };
  };
  return reopen();
}

defineOutboxConformance({ describe, it, makeAdapter });
