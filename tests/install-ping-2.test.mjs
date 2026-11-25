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
import { loadSettings } from "../plugins/armorcodex/scripts/lib/config.mjs";
import { handlePreToolUse, handleUserPromptSubmit } from "../plugins/armorcodex/scripts/lib/engine.mjs";
import { withRunState } from "../plugins/armorcodex/scripts/lib/runs.mjs";

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
for (const result of [204, 500]) {
  test(`leftover sending files and late writers lose no lines after ${result}`, async (t) => {
    const home = tempHome(t);
    markNotice(home);
    mkdirSync(countsDir(home), { recursive: true, mode: 0o700 });
    const file = countsFile(home, "2026-11-13");
    writeFileSync(`${file}.sending`, contract.localCountsLine[0]);
    writeFileSync(file, contract.localCountsLine[2]);
    const stale = `${countsFile(home, "2026-11-06")}.sending`;
    writeFileSync(stale, contract.localCountsLine[0]);
    const { sent, deps } = launched(home);
    launchReach("SessionStart", {}, config, deps);
    let body;
    let staleFiles;
    await runWorker(
      workerDeps(t, {
        home,
        input: sent[0],
        fetch: async (_url, init) => {
          body = JSON.parse(init.body);
          staleFiles = [existsSync(stale), existsSync(stale.slice(0, -8))];
          writeFileSync(file, contract.localCountsLine[1], {
            flag: "a",
            mode: 0o600,
          });
          return { status: result };
        },
      }),
    );
    assert.deepEqual(staleFiles, [false, false]);
    assert.deepEqual(body.localCounts, [
      { day: "2026-11-13", plans: 1, blocked: 0, held: 1 },
    ]);
    assert.equal(existsSync(`${file}.sending`), false);
    const lines = readFileSync(file, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line).t)
      .sort();
    assert.deepEqual(
      lines,
      result === 204 ? ["blocked"] : ["blocked", "held", "plan"],
    );
    assert.equal(lstatSync(file).mode & 0o777, 0o600);
    launchReach("SessionStart", {}, config, {
      ...deps,
      now: () => new Date("2026-11-15T00:00:00Z"),
    });
    assert.deepEqual((await workerBody(t, home, sent[1])).localCounts, [
      {
        day: "2026-11-13",
        plans: result === 204 ? 0 : 1,
        blocked: 1,
        held: result === 204 ? 0 : 1,
      },
    ]);
  });
}

test("worker rechecks opt outs after looking up the host version", async (t) => {
  for (const source of ["env", "settings"]) {
    const env = {};
    const home = tempHome(t);
    markNotice(home);
    mkdirSync(countsDir(home), { recursive: true, mode: 0o700 });
    const file = countsFile(home, "2026-11-13");
    writeFileSync(file, contract.localCountsLine[0]);
    const { sent, deps } = launched(home);
    launchReach("SessionStart", {}, config, deps);
    let attempts = 0;
    await runWorker(
      workerDeps(t, {
        env,
        home,
        input: sent[0],
        readTranscript: async () => {
          if (source === "env") env.DO_NOT_TRACK = "true";
          if (source === "settings") settings(home, { usagePing: false });
          return '{"type":"session_meta","payload":{"cli_version":"2.1.325"}}\n';
        },
        fetch: async () => {
          attempts += 1;
        },
      }),
    );
    assert.equal(attempts, 0);
    assert.equal(readFileSync(file, "utf8"), contract.localCountsLine[0]);
    assert.equal(existsSync(`${file}.sending`), false);
  }
});

test("worker ignores a non contract origin before version lookup", async (t) => {
  let reads = 0;
  let requests = 0;
  await runWorker(
    workerDeps(t, {
      input: { ...workerInput(), origin: "http://127.0.0.1:8000" },
      readTranscript: async () => {
        reads += 1;
      },
      fetch: async () => {
        requests += 1;
      },
    }),
  );
  assert.equal(reads, 0);
  assert.equal(requests, 0);
});

