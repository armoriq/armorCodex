import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { readJson, writeJson } from "./fs-store.mjs";
import { withFileLock } from "./live-usage.mjs";
import { isAlive } from "./usage-sync-launch.mjs";

const SHELLS = new Set(["sh", "bash", "zsh", "dash", "fish", "ksh", "csh", "tcsh"]);
const LSTART = /^\s*(\d+)\s+(\w{3}\s+\w{3}\s+\d+\s+[\d:]+\s+\d{4})\s+(.+)$/;

function linuxProcess(pid) {
  const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
  const close = stat.lastIndexOf(")");
  const fields = stat.slice(close + 2).split(" ");
  return {
    pid,
    ppid: Number(fields[1]),
    comm: stat.slice(stat.indexOf("(") + 1, close),
    startedAt: fields[19],
  };
}

function darwinProcess(pid) {
  const out = execFileSync("/bin/ps", ["-o", "ppid=,lstart=,comm=", "-p", String(pid)], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  const m = LSTART.exec(out.trim());
  return m ? { pid, ppid: Number(m[1]), startedAt: m[2], comm: m[3] } : null;
}

export function processInfo(pid) {
  try {
    if (process.platform === "linux") return linuxProcess(pid);
    if (process.platform === "darwin") return darwinProcess(pid);
  } catch {
    return null;
  }
  return null;
}

export function harnessProcess(start = process.ppid) {
  let info = processInfo(start);
  for (let depth = 0; info && depth < 4; depth++) {
    if (!SHELLS.has(path.basename(info.comm).replace(/^-/, ""))) return info;
    info = info.ppid > 1 ? processInfo(info.ppid) : null;
  }
  return null;
}

const sessionsFile = (dir) => path.join(dir, "sessions.json");
const sessionsLock = (dir) => path.join(dir, "sessions.lock");

function updateSessions(dir, change) {
  return withFileLock(sessionsLock(dir), async () => {
    const sessions = change(await readJson(sessionsFile(dir), {}));
    await writeJson(sessionsFile(dir), sessions);
    return sessions;
  });
}

export const registerSession = (dir, sessionId, { pid, startedAt }) =>
  updateSessions(dir, (s) => ({ ...s, [sessionId]: { pid, startedAt } }));

export const endSession = (dir, sessionId) =>
  updateSessions(dir, (s) =>
    Object.fromEntries(Object.entries(s).filter(([id]) => id !== sessionId))
  );

export async function liveSessions(dir) {
  const sessions = await updateSessions(dir, (s) =>
    Object.fromEntries(
      Object.entries(s).filter(([, h]) => processInfo(h.pid)?.startedAt === h.startedAt)
    )
  );
  return Object.keys(sessions).length;
}

export function anySessionAnswers(dir) {
  try {
    const sessions = JSON.parse(readFileSync(sessionsFile(dir), "utf8"));
    return Object.values(sessions).some((h) => isAlive(h.pid));
  } catch {
    return false;
  }
}
