import test from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readdir, readFile, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { appendNdjsonLine, writeJson, writePrivateFile } from "../plugins/armorcodex/scripts/lib/fs-store.mjs";
import { createAuditWal } from "../plugins/armorcodex/scripts/lib/audit-wal.mjs";
import { handleUserPromptSubmit } from "../plugins/armorcodex/scripts/lib/engine.mjs";

process.umask(0o022);

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

test("writeJson creates a missing data dir 0700 and closes an existing 0755 one", async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "armorcodex-mode-"));
  const fresh = path.join(tmp, "fresh", "armorcodex");
  await writeJson(path.join(fresh, "runtime.json"), {});
  assert.equal(await modeOf(fresh), 0o700);

  const dataDir = await openDataDir();
  await writeJson(path.join(dataDir, "runtime.json"), {});
  assert.equal(await modeOf(dataDir), 0o700);
});

test("the audit WAL holding tool inputs is owner-only", async () => {
  const dataDir = await openDataDir();
  const wal = createAuditWal({ dataDir });
  await wal.appendLine({ tool: "Bash", input: { command: "curl -H 'Authorization: Bearer abc123'" } });
  const { currentPath, offsetPath, archiveDir } = wal._paths;
  assert.match(await readFile(currentPath, "utf8"), /Bearer abc123/);
  assert.equal(await modeOf(currentPath), 0o600);
  assert.equal(await modeOf(path.dirname(currentPath)), 0o700);
  assert.equal(await modeOf(archiveDir), 0o700);

  const { endOffset } = await wal.readBatch();
  await wal.advanceOffset(endOffset);
  assert.equal(await modeOf(offsetPath), 0o600);
});

test("the audit WAL closes an existing 0644 log in a 0755 dir", async () => {
  const dataDir = await openDataDir();
  const auditDir = path.join(dataDir, "audit");
  await mkdir(path.join(auditDir, "archive"), { recursive: true, mode: 0o755 });
  await chmod(auditDir, 0o755);
  await chmod(path.join(auditDir, "archive"), 0o755);
  const currentPath = path.join(auditDir, "current.jsonl");
  await writeFile(currentPath, `${JSON.stringify({ tool: "Bash" })}\n`);
  await chmod(currentPath, 0o644);

  const wal = createAuditWal({ dataDir });
  await wal.appendLine({ tool: "Read" });
  assert.equal(await modeOf(currentPath), 0o600);
  assert.equal(await modeOf(auditDir), 0o700);
  assert.equal(await modeOf(path.join(auditDir, "archive")), 0o700);
  assert.equal((await readFile(currentPath, "utf8")).trim().split("\n").length, 2);
});

test("appendNdjsonLine creates an owner-only turn log in an owner-only dir", async () => {
  const dataDir = await openDataDir();
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
  await createAuditWal({ dataDir }).appendLine({ tool: "Read" });
  assert.equal(await modeOf(readOnly), 0o400);
  assert.equal(await modeOf(shared), 0o600);

  const target = path.join(dataDir, "state.json");
  await Promise.all(Array.from({ length: 20 }, (_, i) => writePrivateFile(target, String(i))));
  assert.match(await readFile(target, "utf8"), /^\d+$/);
  assert.deepEqual((await readdir(dataDir)).filter((f) => f.includes(".tmp.")), []);
});
