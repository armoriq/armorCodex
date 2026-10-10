import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { signIn } from "./login.mjs";

const SCRIPTS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "plugins", "armorcodex", "scripts");
export const ROUTER = path.join(SCRIPTS, "hook-router.mjs");
export const WORKER = path.join(SCRIPTS, "usage-worker.mjs");
export const KEY = "ak_test_codex_live_0001";
export const USER = `user-of-${KEY}`;
export const GENERATION = randomUUID();
export const isoAgo = (ms) => new Date(Date.now() - ms).toISOString();

export function backend() {
  const batches = [];
  const singles = [];
  let release;
  const released = new Promise((resolve) => (release = resolve));
  const b = { batches, singles, release, generation: GENERATION, onBatch: null };
  Object.assign(b, { requestId: null, reports: [], runs: new Map(), acked: new Map() });
  const stale = (run) => run?.mode === "history" && run.requestId !== b.requestId;
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", async () => {
      const body = raw ? JSON.parse(raw) : {};
      const reply = (status, data) => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(data));
      };
      if (req.url === "/iap/validate-key") return reply(200, { userId: USER });
      if (req.url.startsWith("/api-keys/device-history-sync"))
        return reply(200, { requestId: b.requestId, requestedAt: b.requestId && isoAgo(0) });
      if (req.url === "/dashboard/token-usage/stream") return reply(200, { generation: b.generation });
      if (req.url.startsWith("/dashboard/token-usage/runs/")) {
        const runId = req.url.split("/").at(-1);
        b.reports.push({ runId, ...body });
        if (stale(body)) return reply(409, { message: "History request is no longer current" });
        if (body.phase === "complete" && !((b.acked.get(runId)?.size ?? 0) >= body.total))
          return reply(409, { message: "Run has unacknowledged session-hours" });
        b.runs.set(runId, body);
        const historyCompleted = body.mode === "history" && body.phase === "complete";
        if (historyCompleted) b.requestId = null;
        return reply(200, { applied: true, historyCompleted, run: { runId } });
      }
      if (req.url === "/dashboard/token-usage/batch") {
        if (body.generation !== b.generation) return reply(409, { message: "Usage stream generation changed" });
        if (body.runId && !b.runs.has(body.runId)) return reply(409, { message: "Unknown usage sync run" });
        if (stale(b.runs.get(body.runId))) return reply(409, { message: "History request is no longer current" });
        batches.push(body);
        if (b.onBatch?.(res, body)) return;
        if (body.runId) {
          const hours = b.acked.get(body.runId) ?? new Set();
          for (const s of body.snapshots) hours.add(`${s.sessionId}|${s.usageDate}|${s.usageHour}`);
          b.acked.set(body.runId, hours);
        }
        const results = body.snapshots.map(({ sessionId, usageDate, usageHour }) => ({
          sessionId,
          usageDate,
          usageHour,
          status: "applied",
        }));
        return reply(200, { results });
      }
      if (req.url === "/dashboard/token-usage") {
        singles.push(body);
        await released;
        return reply(201, { ok: true, recorded: 1 });
      }
      reply(404, {});
    });
  });
  return new Promise((resolve) =>
    server.listen(0, "127.0.0.1", () =>
      resolve(Object.assign(b, { server, url: `http://127.0.0.1:${server.address().port}` }))
    )
  );
}

export function home(url, loggedInAt) {
  const dir = mkdtempSync(path.join(tmpdir(), "acx-live-usage-"));
  mkdirSync(path.join(dir, ".codex", "sessions"), { recursive: true });
  return signIn(dir, { backend: url, apiKey: KEY, userId: USER, at: loggedInAt });
}

export const env = (h, url, extra = {}) => ({
  PATH: process.env.PATH,
  HOME: h,
  CODEX_HOME: path.join(h, ".codex"),
  ARMORCODEX_DATA_DIR: path.join(h, "data"),
  ARMORIQ_DEVICE_ID_PATH: path.join(h, "device-id"),
  ARMORIQ_ENV: "local",
  ARMORCODEX_USE_PRODUCTION: "false",
  ARMORCODEX_BACKEND_ENDPOINT: url,
  IAP_ENDPOINT: url,
  PROXY_ENDPOINT: url,
  ...(process.env.NODE_OPTIONS ? { NODE_OPTIONS: process.env.NODE_OPTIONS } : {}),
  ...extra,
});

export const meta = (timestamp, payload) => ({ timestamp, type: "session_meta", payload: { timestamp, ...payload } });
export const model = (timestamp, name) => ({ timestamp, type: "turn_context", payload: { model: name } });
export const count = (timestamp, input, output = 0, cached = 0, reasoning = 0) => ({
  timestamp,
  type: "event_msg",
  payload: {
    type: "token_count",
    info: {
      total_token_usage: {
        input_tokens: input,
        cached_input_tokens: cached,
        output_tokens: output,
        reasoning_output_tokens: reasoning,
      },
    },
  },
});

export function rolloutPath(h, iso, id) {
  const day = iso.slice(0, 10);
  return path.join(h, ".codex", "sessions", ...day.split("-"), `rollout-${day}T${iso.slice(11, 19).replaceAll(":", "-")}-${id}.jsonl`);
}

export function writeRollout(file, lines) {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
}

export function run(script, environment, stdin = "") {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script], { env: environment, stdio: ["pipe", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (c) => (stderr += c));
    child.on("error", reject);
    child.on("exit", (code) => resolve({ code, stderr }));
    child.stdin.end(stdin);
  });
}

export const stop = (h, url, sessionId, transcript, extra = {}) =>
  run(ROUTER, env(h, url, extra), JSON.stringify({ hook_event_name: "Stop", session_id: sessionId, transcript_path: transcript }));

export async function until(check, what, timeoutMs = 20_000) {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

export function liveFiles(h, sessionId) {
  const root = path.join(h, "data", "usage-live");
  const dir = path.join(root, readdirSync(root)[0]);
  const queue = path.join(dir, `${sessionId}.queue`);
  const list = (d) => (existsSync(d) ? readdirSync(d).filter((n) => n.endsWith(".json")) : []);
  return {
    dir,
    lock: path.join(dir, `${sessionId}.lock`),
    queued: () => list(queue),
    refused: () => list(path.join(queue, "refused")).map((n) => JSON.parse(readFileSync(path.join(queue, "refused", n), "utf8"))),
  };
}

export async function settled(h, sessionId) {
  const files = liveFiles(h, sessionId);
  await until(() => !existsSync(files.lock), "the upload to finish");
  return files;
}

export const total = (s) =>
  s.entries.reduce((n, e) => n + e.inputTokens + e.outputTokens + e.cacheReadTokens + e.cacheWriteTokens, 0);
export const sessionBatches = (b, sessionId) =>
  b.batches.flatMap((x) => x.snapshots).filter((s) => s.sessionId === sessionId);

export async function closeBackend(b) {
  b.release();
  b.server.closeAllConnections();
  await new Promise((r) => b.server.close(r));
}
