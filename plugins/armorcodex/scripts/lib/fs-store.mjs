import { randomUUID } from "node:crypto";
import { chmodSync, closeSync, fchmodSync, mkdirSync, openSync, statSync, writeSync } from "node:fs";
import { appendFile, chmod, mkdir, readdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

export async function readJson(filePath, fallbackValue) {
  try {
    const raw = await readFile(filePath, "utf8");
    return JSON.parse(raw);
  } catch (error) {
    if (error && typeof error === "object" && error.code === "ENOENT") {
      return fallbackValue;
    }
    // Corrupted JSON (e.g. interrupted write from an older non-atomic build)
    // falls back to the default rather than breaking the whole session.
    if (error instanceof SyntaxError) {
      return fallbackValue;
    }
    throw error;
  }
}

export const PRIVATE_FILE_MODE = 0o600;
const PRIVATE_DIR_MODE = 0o700;

const isOwnedAndShared = (st) => (st.mode & 0o077) !== 0 && st.uid === process.getuid?.();

export async function ensurePrivateDir(dir) {
  await mkdir(dir, { recursive: true, mode: PRIVATE_DIR_MODE });
  if (isOwnedAndShared(await stat(dir))) await chmod(dir, PRIVATE_DIR_MODE);
}

export function ensurePrivateDirSync(dir) {
  mkdirSync(dir, { recursive: true, mode: PRIVATE_DIR_MODE });
  if (isOwnedAndShared(statSync(dir))) chmodSync(dir, PRIVATE_DIR_MODE);
}

export function openPrivateSync(filePath, flags) {
  ensurePrivateDirSync(path.dirname(filePath));
  const fd = openSync(filePath, flags, PRIVATE_FILE_MODE);
  try {
    fchmodSync(fd, PRIVATE_FILE_MODE);
  } catch (error) {
    closeSync(fd);
    throw error;
  }
  return fd;
}

export function writePrivateFileSync(filePath, text) {
  const fd = openPrivateSync(filePath, "w");
  try {
    writeSync(fd, text);
  } finally {
    closeSync(fd);
  }
}

const tightenedDirs = new Set();

export async function tightenDirFilesOnce(dir) {
  if (tightenedDirs.has(dir)) return;
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name);
    if (entry.isFile() && isOwnedAndShared(await stat(file))) await chmod(file, PRIVATE_FILE_MODE);
  }
  tightenedDirs.add(dir);
}

// Atomic write: write to a sibling tmp file then rename into place. Prevents
// partial/torn JSON when two hooks (PreToolUse + PostToolUse) race or when the
// process is killed mid-write.
export async function writePrivateFile(filePath, text) {
  await mkdir(path.dirname(filePath), { recursive: true, mode: PRIVATE_DIR_MODE });
  const tmpPath = `${filePath}.tmp.${process.pid}.${randomUUID()}`;
  try {
    await writeFile(tmpPath, text, { encoding: "utf8", mode: PRIVATE_FILE_MODE, flag: "wx" });
    await rename(tmpPath, filePath);
  } catch (error) {
    await unlink(tmpPath).catch(() => {});
    throw error;
  }
}

export async function writeJson(filePath, value) {
  await writePrivateFile(filePath, JSON.stringify(value, null, 2));
}

// Largest single write POSIX guarantees is written atomically (no
// interleaving with a concurrent writer's bytes) to a file opened O_APPEND.
// Linux/macOS both guarantee this up to PIPE_BUF (historically 4096 on
// Linux, 512 on some older systems) for pipes; for regular files opened
// O_APPEND, POSIX guarantees the write()+seek-to-end is atomic as a unit
// (no torn interleave between two writers) for any single write() syscall,
// but Node's fs.write may internally chunk very large buffers. We stay
// well under any plausible PIPE_BUF/syscall chunking limit so a single
// `appendLine` call is always one underlying write().
export const NDJSON_APPEND_SAFE_BYTES = 3800;

// Append one line (a single JSON value, newline-terminated) to `filePath` via
// a single O_APPEND write. Two concurrent processes appending to the same
// file each get their own fd via O_APPEND|O_CREAT — the kernel serializes the
// underlying write() calls and always advances the file's write offset
// atomically, so neither process's line is ever lost or torn, regardless of
// interleaving. This is what makes multi-process accumulation race-free
// without any lock: unlike read-modify-write, there is no read step to race.
export async function appendNdjsonLine(filePath, value) {
  const line = `${JSON.stringify(value)}\n`;
  const bytes = Buffer.byteLength(line, "utf8");
  if (bytes > NDJSON_APPEND_SAFE_BYTES) {
    // Caller is responsible for capping attribute sizes before calling this;
    // this is a last-resort guard so a pathological payload can never grow
    // past the size we can still guarantee atomic-append semantics for.
    throw new Error(
      `appendNdjsonLine: line of ${bytes} bytes exceeds atomic-append safe size (${NDJSON_APPEND_SAFE_BYTES})`
    );
  }
  await mkdir(path.dirname(filePath), { recursive: true, mode: PRIVATE_DIR_MODE });
  await appendFile(filePath, line, { encoding: "utf8", mode: PRIVATE_FILE_MODE });
}

// Read an NDJSON file as an array of parsed values. Tolerates a torn last
// line (process killed mid-append) by skipping any line that fails to parse
// — every other event, from processes that completed their append, ships
// normally. Missing file returns [].
export async function readNdjsonLines(filePath) {
  let raw;
  try {
    raw = await readFile(filePath, "utf8");
  } catch (error) {
    if (error && typeof error === "object" && error.code === "ENOENT") {
      return [];
    }
    throw error;
  }
  const out = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      out.push(JSON.parse(trimmed));
    } catch {
      // Torn/partial line (kill -9 mid-write) — drop just this one entry
      // rather than failing the whole trace.
      continue;
    }
  }
  return out;
}

// Rename `filePath` to `destPath` atomically. Used at Stop to "claim" the
// accumulation file before reading it, so any hook process that is still
// mid-append (or starts a late append after Stop began) writes to a FRESH
// file at the original path instead of resurrecting/corrupting the file
// Stop is about to delete. Returns false (not true) if the source didn't
// exist (nothing accumulated this turn — not an error).
export async function renameIfExists(filePath, destPath) {
  try {
    await rename(filePath, destPath);
    return true;
  } catch (error) {
    if (error && typeof error === "object" && error.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

