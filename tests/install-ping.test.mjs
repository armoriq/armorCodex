import test from "node:test";
import assert from "node:assert/strict";
import cp, { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import fs, {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { setImmediate } from "node:timers/promises";
import {
  buildBody,
  claimDay,
  ensureInstallId,
  environmentFor,
  launchReach,
  pingEnabled,
} from "../plugins/armorcodex/scripts/lib/reach.mjs";
import * as reach from "../plugins/armorcodex/scripts/lib/reach.mjs";
import { runWorker } from "../plugins/armorcodex/scripts/reach-ping.mjs";

const contract = JSON.parse(
  readFileSync(new URL("./fixtures/install-ping-v1.json", import.meta.url)),
);
const schema = { parse: (body) => checkBody(body) };
const reachUrl = new URL(
  "../plugins/armorcodex/scripts/lib/reach.mjs",
  import.meta.url,
).href;
const workerFile = new URL(
  "../plugins/armorcodex/scripts/reach-ping.mjs",
  import.meta.url,
).pathname;
const origin = contract.origins.production[0];
const installId = contract.examples.valid[0].installId;
const config = {
  backendEndpoint: origin,
  apiKey: "",
};
const denied = {
  hookSpecificOutput: {
    hookEventName: "PreToolUse",
    permissionDecision: "deny",
  },
};

function checkValue(value, rule, at) {
  const types = [].concat(rule.type ?? []);
  const typeOf = (v) =>
    v === null
      ? "null"
      : Array.isArray(v)
        ? "array"
        : Number.isInteger(v)
          ? "integer"
          : typeof v;
  if (
    types.length &&
    !types.some(
      (type) =>
        type === typeOf(value) ||
        (type === "number" && typeof value === "number"),
    )
  )
    throw new Error(`${at}: type`);
  if (Object.hasOwn(rule, "const") && value !== rule.const)
    throw new Error(`${at}: const`);
  if (rule.enum && !rule.enum.includes(value)) throw new Error(`${at}: enum`);
  if (typeof value === "string") {
    if (rule.pattern && !new RegExp(rule.pattern).test(value))
      throw new Error(`${at}: pattern`);
    if (rule.maxLength !== undefined && value.length > rule.maxLength)
      throw new Error(`${at}: maxLength`);
  }
  if (typeof value === "number") {
    if (rule.minimum !== undefined && value < rule.minimum)
      throw new Error(`${at}: minimum`);
    if (rule.maximum !== undefined && value > rule.maximum)
      throw new Error(`${at}: maximum`);
  }
  if (Array.isArray(value)) {
    if (rule.maxItems !== undefined && value.length > rule.maxItems)
      throw new Error(`${at}: maxItems`);
    value.forEach((item, index) =>
      checkValue(item, rule.items ?? {}, `${at}[${index}]`),
    );
  }
  if (typeOf(value) === "object") {
    for (const key of rule.required ?? [])
      if (!Object.hasOwn(value, key)) throw new Error(`${at}.${key}: required`);
    for (const [key, item] of Object.entries(value)) {
      if (!rule.properties?.[key]) {
        if (rule.additionalProperties === false)
          throw new Error(`${at}.${key}: additional`);
        continue;
      }
      checkValue(item, rule.properties[key], `${at}.${key}`);
    }
  }
}

const PAIRS = {
  armorclaude: "claude-code",
  armorcodex: "codex",
  armoropencode: "opencode",
  armorantigravity: "antigravity",
};

function checkBody(body) {
  checkValue(body, contract.schema, "body");
  const days = body.localCounts.map((row) => row.day);
  for (const day of days) {
    const date = new Date(`${day}T00:00:00Z`);
    if (
      !Number.isFinite(date.getTime()) ||
      date.toISOString().slice(0, 10) !== day
    )
      throw new Error("calendar-valid-day");
  }
  if (new Set(days).size !== days.length) throw new Error("distinct-days");
  if (PAIRS[body.plugin] !== body.hostAgent)
    throw new Error("plugin-host-pair");
  return body;
}

function tempHome(t) {
  const home = mkdtempSync(path.join(tmpdir(), "install-ping-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  return home;
}

function countsDir(home, environment = "production") {
  return path.join(home, ".armoriq/reach/v1/armorcodex", environment);
}

function countsFile(home, day = "2026-11-14", environment = "production") {
  return path.join(countsDir(home, environment), `counts-${day}.ndjson`);
}

function markNotice(home) {
  const dir = path.join(home, ".armoriq/reach/v1/armorcodex");
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "notice-shown"), "", { mode: 0o600 });
}

function mockFs(t, overrides) {
  for (const [name, implementation] of Object.entries(overrides))
    t.mock.method(fs, name, implementation);
  syncBuiltinESMExports();
  t.after(() => {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  });
}

function settings(home, value, readable = true) {
  const dir = path.join(home, ".armoriq");
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "settings.json");
  writeFileSync(file, value === "malformed" ? "{" : JSON.stringify(value));
  if (!readable) chmodSync(file, 0);
}

function setVector(home, vector) {
  if (Object.hasOwn(vector, "settingsJson"))
    settings(home, vector.settingsJson);
  else if (vector.settings !== null || vector.settingsReadable === false)
    settings(home, vector.settings ?? {}, vector.settingsReadable !== false);
  const rule = contract.optOut.pluginSettings[vector.plugin];
  return Boolean(
    rule && vector.pluginConfig?.[rule.key] === rule.disabledValue,
  );
}

function launched(home, overrides = {}) {
  const sent = [];
  return {
    sent,
    deps: {
      home,
      env: {},
      now: () => new Date("2026-11-14T23:59:59.999Z"),
      platform: "darwin",
      spawnWorker: (input) => sent.push(input),
      ...overrides,
    },
  };
}

function workerInput() {
  return {
    origin,
    day: "2026-11-14",
    body: buildBody({
      installId,
      config,
      signedIn: false,
      environment: "production",
      platform: "linux",
    }),
    transcriptPath: "/private/transcript.jsonl",
  };
}

function workerDeps(t, overrides = {}) {
  return {
    input: workerInput(),
    env: {},
    home: tempHome(t),
    now: () => 0,
    readTranscript: async () => "",
    execVersion: async () => "",
    fetch: async () => ({ status: 204 }),
    ...overrides,
  };
}

async function workerBody(t, home, input) {
  let body;
  await runWorker(
    workerDeps(t, {
      home,
      input,
      fetch: async (_url, init) => {
        body = JSON.parse(init.body);
        return { status: 204 };
      },
    }),
  );
  return body;
}

async function race(t, home, operation) {
  const script = `import { ensureInstallId, launchReach } from ${JSON.stringify(reachUrl)};
    process.send('ready'); process.once('message', () => { ${operation}; process.disconnect(); });`;
  const children = [0, 1].map(() =>
    spawn(process.execPath, ["--input-type=module", "-e", script], {
      env: { ...process.env, HOME: home },
      stdio: ["ignore", "pipe", "pipe", "ipc"],
    }),
  );
  t.after(() =>
    children.forEach((child) => {
      if (child.exitCode === null) child.kill();
    }),
  );
  const outputs = children.map((child) => {
    let output = "";
    child.stdout.on("data", (chunk) => {
      output += chunk;
    });
    return once(child, "exit").then(([code]) => {
      assert.equal(code, 0);
      return output.trim();
    });
  });
  await Promise.all(children.map((child) => once(child, "message")));
  children.forEach((child) => child.send("go"));
  return Promise.all(outputs);
}

// regression: #0015
const planReply = (text) => ({ content: [{ type: "text", text }] });

const ROUTER = new URL(
  "../plugins/armorcodex/scripts/hook-router.mjs",
  import.meta.url,
).pathname;

async function routerRun(home, payload, extra = {}) {
  const preload = path.join(home, "capture-worker.mjs");
  writeFileSync(
    preload,
    `import cp from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { EventEmitter } from 'node:events';
import { appendFileSync } from 'node:fs';
const real = cp.spawn;
cp.spawn = function (command, args, options) {
  if (args?.[0] !== ${JSON.stringify(workerFile)}) return real(command, args, options);
  appendFileSync(${JSON.stringify(path.join(home, "worker-spawns"))}, 'spawn\\n');
  const child = new EventEmitter();
  child.stdin = new EventEmitter();
  child.stdin.end = () => {};
  child.unref = () => {};
  return child;
};
syncBuiltinESMExports();`,
  );
  const guard = path.join(home, "local-fetch.mjs");
  writeFileSync(
    guard,
    `const real = globalThis.fetch;
globalThis.fetch = (url, init) => {
  if (url !== ${JSON.stringify(`${origin}/install-pings`)}) throw new Error('Test blocked external fetch');
  return real('http://127.0.0.1:9/install-pings', init);
};`,
  );
  const child = spawn(process.execPath, [ROUTER], {
    env: {
      PATH: process.env.PATH,
      HOME: home,
      ARMORCODEX_DATA_DIR: path.join(home, "data"),
      ARMORIQ_API_KEY: "",
      NODE_OPTIONS: `--import=${guard} --import=${preload}`,
      ...extra,
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stdout = "";
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stdin.end(JSON.stringify(payload));
  await once(child, "exit");
  return stdout;
}

// regression: #0015
// regression: #0015
// regression: #0015
test("counter appends one write per event in its UTC day and stops past 5 MB", (t) => {
  const home = tempHome(t);
  const { deps } = launched(home);
  const writes = [];
  const { writeSync, openSync } = fs;
  mockFs(t, {
    openSync: (file, flags, mode) => {
      assert.ok(flags & fs.constants.O_APPEND);
      return openSync(file, flags, mode);
    },
    writeSync: (fd, line) => {
      writes.push(line);
      return writeSync(fd, line);
    },
  });
  reach.withReach("PreToolUse", {}, config, denied, deps);
  reach.withReach("PreToolUse", {}, config, denied, {
    ...deps,
    now: () => new Date("2026-11-15T00:00:00Z"),
  });
  assert.deepEqual(writes, [
    contract.localCountsLine[1],
    contract.localCountsLine[1],
  ]);
  assert.equal(
    readFileSync(countsFile(home, "2026-11-15"), "utf8"),
    contract.localCountsLine[1],
  );
  const file = countsFile(home);
  writeFileSync(file, "x".repeat(5 * 1024 * 1024 + 1));
  reach.withReach("PreToolUse", {}, config, denied, deps);
  assert.equal(lstatSync(file).size, 5 * 1024 * 1024 + 1);
  assert.equal(writes.length, 2);
});

test("only exact contract origins select an environment", () => {
  for (const [environment, origins] of Object.entries(contract.origins)) {
    for (const value of origins) {
      assert.equal(environmentFor(value), environment);
      for (const invalid of [
        value.replace("https:", "http:"),
        `${value}:443`,
        `${value}/`,
        `${value}/v1`,
        value.replace("https://", "https://user@"),
        `${value}?a=1`,
        `${value}#fragment`,
      ])
        assert.equal(environmentFor(invalid), null, invalid);
    }
  }
  for (const value of [
    "https://staging.armoriq.ai",
    "http://localhost:8000",
    "http://127.0.0.1:9",
    null,
    "https://API.ARMORIQ.AI",
  ])
    assert.equal(environmentFor(value), null);
});

test("install id is published complete, private, reused, and separate from the sign in device", (t) => {
  const home = tempHome(t);
  const dir = path.join(home, ".armoriq");
  const file = path.join(dir, "install-id");
  const visible = [];
  const { openSync, linkSync } = fs;
  mockFs(t, {
    openSync: (...args) => {
      const fd = openSync(...args);
      if (args[0] === file && args[1] === "wx")
        visible.push(readFileSync(file, "utf8"));
      return fd;
    },
    linkSync: (...args) => {
      linkSync(...args);
      visible.push(readFileSync(file, "utf8"));
    },
  });
  const id = ensureInstallId(home);
  assert.match(id, new RegExp(contract.schema.properties.installId.pattern));
  assert.deepEqual(visible, [`${id}\n`]);
  assert.equal(readFileSync(file, "utf8"), `${id}\n`);
  assert.equal(lstatSync(file).mode & 0o777, 0o600);
  assert.equal(lstatSync(dir).mode & 0o777, 0o700);
  assert.equal(ensureInstallId(home), id);
  assert.equal(existsSync(path.join(dir, "device-id")), false);
  assert.deepEqual(readdirSync(dir), ["install-id"]);
});

for (const [code, winner, denied] of [
  ["EEXIST", true, false],
  ["ENOTSUP", false, false],
  ["ENOTSUP", true, false],
  ["EACCES", false, true],
]) {
  test(`install id cleans up after link ${code}, winner ${winner}, denied ${denied}`, (t) => {
    const home = tempHome(t);
    const dir = path.join(home, ".armoriq");
    const file = path.join(dir, "install-id");
    const candidates = [];
    const { openSync } = fs;
    mockFs(t, {
      linkSync: (temp, target) => {
        candidates.push(readFileSync(temp, "utf8"));
        if (winner)
          writeFileSync(target, `${installId}\n`, { flag: "wx", mode: 0o600 });
        throw Object.assign(new Error("link unavailable"), { code });
      },
      openSync: (...args) => {
        if (denied && args[0] === file && args[1] === "wx")
          throw Object.assign(new Error("create denied"), { code: "EACCES" });
        return openSync(...args);
      },
    });
    const id = ensureInstallId(home);
    assert.equal(candidates.length, 1);
    assert.match(
      candidates[0].slice(0, -1),
      new RegExp(contract.schema.properties.installId.pattern),
    );
    assert.equal(candidates[0].slice(-1), "\n");
    if (denied) {
      assert.equal(id, null);
      assert.deepEqual(readdirSync(dir), []);
    } else {
      if (winner) assert.equal(id, installId);
      else assert.equal(`${id}\n`, candidates[0]);
      assert.equal(readFileSync(file, "utf8"), `${id}\n`);
      assert.equal(lstatSync(file).mode & 0o777, 0o600);
      assert.deepEqual(readdirSync(dir), ["install-id"]);
    }
  });
}

test("an interrupted candidate write leaves no install id or temp file", (t) => {
  const home = tempHome(t);
  const { writeFileSync } = fs;
  mockFs(t, {
    writeFileSync: (file, contents, options) => {
      writeFileSync(file, contents.slice(0, 5), options);
      throw Object.assign(new Error("disk full"), { code: "ENOSPC" });
    },
  });
  assert.equal(ensureInstallId(home), null);
  assert.deepEqual(readdirSync(path.join(home, ".armoriq")), []);
});

test("a stale install id temp file does not block creation", (t) => {
  const home = tempHome(t);
  const dir = path.join(home, ".armoriq");
  const stale = "install-id.99999.crashed.tmp";
  mkdirSync(dir, { mode: 0o700 });
  writeFileSync(path.join(dir, stale), "partial", { mode: 0o600 });
  const id = ensureInstallId(home);
  assert.match(id, new RegExp(contract.schema.properties.installId.pattern));
  assert.equal(readFileSync(path.join(dir, "install-id"), "utf8"), `${id}\n`);
  assert.deepEqual(readdirSync(dir).sort(), ["install-id", stale]);
  assert.equal(readFileSync(path.join(dir, stale), "utf8"), "partial");
});

for (const kind of [
  "symlink",
  "empty",
  "invalid",
  "no newline",
  "extra newline",
  "uppercase",
  "unreadable",
  "directory",
]) {
  test(`an ${kind} install id is left untouched`, (t) => {
    const home = tempHome(t);
    const dir = path.join(home, ".armoriq");
    const file = path.join(dir, "install-id");
    mkdirSync(dir);
    const contents =
      kind === "empty"
        ? ""
        : kind === "invalid"
          ? "not-an-id\n"
          : kind === "no newline"
            ? installId
            : kind === "extra newline"
              ? `${installId}\n\n`
              : `${kind === "uppercase" ? installId.toUpperCase() : installId}\n`;
    if (kind === "symlink") {
      writeFileSync(path.join(home, "target"), contents);
      symlinkSync(path.join(home, "target"), file);
    } else if (kind === "directory") mkdirSync(file);
    else
      writeFileSync(file, contents, {
        mode: kind === "unreadable" ? 0 : 0o600,
      });
    const before = lstatSync(file);
    assert.equal(ensureInstallId(home), null);
    const after = lstatSync(file);
    assert.equal(after.ino, before.ino);
    assert.equal(after.mode, before.mode);
    if (kind !== "directory") {
      if (kind === "unreadable") chmodSync(file, 0o600);
      assert.equal(readFileSync(file, "utf8"), contents);
    }
    assert.equal(existsSync(path.join(dir, "device-id")), false);
  });
}

test("two processes agree on one install id", async (t) => {
  const home = tempHome(t);
  const ids = await race(
    t,
    home,
    "console.log(ensureInstallId(process.env.HOME))",
  );
  assert.equal(ids[0], ids[1]);
  assert.match(
    ids[0],
    new RegExp(contract.schema.properties.installId.pattern),
  );
  assert.deepEqual(readdirSync(path.join(home, ".armoriq")), ["install-id"]);
});

test("a claim keeps its day after failure and prunes only its old dates", (t) => {
  const home = tempHome(t);
  const args = {
    home,
    plugin: "armorcodex",
    environment: "production",
    day: "2026-11-14",
  };
  assert.equal(claimDay(args), true);
  assert.equal(claimDay(args), false);
  const dir = path.join(home, ".armoriq/reach/v1/armorcodex/production");
  assert.equal(
    lstatSync(path.join(dir, "ping-2026-11-14")).mode & 0o777,
    0o600,
  );
  for (let current = dir; current !== home; current = path.dirname(current))
    assert.equal(lstatSync(current).mode & 0o777, 0o700);
  for (const name of [
    "ping-2026-10-14",
    "ping-2026-10-15",
    "ping-2026-02-30",
    "counts-2026-10-14.ndjson",
    "ping-2026-12-01",
  ])
    writeFileSync(path.join(dir, name), "");
  assert.equal(claimDay({ ...args, day: "2026-11-15" }), true);
  assert.deepEqual(
    readdirSync(dir).sort(),
    [
      "counts-2026-10-14.ndjson",
      "ping-2026-02-30",
      "ping-2026-11-14",
      "ping-2026-11-15",
      "ping-2026-12-01",
    ].sort(),
  );
  assert.equal(claimDay({ ...args, environment: "staging" }), true);
  assert.equal(claimDay({ ...args, plugin: "armorclaude" }), true);
});

test("session and prompt share one UTC daily attempt, including a failed spawn", (t) => {
  const home = tempHome(t);
  markNotice(home);
  let clockReads = 0;
  const { sent, deps } = launched(home, {
    now: () => {
      clockReads += 1;
      return new Date("2026-11-14T23:59:59.999Z");
    },
  });
  assert.equal(launchReach("SessionStart", {}, config, deps), undefined);
  launchReach("UserPromptSubmit", {}, config, deps);
  assert.equal(sent.length, 1);
  assert.equal(clockReads, 2);
  launchReach("UserPromptSubmit", {}, config, {
    ...deps,
    now: () => new Date("2026-11-15T00:00:00.000Z"),
  });
  assert.equal(sent.length, 2);
  launchReach("SessionStart", {}, config, {
    ...deps,
    now: () => new Date("2026-11-13T00:00:00.000Z"),
    spawnWorker: () => {
      throw new Error("spawn failed");
    },
  });
  launchReach("SessionStart", {}, config, {
    ...deps,
    now: () => new Date("2026-11-13T00:00:00.000Z"),
  });
  assert.equal(sent.length, 2);
});

test("two racing hooks spawn only one worker", async (t) => {
  const home = tempHome(t);
  markNotice(home);
  const outputs = await race(
    t,
    home,
    `launchReach('SessionStart', {}, ${JSON.stringify(config)}, {
    home: process.env.HOME, env: {}, now: () => new Date('2026-11-14T00:00:00Z'),
    spawnWorker: () => console.log('spawn')
  })`,
  );
  assert.deepEqual(outputs.filter(Boolean), ["spawn"]);
});

test("ineligible hooks leave no install id or reach files", (t) => {
  const vectors = contract.optOut.testVectors.filter(
    (vector) => !vector.plugin && !vector.enabled,
  );
  for (const vector of vectors) {
    const home = tempHome(t);
    setVector(home, vector);
    const { sent, deps } = launched(home, { env: vector.env });
    launchReach("SessionStart", {}, config, deps);
    assert.equal(sent.length, 0);
    assert.equal(existsSync(path.join(home, ".armoriq/install-id")), false);
    assert.equal(existsSync(path.join(home, ".armoriq/reach")), false);
  }
  for (const [event, overrides] of [
    ["PreToolUse", {}],
    ["PostToolUse", {}],
    ["Stop", {}],
    ["SessionEnd", {}],
    ["UserPromptExpansion", {}],
    ["unknown", {}],
    ["SessionStart", { backendEndpoint: "http://127.0.0.1:8000" }],
  ]) {
    const home = tempHome(t);
    const { sent, deps } = launched(home);
    launchReach(event, {}, { ...config, ...overrides }, deps);
    assert.equal(sent.length, 0);
    assert.equal(existsSync(path.join(home, ".armoriq")), false);
  }
});

test("worker sends one anonymous request with a three second abort", async (t) => {
  const controller = new AbortController();
  t.mock.method(globalThis.AbortSignal, "timeout", (ms) => {
    assert.equal(ms, 3000);
    return controller.signal;
  });
  const requests = [];
  await runWorker(
    workerDeps(t, {
      readTranscript: async () =>
        '{"type":"session_meta","payload":{"cli_version":"2.1.325"}}\n',
      fetch: async (url, init) => {
        requests.push([url, init]);
        assert.equal(init.signal, controller.signal);
        controller.abort();
        throw controller.signal.reason;
      },
    }),
  );
  assert.equal(requests.length, 1);
  const [url, init] = requests[0];
  assert.equal(url, `${origin}/install-pings`);
  assert.equal(init.method, "POST");
  assert.deepEqual(init.headers, { "content-type": "application/json" });
  assert.equal(init.redirect, "error");
  const body = JSON.parse(init.body);
  schema.parse(body);
  assert.equal(body.hostVersion, "2.1.325");
  assert.equal(Object.hasOwn(body, "transcriptPath"), false);
});

for (const result of [204, 500, 429, 302, "error", "timeout"]) {
  test(`worker settles yesterday's counts without retrying after ${result}`, async (t) => {
    const home = tempHome(t);
    markNotice(home);
    const { sent, deps } = launched(home);
    reach.noteReach("PreToolUse", {}, config, denied, {
      ...deps,
      now: () => new Date("2026-11-13T23:59:59.999Z"),
    });
    launchReach("SessionStart", {}, config, deps);
    const expected = [{ day: "2026-11-13", plans: 0, blocked: 1, held: 0 }];
    if (result === "timeout") {
      t.mock.timers.enable({ apis: ["setTimeout"] });
      t.mock.method(globalThis.AbortSignal, "timeout", (ms) => {
        const controller = new AbortController();
        setTimeout(() => controller.abort(new Error("timeout")), ms);
        return controller.signal;
      });
    }
    let attempts = 0;
    let request;
    const running = runWorker(
      workerDeps(t, {
        home,
        input: sent[0],
        fetch: async (_url, init) => {
          attempts += 1;
          request = {
            redirect: init.redirect,
            body: JSON.parse(init.body),
            active: existsSync(countsFile(home, "2026-11-13")),
            sending: existsSync(`${countsFile(home, "2026-11-13")}.sending`),
          };
          if (result === "error") throw new Error("offline");
          if (result === "timeout")
            return new Promise((_resolve, reject) => {
              init.signal.addEventListener(
                "abort",
                () => reject(init.signal.reason),
                {
                  once: true,
                },
              );
            });
          return {
            status: result,
            headers: { location: "https://elsewhere.invalid" },
          };
        },
      }),
    );
    if (result === "timeout") {
      await setImmediate();
      t.mock.timers.tick(3000);
    }
    await running;
    assert.equal(attempts, 1);
    assert.equal(request.redirect, "error");
    schema.parse(request.body);
    assert.deepEqual(request.body.localCounts, expected);
    assert.equal(request.active, false);
    assert.equal(request.sending, true);
    assert.equal(
      existsSync(`${countsFile(home, "2026-11-13")}.sending`),
      false,
    );
    assert.equal(existsSync(countsFile(home, "2026-11-13")), result !== 204);
    launchReach("UserPromptSubmit", {}, config, {
      ...deps,
      now: () => new Date("2026-11-15T00:00:00Z"),
    });
    assert.deepEqual(
      (await workerBody(t, home, sent[1])).localCounts,
      result === 204 ? [] : expected,
    );
  });
}

test("the worker collects at most seven earlier UTC days, skips bad lines and caps each metric", async (t) => {
  for (const zero of [false, true]) {
    const home = tempHome(t);
    markNotice(home);
    mkdirSync(countsDir(home), { recursive: true, mode: 0o700 });
    for (let day = 5; day <= 15; day += 1)
      writeFileSync(
        countsFile(home, `2026-11-${String(day).padStart(2, "0")}`),
        contract.localCountsLine[1],
      );
    const invalid = '{\nnull\n{"t":"unknown"}\n{"t":"plan","extra":1}\n';
    writeFileSync(
      countsFile(home, "2026-11-12"),
      invalid + contract.localCountsLine.join(""),
    );
    writeFileSync(
      countsFile(home, "2026-11-11"),
      contract.localCountsLine.map((line) => line.repeat(100001)).join(""),
    );
    if (zero) writeFileSync(countsFile(home, "2026-11-10"), invalid);
    writeFileSync(
      path.join(countsDir(home), "counts-2026-02-30.ndjson"),
      contract.localCountsLine[0],
    );
    const { sent, deps } = launched(home);
    launchReach("SessionStart", {}, config, deps);
    assert.equal(existsSync(countsFile(home, "2026-11-13")), true);
    assert.equal(
      existsSync(`${countsFile(home, "2026-11-13")}.sending`),
      false,
    );
    const body = await workerBody(t, home, sent[0]);
    schema.parse(body);
    const days = ["13", "12", "11", "10", "09", "08", "07"]
      .filter((day) => !zero || day !== "10")
      .map((day) => `2026-11-${day}`);
    assert.deepEqual(
      body.localCounts.map((row) => row.day),
      days,
    );
    assert.deepEqual(
      body.localCounts.find((row) => row.day === "2026-11-12"),
      { day: "2026-11-12", plans: 1, blocked: 1, held: 1 },
    );
    assert.deepEqual(
      body.localCounts.find((row) => row.day === "2026-11-11"),
      { day: "2026-11-11", plans: 100000, blocked: 100000, held: 100000 },
    );
    for (const day of ["2026-11-05", "2026-11-06"])
      assert.equal(existsSync(countsFile(home, day)), false);
    for (const day of ["2026-11-14", "2026-11-15", "2026-02-30"])
      assert.equal(
        readFileSync(countsFile(home, day), "utf8"),
        contract.localCountsLine[day === "2026-02-30" ? 0 : 1],
      );
  }
});
