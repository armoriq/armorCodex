import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createAuditWal } from "../plugins/armorcodex/scripts/lib/audit-wal.mjs";
import { signIn } from "./helpers/login.mjs";

const SERVER = fileURLToPath(new URL("../plugins/armorcodex/scripts/policy-mcp.mjs", import.meta.url));
const SANDBOX = fileURLToPath(new URL("./helpers/mcp-sandbox.mjs", import.meta.url));
const CLOCK = fileURLToPath(new URL("./helpers/audit-clock.mjs", import.meta.url));
const deferred = () => {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
};

async function startServerWithQueuedRows(t, { hold = false, failFirst = false, rows }) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "armorcodex-flush-exit-"));
  const dataDir = path.join(home, "data");
  const received = [];
  const sends = [];
  const entered = deferred();
  const release = deferred();
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", async () => {
      if (req.url === "/iap/audit/batch") {
        const batch = JSON.parse(body).rows;
        sends.push(batch.map((row) => row.client_row_id));
        received.push(...batch.map((row) => row.tool));
        entered.resolve();
        if (hold) await release.promise;
        if (failFirst && sends.length === 1) {
          res.writeHead(500, { "content-type": "application/json" });
          res.end(JSON.stringify({ message: "stored, then failed" }));
          return;
        }
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ written: 1, failures: [] }));
    });
  });
  t.after(() => { release.resolve(); server.closeAllConnections(); server.close(); fs.rmSync(home, { recursive: true, force: true }); });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const backend = `http://127.0.0.1:${server.address().port}`;
  const apiKey = "ak_test_flushexit0000000000000000";
  signIn(home, { backend, apiKey });
  const wal = createAuditWal({ dataDir, config: { backendEndpoint: backend, apiKey } });
  for (const tool of rows) await wal.appendLine({ tool, action: tool, status: "success" });
  const child = spawn(process.execPath, ["--import", SANDBOX, "--import", CLOCK, SERVER], {
    env: {
      HOME: home, ARMORCODEX_TEST_HOME: home, TMPDIR: os.tmpdir(), PATH: process.env.PATH,
      ARMORCODEX_DATA_DIR: dataDir, BACKEND_ENDPOINT: backend, IAP_ENDPOINT: backend, PROXY_ENDPOINT: backend
    },
    stdio: ["pipe", "pipe", "pipe", "ipc"]
  });
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); });
  let stderr = "";
  child.stderr.on("data", (chunk) => (stderr += chunk));
  const exited = once(child, "exit");
  const ready = new Promise((resolve, reject) => {
    let output = "";
    child.stdout.on("data", (chunk) => {
      output += chunk;
      let end;
      while ((end = output.indexOf("\n")) !== -1) {
        const line = output.slice(0, end);
        output = output.slice(end + 1);
        if (!line) continue;
        const message = JSON.parse(line);
        if (message.id === 1) resolve(message);
      }
    });
    child.once("error", reject);
    child.once("exit", () => reject(new Error(stderr)));
  });
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {
    protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "audit-test", version: "1" }
  } }) + "\n");
  await ready;
  return {
    child, received, sends, entered: entered.promise, release: release.resolve, wal, dataDir, exited,
    stderr: () => stderr,
    async advance(ms) {
      const advanced = once(child, "message");
      child.send({ type: "advance", ms });
      await advanced;
    }
  };
}

test("closing the server's stdin ships the queued audit rows before it exits", async (t) => {
  const run = await startServerWithQueuedRows(t, { rows: ["Bash"] });
  run.child.stdin.end();
  assert.equal((await run.exited)[0], 0, run.stderr());
  assert.deepEqual(run.received, ["Bash"], run.stderr());
});

test("a shutdown during a periodic flush ships each queued row exactly once", async (t) => {
  const run = await startServerWithQueuedRows(t, { hold: true, rows: ["Bash", "Read"] });
  await run.advance(5000);
  await run.entered;
  run.child.kill("SIGTERM");
  run.release();
  assert.equal((await run.exited)[0], 0, run.stderr());
  assert.deepEqual([...run.received].sort(), ["Bash", "Read"], run.stderr());
});

test("a row resent after a failed upload carries the same client_row_id", async (t) => {
  const run = await startServerWithQueuedRows(t, { failFirst: true, rows: ["Bash", "Read"] });
  await run.advance(5000);
  await run.entered;
  await run.advance(31_000);
  run.child.stdin.end();
  assert.equal((await run.exited)[0], 0, run.stderr());
  assert.ok(run.sends.length >= 2, run.stderr());
  const [first, second] = run.sends;
  assert.equal(first.length, 2);
  for (const id of first) assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.notEqual(first[0], first[1]);
  assert.deepEqual(second, first);
});

test("the queue gives each row one client_row_id that stays the same across reads", async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "armorcodex-row-id-"));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const wal = createAuditWal({ dataDir, login: { backend: "https://audit.invalid", keyId: "id-test" } });
  await wal.appendLine({ tool: "Bash", action: "Bash", status: "success" });
  await wal.appendLine({ tool: "Read", action: "Read", status: "success", client_row_id: "caller-set" });
  const ids = async () => (await wal.readPending()).map(({ row }) => row.client_row_id);
  const first = await ids();
  assert.equal(first.length, 2);
  assert.notEqual(first[1], "caller-set");
  assert.deepEqual(await ids(), first);
});
