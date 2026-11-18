import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { endSession, registerSession } from "../plugins/armorcodex/scripts/lib/usage-sessions.mjs";

// Codex clamps a SessionEnd hook's timeout to 3s and warns on every session
// when a hooks file asks for more.
const CODEX_SESSION_END_CAP_S = 3;

test("every shipped hooks file asks Codex for a SessionEnd timeout it honours", () => {
  for (const file of ["../plugins/armorcodex/hooks/hooks.json", "../plugins/armorcodex/.codex/hooks.json"]) {
    const { hooks } = JSON.parse(readFileSync(new URL(file, import.meta.url), "utf8"));
    const timeouts = hooks.SessionEnd.flatMap((group) => group.hooks.map((hook) => hook.timeout));
    assert.ok(timeouts.length > 0, file);
    for (const timeout of timeouts) assert.ok(timeout <= CODEX_SESSION_END_CAP_S, `${file}: ${timeout}`);
  }
});

test("endSession gives up on a held sessions lock well inside the SessionEnd budget", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "armorcodex-session-end-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  await registerSession(dir, "s1", { pid: process.pid, startedAt: 1 });
  writeFileSync(join(dir, "sessions.lock"), String(process.pid));

  const started = Date.now();
  await assert.rejects(endSession(dir, "s1"), /held by another process/);
  const elapsed = Date.now() - started;

  assert.ok(elapsed >= 900, `gave up after ${elapsed}ms, before waiting at all`);
  assert.ok(elapsed < 2_000, `waited ${elapsed}ms, too close to the ${CODEX_SESSION_END_CAP_S}s cap`);
});

test("endSession removes the session when the lock is free", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "armorcodex-session-end-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  await registerSession(dir, "s1", { pid: process.pid, startedAt: 1 });
  await registerSession(dir, "s2", { pid: process.pid, startedAt: 1 });

  await endSession(dir, "s1");

  assert.deepEqual(Object.keys(JSON.parse(readFileSync(join(dir, "sessions.json"), "utf8"))), ["s2"]);
});
