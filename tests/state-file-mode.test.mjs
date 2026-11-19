import test from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { appendNdjsonLine, tightenDirFilesOnce, writeJson, writePrivateFile } from "../plugins/armorcodex/scripts/lib/fs-store.mjs";
import { createAuditWal } from "../plugins/armorcodex/scripts/lib/audit-wal.mjs";
import { handleUserPromptSubmit } from "../plugins/armorcodex/scripts/lib/engine.mjs";

process.umask(0o022);

const HOOK_ROUTER = path.join(path.dirname(fileURLToPath(import.meta.url)), "../plugins/armorcodex/scripts/hook-router.mjs");

async function modeOf(file) {
  return (await stat(file)).mode & 0o777;
}

async function openDataDir() {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "armorcodex-mode-"));
  const dataDir = path.join(tmp, "armorcodex");
  await mkdir(dataDir, { mode: 0o755 });
  await chmod(dataDir, 0o755);
  return dataDir;
}

test("runtime.json holding the prompt is owner-only", async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "armorcodex-mode-"));
  const runtimeFile = path.join(tmp, "runtime.json");
  await handleUserPromptSubmit(
    { hook_event_name: "UserPromptSubmit", session_id: "s-mode", prompt: "deploy with token abc123" },
    {
      mode: "enforce",
      dataDir: tmp,
      policyFile: path.join(tmp, "policy.json"),
      runtimeFile,
      apiKey: "",
      planningEnabled: false,
      contextHintsEnabled: false,
      policyUpdateEnabled: true,
      policyUpdateAllowList: ["*"],
      debug: false
    }
  );
  const saved = JSON.parse(await readFile(runtimeFile, "utf8"));
  assert.equal(saved.sessions["s-mode"].lastPrompt, "deploy with token abc123");
  assert.equal(await modeOf(runtimeFile), 0o600);
});

test("writeJson replaces a world-readable file with an owner-only one", async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "armorcodex-mode-"));
  const file = path.join(tmp, "state.json");
  await writeFile(file, "{}");
  await chmod(file, 0o644);
  await writeJson(file, { secret: "x" });
  assert.equal(await modeOf(file), 0o600);
  assert.deepEqual(JSON.parse(await readFile(file, "utf8")), { secret: "x" });
});

test("writeJson creates a missing dir 0700 and leaves an existing one alone", async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "armorcodex-mode-"));
  const fresh = path.join(tmp, "fresh", "armorcodex");
  await writeJson(path.join(fresh, "runtime.json"), {});
  assert.equal(await modeOf(fresh), 0o700);

  const projectDir = await openDataDir();
  await writeJson(path.join(projectDir, "runtime.json"), {});
  assert.equal(await modeOf(projectDir), 0o755);
});

test("the hook router makes an existing data dir 0700", async () => {
  const dataDir = await openDataDir();
  const child = spawn(process.execPath, [HOOK_ROUTER], {
    stdio: ["pipe", "ignore", "ignore"],
    env: { PATH: process.env.PATH, HOME: dataDir, ARMORCODEX_DATA_DIR: dataDir, ARMORIQ_API_KEY: "", DO_NOT_TRACK: "1" }
  });
  child.stdin.end("");
  await new Promise((resolve) => child.once("exit", resolve));
  assert.equal(await modeOf(dataDir), 0o700);
});

test("the audit WAL holding tool inputs is owner-only", async () => {
  const dataDir = await openDataDir();
  const wal = createAuditWal({ dataDir, login: { backend: "https://audit.invalid", keyId: "mode-test" } });
  await wal.appendLine({ tool: "Bash", input: { command: "curl -H 'Authorization: Bearer abc123'" } });
  const store = path.join(dataDir, "audit", "outbox-v1");
  const segment = (await readdir(store)).find((name) => name.startsWith("queue."));
  const currentPath = path.join(store, segment, "rows.jsonl");
  const archiveDir = path.join(store, "archive");
  assert.match(await readFile(currentPath, "utf8"), /Bearer abc123/);
  assert.equal(await modeOf(currentPath), 0o600);
  assert.equal(await modeOf(path.dirname(currentPath)), 0o700);
  assert.equal(await modeOf(archiveDir), 0o700);

  await wal.drain(async ({ rows }) => ({ status: 200, body: { results: rows.map(({ client_row_id }) => ({ client_row_id, outcome: "accepted" })) } }));
  assert.equal(await modeOf(path.join(archiveDir, segment, "state.json")), 0o600);
});

// regression: #0010
test("the audit WAL leaves released files and their modes untouched", async () => {
  const dataDir = await openDataDir();
  const auditDir = path.join(dataDir, "audit");
  await mkdir(path.join(auditDir, "archive"), { recursive: true, mode: 0o755 });
  await chmod(auditDir, 0o755);
  await chmod(path.join(auditDir, "archive"), 0o755);
  const currentPath = path.join(auditDir, "current.jsonl");
  await writeFile(currentPath, `${JSON.stringify({ tool: "Bash" })}\n`);
  await chmod(currentPath, 0o644);

  const wal = createAuditWal({ dataDir, login: { backend: "https://audit.invalid", keyId: "mode-test" } });
  await wal.appendLine({ tool: "Read" });
  assert.equal(await modeOf(currentPath), 0o644);
  assert.equal(await modeOf(auditDir), 0o700);
  assert.equal(await modeOf(path.join(auditDir, "archive")), 0o755);
  assert.equal((await readFile(currentPath, "utf8")).trim().split("\n").length, 1);
  assert.equal((await wal.readPending()).length, 2);
  assert.equal((await wal.status()).undeliverable, 1);
});

test("appendNdjsonLine creates an owner-only turn log in an owner-only dir", async () => {
  const dataDir = path.join(await openDataDir(), "turns");
  const file = path.join(dataDir, "obs-turn.x.ndjson");
  await appendNdjsonLine(file, { prompt: "deploy with token abc123" });
  await appendNdjsonLine(file, { prompt: "second" });
  assert.equal((await readFile(file, "utf8")).trim().split("\n").length, 2);
  assert.equal(await modeOf(file), 0o600);
  assert.equal(await modeOf(dataDir), 0o700);
});

test("tightening keeps owner-only bits and concurrent writes never share a temp file", async () => {
  const dataDir = await openDataDir();
  const archiveDir = path.join(dataDir, "audit", "archive");
  await mkdir(archiveDir, { recursive: true });
  const readOnly = path.join(archiveDir, "old.jsonl");
  await writeFile(readOnly, "{}\n", { mode: 0o400 });
  await chmod(readOnly, 0o400);
  const shared = path.join(archiveDir, "older.jsonl");
  await writeFile(shared, "{}\n");
  await chmod(shared, 0o644);
  await tightenDirFilesOnce(archiveDir);
  assert.equal(await modeOf(readOnly), 0o400);
  assert.equal(await modeOf(shared), 0o600);

  const target = path.join(dataDir, "state.json");
  await Promise.all(Array.from({ length: 20 }, (_, i) => writePrivateFile(target, String(i))));
  assert.match(await readFile(target, "utf8"), /^\d+$/);
  assert.deepEqual((await readdir(dataDir)).filter((f) => f.includes(".tmp.")), []);
});
