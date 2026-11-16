import { appendFile, open, readFile, rename, stat, unlink } from "node:fs/promises";
import { existsSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { PRIVATE_FILE_MODE, ensurePrivateDir, tightenDirFilesOnce, writePrivateFile } from "./fs-store.mjs";

const MAX_LINE_BYTES = 4000; // stay under PIPE_BUF (~4 KB) for atomic appends
const DEFAULT_ROTATE_BYTES = 10 * 1024 * 1024;
const DEFAULT_ROTATE_AGE_MS = 60 * 60 * 1000;

const ROW_BUDGET_BYTES =
  MAX_LINE_BYTES -
  Buffer.byteLength(
    JSON.stringify({ _seq: Number.MAX_SAFE_INTEGER, _enqueuedAt: Number.MAX_SAFE_INTEGER, client_row_id: randomUUID() })
  );

const rowBytes = (row) => Buffer.byteLength(JSON.stringify(row), "utf8");
const fieldBytes = (row, field) => Buffer.byteLength(JSON.stringify(row[field] ?? null), "utf8");

function truncateField(row, field) {
  const json = JSON.stringify(row[field]);
  const originalBytes = Buffer.byteLength(json, "utf8");
  let keep = json.length;
  for (;;) {
    const next = { ...row, [field]: { truncated: true, originalBytes, preview: json.slice(0, keep) } };
    const excess = rowBytes(next) - ROW_BUDGET_BYTES;
    if (excess <= 0 || keep === 0) return next;
    keep = Math.max(0, keep - excess);
  }
}

export function fitAuditRow(row) {
  const largestFirst = ["input", "output"].sort((a, b) => fieldBytes(row, b) - fieldBytes(row, a));
  let fitted = row;
  for (const field of largestFirst) {
    if (rowBytes(fitted) <= ROW_BUDGET_BYTES) return fitted;
    const shrunk = truncateField(fitted, field);
    if (rowBytes(shrunk) < rowBytes(fitted)) fitted = shrunk;
  }
  const bytes = rowBytes(fitted);
  if (bytes > ROW_BUDGET_BYTES) {
    throw new Error(`${row.tool} row is ${bytes} bytes after truncation, cap is ${MAX_LINE_BYTES}`);
  }
  return fitted;
}

export function createAuditWal(opts) {
  const dir = path.join(opts.dataDir, "audit");
  const currentPath = path.join(dir, "current.jsonl");
  const offsetPath = path.join(dir, "shipped.offset");
  const archiveDir = path.join(dir, "archive");
  const rotateBytes = opts.rotateBytes ?? DEFAULT_ROTATE_BYTES;
  const rotateAgeMs = opts.rotateAgeMs ?? DEFAULT_ROTATE_AGE_MS;

  let ensured = false;
  async function ensureDirs() {
    if (ensured) return;
    await ensurePrivateDir(dir);
    await ensurePrivateDir(archiveDir);
    await tightenDirFilesOnce(dir);
    await tightenDirFilesOnce(archiveDir);
    ensured = true;
  }

  let seqCounter = 0;

  async function appendLine(row) {
    // Stamp _seq before any await: after an await, concurrent callers resume in nondeterministic order.
    const enriched = {
      ...row,
      client_row_id: randomUUID(),
      _seq: ++seqCounter,
      _enqueuedAt: Date.now(),
    };
    await ensureDirs();
    const json = JSON.stringify(enriched);
    if (Buffer.byteLength(json, "utf8") > MAX_LINE_BYTES) {
      throw new Error(
        `audit row too large (${json.length} bytes); cap is ${MAX_LINE_BYTES}`,
      );
    }
    await appendFile(currentPath, json + "\n", { encoding: "utf8", mode: PRIVATE_FILE_MODE });
  }

  async function readShippedOffset() {
    try {
      const raw = await readFile(offsetPath, "utf8");
      const n = parseInt(raw.trim(), 10);
      return Number.isFinite(n) && n >= 0 ? n : 0;
    } catch (err) {
      if (err && err.code === "ENOENT") return 0;
      throw err;
    }
  }

  async function writeShippedOffset(offset) {
    await ensureDirs();
    await writePrivateFile(offsetPath, String(offset));
  }

  async function readBatch(maxRows = 100) {
    await ensureDirs();
    if (!existsSync(currentPath)) return { rows: [], endOffset: 0 };

    const offset = await readShippedOffset();
    const fh = await open(currentPath, "r");
    try {
      const st = await fh.stat();
      if (offset >= st.size) return { rows: [], endOffset: offset };
      const length = st.size - offset;
      const buf = Buffer.alloc(length);
      await fh.read(buf, 0, length, offset);

      const rows = [];
      let pos = 0;
      let lineEnd;
      while (rows.length < maxRows && (lineEnd = buf.indexOf(0x0a, pos)) !== -1) {
        const line = buf.slice(pos, lineEnd).toString("utf8");
        if (line.length > 0) {
          try {
            rows.push(JSON.parse(line));
          } catch (err) {
            process.stderr.write(
              `[audit-wal] skipping malformed line at offset ${offset + pos}: ${err?.message ?? err}\n`,
            );
          }
        }
        pos = lineEnd + 1;
      }
      rows.sort(compareForOrder);
      const stripped = rows.map((r) => {
        const { _seq, _enqueuedAt, ...rest } = r;
        return rest;
      });
      return { rows: stripped, endOffset: offset + pos };
    } finally {
      await fh.close();
    }
  }

  function compareForOrder(a, b) {
    const aSeq = typeof a?._seq === "number" ? a._seq : null;
    const bSeq = typeof b?._seq === "number" ? b._seq : null;
    if (aSeq !== null && bSeq !== null) return aSeq - bSeq;
    const aTs = typeof a?._enqueuedAt === "number" ? a._enqueuedAt : 0;
    const bTs = typeof b?._enqueuedAt === "number" ? b._enqueuedAt : 0;
    if (aTs !== bTs) return aTs - bTs;
    const aEx = typeof a?.executed_at === "string" ? a.executed_at : "";
    const bEx = typeof b?.executed_at === "string" ? b.executed_at : "";
    if (aEx < bEx) return -1;
    if (aEx > bEx) return 1;
    return 0;
  }

  async function advanceOffset(newOffset) {
    if (typeof newOffset !== "number" || newOffset < 0) {
      throw new Error(`invalid offset: ${newOffset}`);
    }
    await writeShippedOffset(newOffset);
    await rotateIfNeeded();
  }

  async function rotateIfNeeded() {
    if (!existsSync(currentPath)) return;
    const st = await stat(currentPath);
    const offset = await readShippedOffset();
    const fullyShipped = offset >= st.size;
    const tooBig = st.size >= rotateBytes;
    const tooOld = Date.now() - st.mtimeMs >= rotateAgeMs;
    if (!fullyShipped) return;
    if (!tooBig && !tooOld) return;

    await ensureDirs();
    const ts = new Date().toISOString().slice(0, 10);
    let seq = 1;
    let archivePath;
    do {
      archivePath = path.join(archiveDir, `${ts}-${String(seq).padStart(3, "0")}.jsonl`);
      seq += 1;
    } while (existsSync(archivePath));
    await rename(currentPath, archivePath);
    await writeShippedOffset(0);
  }

  async function pruneArchive(keep = 5) {
    if (!existsSync(archiveDir)) return [];
    const entries = readdirSync(archiveDir)
      .filter((f) => f.endsWith(".jsonl"))
      .map((f) => ({ name: f, mtime: statSync(path.join(archiveDir, f)).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime);
    const toDelete = entries.slice(keep);
    const deleted = [];
    for (const entry of toDelete) {
      try {
        await unlink(path.join(archiveDir, entry.name));
        deleted.push(entry.name);
      } catch (err) {
        process.stderr.write(`[audit-wal] failed to delete ${entry.name}: ${err?.message ?? err}\n`);
      }
    }
    return deleted;
  }

  async function pendingBytes() {
    if (!existsSync(currentPath)) return 0;
    const st = await stat(currentPath);
    const offset = await readShippedOffset();
    return Math.max(0, st.size - offset);
  }

  return {
    appendLine,
    readBatch,
    advanceOffset,
    rotateIfNeeded,
    pruneArchive,
    pendingBytes,
    readShippedOffset,
    _paths: { currentPath, offsetPath, archiveDir },
  };
}
