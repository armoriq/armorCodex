import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { collectCounts, environmentFor, pingEnabled, settleCounts } from "./lib/reach.mjs";

const VERSION = /^\d{1,6}\.\d{1,6}\.\d{1,6}(-[0-9A-Za-z.-]{1,32})?$/;

async function readTranscript(file) {
  const handle = await open(file, constants.O_RDONLY | constants.O_NONBLOCK);
  try {
    if (!(await handle.stat()).isFile()) return "";
    const buffer = Buffer.alloc(65536);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    return buffer.toString("utf8", 0, bytesRead);
  } finally {
    await handle.close();
  }
}

function execVersion(timeout, env) {
  return new Promise((resolve, reject) => {
    execFile("codex", ["--version"], { timeout, env, maxBuffer: 1024 }, (error, stdout) => {
      if (error) reject(error);
      else resolve(stdout);
    });
  });
}

function validVersion(value) {
  return typeof value === "string" && value.length <= 64 && VERSION.test(value) ? value : null;
}

async function hostVersion(input, deps) {
  let timer;
  let active = true;
  try {
    const started = Number(deps.now());
    const lookup = async () => {
      try {
        const text = await deps.readTranscript(input.transcriptPath);
        if (!active) return null;
        for (const line of text.split("\n").slice(0, 20)) {
          try {
            const entry = JSON.parse(line);
            if (entry?.type === "session_meta" && Object.hasOwn(entry.payload ?? {}, "cli_version"))
              return validVersion(entry.payload.cli_version);
          } catch {
            // A partial transcript line does not prevent the CLI fallback.
          }
        }
      } catch {
        // Missing transcripts are normal at session startup.
      }
      const remaining = Math.floor(1000 - (Number(deps.now()) - started));
      if (!active || remaining <= 0) return null;
      try {
        const output = await deps.execVersion(Math.min(remaining, 1000), deps.env);
        return validVersion(output.trim().split(/\s+/).find((part) => VERSION.test(part)));
      } catch {
        return null;
      }
    };
    return await Promise.race([
      lookup(),
      new Promise((resolve) => {
        timer = setTimeout(() => {
          active = false;
          resolve(null);
        }, 1000);
      }),
    ]);
  } catch {
    return null;
  } finally {
    active = false;
    clearTimeout(timer);
  }
}

export async function runWorker({
  input,
  env = process.env,
  home = homedir(),
  fetch = globalThis.fetch,
  now = Date.now,
  readTranscript: read = readTranscript,
  execVersion: exec = execVersion,
} = {}) {
  let timer;
  let active = true;
  let acknowledged = false;
  try {
    const enabled = () =>
      pingEnabled({
        env,
        home,
        pluginDisabled: false,
      });
    const send = async () => {
      const environment = environmentFor(input.origin);
      if (!environment || !enabled()) return;
      const collected = collectCounts(home, environment, input.day);
      input.sendingFiles = collected.sendingFiles;
      const version = await hostVersion(input, {
        env,
        now,
        readTranscript: read,
        execVersion: exec,
      });
      if (!active || !enabled()) return;
      const response = await fetch(`${input.origin}/install-pings`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...input.body, hostVersion: version, localCounts: collected.localCounts }),
        redirect: "error",
        signal: globalThis.AbortSignal.timeout(3000),
      });
      acknowledged = active && response?.status >= 200 && response.status < 300;
    };
    await Promise.race([
      send(),
      new Promise((resolve) => {
        timer = setTimeout(() => {
          active = false;
          resolve();
        }, 5000);
      }),
    ]);
  } catch {
    // The ping is best effort and never changes a hook result.
  } finally {
    active = false;
    clearTimeout(timer);
    settleCounts(input?.sendingFiles, acknowledged);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let input;
  const deadline = setTimeout(() => {
    settleCounts(input?.sendingFiles);
    process.exit(0);
  }, 5000);
  try {
    const chunks = [];
    for await (const chunk of process.stdin) chunks.push(chunk);
    input = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    await runWorker({ input });
  } catch {
    // Invalid worker input is discarded without output.
  } finally {
    clearTimeout(deadline);
    process.exit(0);
  }
}