test("host lookup shares a one second budget and sending has a hard deadline", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const home = tempHome(t);
  markNotice(home);
  mkdirSync(countsDir(home), { recursive: true, mode: 0o700 });
  const file = countsFile(home, "2026-11-13");
  writeFileSync(file, contract.localCountsLine[0]);
  const { sent, deps } = launched(home);
  launchReach("SessionStart", {}, config, deps);
  let requests = 0;
  let execs = 0;
  const running = runWorker(
    workerDeps(t, {
      home,
      input: sent[0],
      readTranscript: () => new Promise(() => {}),
      execVersion: async () => {
        execs += 1;
        return "1.2.3";
      },
      fetch: async (_url, init) => {
        requests += 1;
        assert.equal(JSON.parse(init.body).hostVersion, null);
        return new Promise(() => {});
      },
    }),
  );
  await setImmediate();
  t.mock.timers.tick(1000);
  await setImmediate();
  assert.equal(execs, 0);
  assert.equal(requests, 1);
  t.mock.timers.tick(4000);
  await running;
  assert.equal(readFileSync(file, "utf8"), contract.localCountsLine[0]);
  assert.equal(existsSync(`${file}.sending`), false);
});

test("version lookup errors produce null and still allow one send", async (t) => {
  let body;
  await runWorker(
    workerDeps(t, {
      readTranscript: async () => {
        throw new Error("missing");
      },
      execVersion: async () => {
        throw new Error("not installed");
      },
      fetch: async (_url, init) => {
        body = JSON.parse(init.body);
      },
    }),
  );
  assert.equal(body.hostVersion, null);
});

test("the body checker follows the contract examples", () => {
  for (const body of contract.examples.valid)
    assert.doesNotThrow(() => checkBody(body));
  for (const { reason, body } of contract.examples.invalid)
    assert.throws(() => checkBody(body), undefined, reason);
});

for (const [label, event, input, output, line] of [
  ["a deny", "PreToolUse", {}, denied, contract.localCountsLine[1]],
  [
    "an ask",
    "PreToolUse",
    {},
    { hookSpecificOutput: { permissionDecision: "ask" } },
    contract.localCountsLine[2],
  ],
  [
    "a denied permission request",
    "PermissionRequest",
    {},
    {
      hookSpecificOutput: {
        hookEventName: "PermissionRequest",
        decision: { behavior: "deny" },
      },
    },
    contract.localCountsLine[1],
  ],
  ...[
    "register_intent_plan",
    "mcp__armorcodex-policy__register_intent_plan",
    "mcp__armorcodex_policy__register_intent_plan",
    "armorcodex-policy.register_intent_plan",
  ].map((tool) => [
    `a stored plan from ${tool}`,
    "PostToolUse",
    {
      tool_name: tool,
      tool_response: planReply(
        "Intent registered: 2 steps. Plan stored locally (no ArmorIQ backend configured).",
      ),
    },
    undefined,
    contract.localCountsLine[0],
  ]),
  [
    "a plan given as a plain string",
    "PostToolUse",
    {
      tool_name: "register_intent_plan",
      tool_response: "Intent registered: 1 steps.",
    },
    undefined,
    contract.localCountsLine[0],
  ],
  ...[
    [
      "JSON message",
      JSON.stringify({ message: "Intent registered: 1 steps." }),
    ],
    ["JSON content", JSON.stringify(planReply("Intent registered: 1 steps."))],
    [
      "JSON string content",
      JSON.stringify({ content: "Intent registered: 1 steps." }),
    ],
    ["string content", { content: "Intent registered: 1 steps." }],
    [
      "content without block types",
      { content: [{ text: "Intent registered: 1 steps." }] },
    ],
    ["text blocks", [{ type: "text", text: "Intent registered: 1 steps." }]],
    ["message object", { message: "Intent registered: 1 steps." }],
  ].map(([label, tool_response]) => [
    `a plan given as ${label}`,
    "PostToolUse",
    { tool_name: "register_intent_plan", tool_response },
    undefined,
    contract.localCountsLine[0],
  ]),
]) {
  // regression: #0015
  test(`counts ${label} while signed out and nothing while signed in`, (t) => {
    const home = tempHome(t);
    const { deps } = launched(home);
    reach.noteReach(event, input, config, output, deps);
    assert.equal(readFileSync(countsFile(home), "utf8"), line);
    const signedInHome = tempHome(t);
    reach.noteReach(
      event,
      input,
      { ...config, apiKey: "ak_test_signed" },
      output,
      {
        ...deps,
        home: signedInHome,
      },
    );
    assert.equal(existsSync(countsFile(signedInHome)), false);
  });
}

