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

// Stay under PIPE_BUF so each append is one write() that cannot interleave with another writer.
export const NDJSON_APPEND_SAFE_BYTES = 3800;

export async function appendNdjsonLine(filePath, value) {
  const line = `${JSON.stringify(value)}\n`;
  const bytes = Buffer.byteLength(line, "utf8");
  if (bytes > NDJSON_APPEND_SAFE_BYTES) {
    throw new Error(
      `appendNdjsonLine: line of ${bytes} bytes exceeds atomic-append safe size (${NDJSON_APPEND_SAFE_BYTES})`
    );
  }
  await mkdir(path.dirname(filePath), { recursive: true, mode: PRIVATE_DIR_MODE });
  await appendFile(filePath, line, { encoding: "utf8", mode: PRIVATE_FILE_MODE });
}

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
      continue;
    }
  }
  return out;
}

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

