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

function startAuditBackend(delayMs) {
  const received = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", async () => {
      if (req.url === "/iap/audit/batch") {
        await new Promise((resolve) => setTimeout(resolve, delayMs));
        received.push(...JSON.parse(body).rows.map((row) => row.tool));
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ written: 1, failures: [] }));
    });
  });
  return new Promise((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve({ server, received, url: `http://127.0.0.1:${server.address().port}` }))
  );
}

async function startServerWithQueuedRows(t, { delayMs = 0, rows }) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "armorcodex-flush-exit-"));
  const dataDir = path.join(home, "data");
  const backend = await startAuditBackend(delayMs);
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