for (const [label, event, input, output] of [
  [
    "an allow",
    "PreToolUse",
    {},
    { hookSpecificOutput: { permissionDecision: "allow" } },
  ],
  ["no output", "PreToolUse", {}, undefined],
  [
    "an allowed permission request",
    "PermissionRequest",
    {},
    { hookSpecificOutput: { decision: { behavior: "allow" } } },
  ],
  ...[
    "Plan rejected: steps: Required",
    "Plan rejected: this Codex version sends no session id with MCP calls. Update Codex to 0.162 or later.",
    "Plan rejected (backend_unreachable): the ArmorIQ backend did not answer, so no token was issued.",
    "Plan rejected: the ArmorIQ token request failed (boom). Nothing was stored; register the plan again.",
  ].map((text) => [
    `the refusal "${text.slice(0, 30)}"`,
    "PostToolUse",
    { tool_name: "register_intent_plan", tool_response: planReply(text) },
    undefined,
  ]),
  ...[
    ["a missing plan response", undefined],
    ["an empty plan response", {}],
    ["an empty string", ""],
    ["an unknown response", { result: "Intent registered: 1 steps." }],
    [
      "an unknown nested content",
      { content: { message: "Intent registered: 1 steps." } },
    ],
    [
      "an unknown text block",
      [{ type: "image", text: "Intent registered: 1 steps." }],
    ],
    ["an unknown reply", "Something happened"],
    [
      "an MCP error",
      { isError: true, ...planReply("Intent registered: 1 steps.") },
    ],
    [
      "a snake case error",
      { is_error: true, message: "Intent registered: 1 steps." },
    ],
    [
      "an error field",
      { error: "failed", ...planReply("Intent registered: 1 steps.") },
    ],
    [
      "an MCP validation error",
      {
        isError: true,
        ...planReply("MCP error -32602: Input validation error"),
      },
    ],
    ["a JSON refusal", JSON.stringify({ message: "Plan rejected: no token" })],
    ["a reworded refusal", "Plan not registered: no token"],
    [
      "a refusal before success text",
      {
        content: [
          { type: "text", text: "Plan not registered" },
          { type: "text", text: "Intent registered: 1 steps." },
        ],
      },
    ],
    [
      "a JSON error",
      JSON.stringify({
        isError: true,
        ...planReply("Intent registered: 1 steps."),
      }),
    ],
  ].map(([label, tool_response]) => [
    label,
    "PostToolUse",
    { tool_name: "register_intent_plan", tool_response },
    undefined,
  ]),
  [
    "another server's same named tool",
    "PostToolUse",
    {
      tool_name: "mcp__evil__register_intent_plan",
      tool_response: planReply("Intent registered"),
    },
    undefined,
  ],
  [
    "a failed tool call",
    "PostToolUseFailure",
    { tool_name: "register_intent_plan" },
    undefined,
  ],
]) {
  // regression: #0015
  test(`does not count ${label}`, (t) => {
    const home = tempHome(t);
    const { deps } = launched(home);
    reach.noteReach(event, input, config, output, deps);
    assert.equal(existsSync(countsFile(home)), false);
  });
}

