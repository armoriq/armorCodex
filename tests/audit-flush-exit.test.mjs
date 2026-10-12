import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createAuditWal } from "../plugins/armorcodex/scripts/lib/audit-wal.mjs";
import { signIn } from "./helpers/login.mjs";

const SERVER = fileURLToPath(new URL("../plugins/armorcodex/scripts/policy-mcp.mjs", import.meta.url));
const SANDBOX = fileURLToPath(new URL("./helpers/mcp-sandbox.mjs", import.meta.url));

function startAuditBackend(delayMs, failFirst = 0) {
  const received = [];
  const sends = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", async () => {
      if (req.url === "/iap/audit/batch") {
        await new Promise((resolve) => setTimeout(resolve, delayMs));
        const rows = JSON.parse(body).rows;
        sends.push(rows.map((row) => row.client_row_id));
        received.push(...rows.map((row) => row.tool));
        if (sends.length <= failFirst) {
          res.writeHead(500, { "content-type": "application/json" });
          res.end(JSON.stringify({ message: "stored, then failed" }));
          return;
        }
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ written: 1, failures: [] }));
    });
  });
  return new Promise((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve({ server, received, sends, url: `http://127.0.0.1:${server.address().port}` }))
  );
}

async function startServerWithQueuedRows(t, { delayMs = 0, failFirst = 0, rows }) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "armorcodex-flush-exit-"));
  const dataDir = path.join(home, "data");
  const backend = await startAuditBackend(delayMs, failFirst);
  t.after(() => {
    backend.server.close();
    fs.rmSync(home, { recursive: true, force: true });
  });
  signIn(home, { backend: backend.url, apiKey: "ak_test_flushexit0000000000000000" });
  const wal = createAuditWal({ dataDir });
  for (const tool of rows) await wal.appendLine({ tool, action: tool, status: "success" });
  const child = spawn(process.execPath, ["--import", SANDBOX, SERVER], {
    env: {
      HOME: home,
      ARMORCODEX_TEST_HOME: home,
      TMPDIR: os.tmpdir(),
      PATH: process.env.PATH,
      ARMORCODEX_DATA_DIR: dataDir,
      BACKEND_ENDPOINT: backend.url,
      IAP_ENDPOINT: backend.url,
      PROXY_ENDPOINT: backend.url
    },
    stdio: ["pipe", "pipe", "pipe"]
  });
  let stderr = "";
  child.stderr.on("data", (chunk) => (stderr += chunk));
  const exited = new Promise((resolve) => child.on("exit", (code, signal) => resolve({ code, signal })));
  return { child, backend, exited, stderr: () => stderr };
}

test("closing the server's stdin ships the queued audit rows before it exits", async (t) => {
  const { child, backend, exited, stderr } = await startServerWithQueuedRows(t, { rows: ["Bash"] });
  await new Promise((resolve) => setTimeout(resolve, 500));
  child.stdin.end();
  const result = await Promise.race([exited, new Promise((resolve) => setTimeout(() => resolve("timeout"), 8000))]);
  assert.notEqual(result, "timeout", stderr());
  assert.deepEqual(backend.received, ["Bash"], stderr());
});

test("a shutdown during a periodic flush ships each queued row exactly once", async (t) => {
  const { child, backend, exited, stderr } = await startServerWithQueuedRows(t, { delayMs: 1500, rows: ["Bash", "Read"] });
  await new Promise((resolve) => setTimeout(resolve, 5600));
  child.kill("SIGTERM");
  await exited;
  assert.deepEqual([...backend.received].sort(), ["Bash", "Read"], stderr());
});

test("a row resent after a failed upload carries the same client_row_id", async (t) => {
  const { child, backend, exited, stderr } = await startServerWithQueuedRows(t, { failFirst: 1, rows: ["Bash", "Read"] });
  await new Promise((resolve) => setTimeout(resolve, 5600));
  child.stdin.end();
  await exited;
  assert.ok(backend.sends.length >= 2, stderr());
  const [first, second] = backend.sends;
  assert.equal(first.length, 2);
  for (const id of first) assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.notEqual(first[0], first[1]);
  assert.deepEqual(second, first);
});

test("the queue gives each row one client_row_id that stays the same across reads", async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "armorcodex-row-id-"));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const wal = createAuditWal({ dataDir });
  await wal.appendLine({ tool: "Bash", action: "Bash", status: "success" });
  await wal.appendLine({ tool: "Read", action: "Read", status: "success", client_row_id: "caller-set" });
  const ids = async () => (await wal.readBatch(10)).rows.map((row) => row.client_row_id);
  const first = await ids();
  assert.equal(first.length, 2);
  assert.notEqual(first[1], "caller-set");
  assert.deepEqual(await ids(), first);
});
