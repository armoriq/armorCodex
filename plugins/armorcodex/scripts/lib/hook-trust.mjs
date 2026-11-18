import { spawn } from "node:child_process";
import path from "node:path";

export const TRUST_TIMEOUT_MS = 20000;

/**
 * Codex runs a hooks.json hook only once `hooks.state.<key>.trusted_hash` in
 * config.toml matches its current hash, which is what `/hooks` records. The
 * app-server's `hooks/list` reports key, currentHash and trustStatus.
 */
export function hooksToTrust(listResponse, { hooksFile, bootstrapPath }) {
  const command = `node ${bootstrapPath} router`;
  const hooksPath = path.resolve(hooksFile);
  const seen = new Set();
  const picked = [];
  for (const entry of listResponse?.data ?? []) {
    for (const hook of entry?.hooks ?? []) {
      if (seen.has(hook?.key)) continue;
      if (hook?.handlerType !== "command" || hook.command !== command) continue;
      if (typeof hook.sourcePath !== "string" || path.resolve(hook.sourcePath) !== hooksPath) continue;
      if (hook.trustStatus !== "untrusted" && hook.trustStatus !== "modified") continue;
      if (typeof hook.key !== "string" || typeof hook.currentHash !== "string" || !hook.currentHash) continue;
      seen.add(hook.key);
      picked.push({ key: hook.key, currentHash: hook.currentHash, eventName: hook.eventName });
    }
  }
  return picked;
}

export function trustEdits(hooks) {
  if (hooks.length === 0) return [];
  const state = Object.fromEntries(hooks.map((hook) => [hook.key, { trusted_hash: hook.currentHash }]));
  // `hooks.state` as the key path because every hook key contains the dots of
  // `.codex/hooks.json`, which a dotted key path would split on.
  return [{ keyPath: "hooks.state", mergeStrategy: "upsert", value: state }];
}

export function ourHookStatuses(listResponse, { hooksFile, bootstrapPath }) {
  const command = `node ${bootstrapPath} router`;
  const hooksPath = path.resolve(hooksFile);
  const statuses = new Map();
  for (const entry of listResponse?.data ?? []) {
    for (const hook of entry?.hooks ?? []) {
      if (hook?.command !== command || path.resolve(hook?.sourcePath ?? "") !== hooksPath) continue;
      statuses.set(hook.key, hook.trustStatus);
    }
  }
  return statuses;
}

export function appServer({ codexBin, env, timeoutMs }) {
  const child = spawn(codexBin, ["app-server"], { env, stdio: ["pipe", "pipe", "ignore"] });
  const pending = new Map();
  let nextId = 1;
  let buffer = "";
  let failure = null;

  const fail = (error) => {
    failure ??= error;
    for (const { reject } of pending.values()) reject(failure);
    pending.clear();
  };
  child.on("error", fail);
  child.on("exit", (code) => fail(new Error(`codex app-server exited ${code}`)));
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    buffer += chunk;
    let newline;
    while ((newline = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (!line) continue;
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        continue;
      }
      const waiter = message.id !== undefined ? pending.get(message.id) : undefined;
      if (!waiter) continue;
      pending.delete(message.id);
      if (message.error) waiter.reject(new Error(message.error.message ?? JSON.stringify(message.error)));
      else waiter.resolve(message.result);
    }
  });

  const timer = setTimeout(() => fail(new Error(`codex app-server did not answer within ${timeoutMs}ms`)), timeoutMs);

  return {
    request(method, params) {
      if (failure) return Promise.reject(failure);
      const id = nextId++;
      child.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
      return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
    },
    notify(method, params) {
      child.stdin.write(`${JSON.stringify({ method, params })}\n`);
    },
    close() {
      clearTimeout(timer);
      child.stdin.end();
      child.kill();
    }
  };
}

/** Records trust for ArmorCodex's own hooks and nothing else. */
export async function trustArmorCodexHooks({
  hooksFile,
  bootstrapPath,
  codexBin = "codex",
  cwd = process.env.HOME ?? process.cwd(),
  env = process.env,
  timeoutMs = TRUST_TIMEOUT_MS
}) {
  const server = appServer({ codexBin, env, timeoutMs });
  try {
    await server.request("initialize", { clientInfo: { name: "armorcodex-installer", version: "1" } });
    server.notify("initialized", {});
    const scope = { hooksFile, bootstrapPath };
    const before = await server.request("hooks/list", { cwds: [cwd] });
    const toTrust = hooksToTrust(before, scope);
    if (toTrust.length > 0) {
      await server.request("config/batchWrite", { edits: trustEdits(toTrust) });
    }
    const after = ourHookStatuses(await server.request("hooks/list", { cwds: [cwd] }), scope);
    return {
      trusted: toTrust.map((hook) => hook.eventName),
      total: after.size,
      untrusted: [...after].filter(([, status]) => status !== "trusted").map(([key]) => key)
    };
  } finally {
    server.close();
  }
}