test("withReach leaves other events and ineligible SessionStart output unchanged and never throws", (t) => {
  const home = tempHome(t);
  const { deps } = launched(home);
  const output = {
    hookSpecificOutput: { permissionDecision: "deny" },
    systemMessage: "kept",
  };
  assert.equal(reach.withReach("PreToolUse", {}, config, output, deps), output);
  assert.equal(
    reach.withReach("SessionStart", {}, config, undefined, {
      ...deps,
      env: { DO_NOT_TRACK: "1", ARMORIQ_SIGNIN_REMINDER_DISABLED: "1" },
    }),
    undefined,
  );
  assert.equal(
    reach.withReach("SessionStart", null, null, output, {
      ...deps,
      home: null,
    }),
    output,
  );
});

test("the hook router shows the notice before the first ping and otherwise preserves output", async (t) => {
  const outputs = {};
  for (const tracking of ["0", "1"]) {
    const home = tempHome(t);
    const env = {
      DO_NOT_TRACK: tracking,
      ARMORIQ_SIGNIN_REMINDER_DISABLED: tracking,
      ARMORIQ_ENV: "production",
    };
    const prompt = {
      hook_event_name: "UserPromptSubmit",
      session_id: "reach-s",
      prompt: "hello",
      cwd: home,
    };
    await routerRun(home, prompt, env);
    assert.equal(existsSync(path.join(home, "worker-spawns")), false);
    assert.equal(existsSync(path.join(home, ".armoriq/install-id")), false);
    const session = await routerRun(
      home,
      {
        hook_event_name: "SessionStart",
        session_id: "reach-s",
        source: "startup",
        cwd: home,
      },
      env,
    );
    assert.equal(existsSync(path.join(home, "worker-spawns")), false);
    await routerRun(home, prompt, env);
    const second = await routerRun(
      home,
      {
        hook_event_name: "SessionStart",
        session_id: "reach-s-second",
        source: "resume",
        cwd: home,
      },
      env,
    );
    assert.equal(JSON.parse(second).systemMessage, undefined);
    const tool = await routerRun(
      home,
      {
        hook_event_name: "PreToolUse",
        session_id: "reach-s",
        tool_name: "Bash",
        tool_input: { command: "ls" },
        cwd: home,
      },
      { DO_NOT_TRACK: tracking },
    );
    outputs[tracking] = [JSON.parse(session), tool];
    const spawned = existsSync(path.join(home, "worker-spawns"));
    assert.equal(spawned, tracking === "0");
    assert.equal(
      existsSync(path.join(home, ".armoriq/install-id")),
      tracking === "0",
    );
    assert.equal(
      existsSync(path.join(home, ".armoriq/reach")),
      tracking === "0",
    );
  }
  const messages = outputs["0"][0].systemMessage.split("\n\n");
  assert.equal(messages[0], contract.notice);
  assert.match(
    messages[1],
    /^ArmorCodex is not signed in to ArmorIQ\..*login --product armorcodex --backend https:\/\/api\.armoriq\.ai/,
  );
  assert.equal(messages.length, 2);
  delete outputs["0"][0].systemMessage;
  assert.deepEqual(outputs["0"], outputs["1"]);
});

test("the worker entry point reads stdin and acknowledges counts against a local server", async (t) => {
  const home = tempHome(t);
  mkdirSync(countsDir(home), { recursive: true });
  const file = countsFile(home, "2026-11-13");
  writeFileSync(file, contract.localCountsLine[0]);
  const requests = [];
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    requests.push({
      method: req.method,
      url: req.url,
      headers: req.headers,
      body: JSON.parse(Buffer.concat(chunks).toString()),
    });
    res.writeHead(204).end();
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const localOrigin = `http://127.0.0.1:${server.address().port}`;
  const preload = path.join(home, "local-fetch.mjs");
  writeFileSync(
    preload,
    `const real = globalThis.fetch;
globalThis.fetch = (url, init) => {
  if (url !== ${JSON.stringify(`${origin}/install-pings`)}) throw new Error('Test blocked external fetch');
  return real(${JSON.stringify(`${localOrigin}/install-pings`)}, init);
};`,
  );
  const transcriptPath = path.join(home, "rollout.jsonl");
  writeFileSync(
    transcriptPath,
    '{"type":"session_meta","payload":{"cli_version":"0.169.0"}}\n',
  );
  const child = spawn(process.execPath, [workerFile], {
    env: {
      HOME: home,
      PATH: process.env.PATH,
      NODE_OPTIONS: `--import=${preload}`,
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  t.after(() => {
    if (child.exitCode === null) child.kill();
  });
  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  child.stdin.end(
    JSON.stringify({ ...workerInput(), day: "2026-11-14", transcriptPath }),
  );
  const [code] = await once(child, "close");
  assert.equal(code, 0, stderr);
  assert.equal(requests.length, 1);
  const [request] = requests;
  assert.equal(request.method, "POST");
  assert.equal(request.url, "/install-pings");
  assert.equal(request.headers.authorization, undefined);
  assert.equal(request.headers["x-api-key"], undefined);
  schema.parse(request.body);
  assert.equal(request.body.hostVersion, "0.169.0");
  assert.deepEqual(request.body.localCounts, [
    { day: "2026-11-13", plans: 1, blocked: 0, held: 0 },
  ]);
  assert.equal(existsSync(file), false);
  assert.equal(existsSync(`${file}.sending`), false);
});

async function hookPathPerformance(t, reporting = false) {
  const timings = [];
  const realSpawn = cp.spawn;
  let home;
  let finished;
  let worker;
  t.mock.method(cp, "spawn", (command, args, options) => {
    const child = realSpawn(command, args, {
      ...options,
      env: { HOME: home, PATH: process.env.PATH, DO_NOT_TRACK: "1" },
    });
    worker = child;
    finished = once(child, "close");
    return child;
  });
  syncBuiltinESMExports();
  t.after(() => {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  });
  for (let run = 0; run < 50; run += 1) {
    home = tempHome(t);
    mkdirSync(countsDir(home), { recursive: true });
    writeFileSync(path.join(countsDir(home), "../notice-shown"), "");
    for (let day = 7; day <= 13; day += 1)
      writeFileSync(
        countsFile(home, `2026-11-${String(day).padStart(2, "0")}`),
        contract.localCountsLine[0].repeat(20000),
      );
    const { spawnWorker, ...deps } = launched(home).deps;
    const runConfig = loadSettings({ HOME: home, ARMORCODEX_DATA_DIR: path.join(home, "data"), ARMORCODEX_RUN_REPORTING_ENABLED: String(reporting) });
    if (reporting) await handleUserPromptSubmit({ session_id: "perf", prompt: "inspect" }, runConfig);
    const started = performance.now();
    const output = reach.withReach("SessionStart", {}, config, undefined, deps);
    const decision = reporting ? await handlePreToolUse({ session_id: "perf", tool_name: "Bash", tool_use_id: `perf-${run}`, tool_input: {} }, runConfig) : denied;
    reach.withReach("PreToolUse", {}, config, decision, deps);
    timings.push(performance.now() - started);
    if (reporting) assert.equal(await withRunState(runConfig, (state) => Object.values(state.runs)[0].tool_calls), 1);
    assert.ok(output.systemMessage.startsWith("ArmorCodex is not signed in"));
    assert.equal(
      readFileSync(countsFile(home, "2026-11-13"), "utf8"),
      contract.localCountsLine[0].repeat(20000),
    );
    assert.ok(finished);
    worker.ref();
    await finished;
  }
  timings.sort((a, b) => a - b);
  const p95 = timings[Math.floor(timings.length * 0.95)];
  assert.ok(p95 < 20, `p95 was ${p95.toFixed(3)} ms`);
}

test("reach work on the hook path including a real spawn stays under 20 ms at the 95th percentile", (t) => hookPathPerformance(t));

// regression: #0013
test("reach work on the hook path including a real spawn stays under 20 ms at the 95th percentile with run reporting on", (t) => hookPathPerformance(t, true));
