import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import fs, {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import * as reach from "../plugins/armorcodex/scripts/lib/reach.mjs";

const contract = JSON.parse(
  readFileSync(new URL("./fixtures/install-ping-v1.json", import.meta.url))
);
const origin = contract.origins.production[0];
const config = { backendEndpoint: origin, apiKey: "" };
const reachUrl = new URL("../plugins/armorcodex/scripts/lib/reach.mjs", import.meta.url).href;
const reminderPattern =
  /^ArmorCodex is not signed in to ArmorIQ\..*login --product armorcodex --backend https:\/\/api\.armoriq\.ai \(hide this reminder: ARMORIQ_SIGNIN_REMINDER_DISABLED=1\)$/;
const dirFor = (home, environment = "production") =>
  path.join(home, ".armoriq/reach/v1/armorcodex", environment);
const noticeFile = (home) => path.join(dirFor(home, ""), "notice-shown");

function tempHome(t) {
  const home = mkdtempSync(path.join(tmpdir(), "signin-reminder-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  return home;
}

function depsFor(home, overrides = {}) {
  return {
    home,
    env: {},
    now: () => Date.parse("2026-11-14T23:59:59.999Z"),
    spawnWorker: () => {},
    ...overrides,
  };
}

test("the notice appears once per home across environments and respects ping opt outs", (t) => {
  const home = tempHome(t);
  const signedIn = { ...config, apiKey: "ak_test_signed" };
  const deps = depsFor(home);
  assert.deepEqual(reach.withReach("SessionStart", {}, signedIn, undefined, deps), {
    systemMessage: contract.notice,
  });
  assert.equal(lstatSync(noticeFile(home)).mode & 0o777, 0o600);
  for (const backendEndpoint of Object.values(contract.origins).flat()) {
    assert.equal(
      reach.withReach("SessionStart", {}, { ...signedIn, backendEndpoint }, null, deps),
      null
    );
  }
  for (const vector of contract.optOut.testVectors.filter((row) => !row.plugin && !row.enabled)) {
    const optedOut = tempHome(t);
    if (
      vector.settings !== null ||
      Object.hasOwn(vector, "settingsJson") ||
      vector.settingsReadable === false
    ) {
      mkdirSync(path.join(optedOut, ".armoriq"), { recursive: true });
      const file = path.join(optedOut, ".armoriq/settings.json");
      const value = Object.hasOwn(vector, "settingsJson")
        ? vector.settingsJson
        : vector.settings ?? {};
      writeFileSync(file, value === "malformed" ? "{" : JSON.stringify(value));
      if (vector.settingsReadable === false) chmodSync(file, 0);
    }
    const output = { systemMessage: "kept" };
    assert.equal(
      reach.withReach("SessionStart", {}, signedIn, output, depsFor(optedOut, { env: vector.env })),
      output,
      JSON.stringify(vector)
    );
    assert.equal(existsSync(noticeFile(optedOut)), false, JSON.stringify(vector));
  }
});

test("the first session joins the notice and reminder after existing output without changing model context", (t) => {
  for (const output of [
    undefined,
    {
      systemMessage: "Existing notice",
      hookSpecificOutput: { additionalContext: "model context" },
      continue: true,
    },
  ]) {
    const home = tempHome(t);
    const result = reach.withReach("SessionStart", {}, config, output, depsFor(home));
    const messages = result.systemMessage.split("\n\n");
    if (output) assert.equal(messages.shift(), output.systemMessage);
    assert.equal(messages.shift(), contract.notice);
    assert.match(messages.shift(), reminderPattern);
    assert.equal(messages.length, 0);
    const { systemMessage, ...rest } = result;
    const { systemMessage: previous, ...expected } = output ?? {};
    assert.deepEqual(rest, expected);
    assert.equal(result.hookSpecificOutput, output?.hookSpecificOutput);
    assert.equal(reach.withReach("SessionStart", {}, config, output, depsFor(home)), output);
  }
});

test("the reminder uses one UTC date, survives clock rollback and prunes only its old dated files", (t) => {
  const home = tempHome(t);
  const dir = dirFor(home);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const kept = [
    "reminder-2026-10-15",
    "reminder-2026-02-30",
    "reminder-2026-12-01",
    "ping-2026-10-14",
    "counts-2026-10-14.ndjson",
  ];
  for (const file of [...kept, "reminder-2026-10-14"]) writeFileSync(path.join(dir, file), "");
  let reads = 0;
  const deps = depsFor(home, {
    env: { DO_NOT_TRACK: "1" },
    now: () => {
      reads += 1;
      return Date.parse("2026-11-14T23:59:59.999Z");
    },
  });
  assert.match(reach.withReach("SessionStart", {}, config, null, deps).systemMessage, reminderPattern);
  assert.equal(reads, 1);
  assert.equal(lstatSync(path.join(dir, "reminder-2026-11-14")).mode & 0o777, 0o600);
  assert.equal(lstatSync(dir).mode & 0o777, 0o700);
  assert.equal(existsSync(path.join(dir, "reminder-2026-10-15")), true);
  assert.equal(reach.withReach("SessionStart", {}, config, null, deps), null);
  assert.match(
    reach.withReach("SessionStart", {}, config, null, {
      ...deps,
      now: () => Date.parse("2026-11-15T00:00:00Z"),
    }).systemMessage,
    reminderPattern
  );
  assert.equal(reach.withReach("SessionStart", {}, config, null, deps), null);
  assert.deepEqual(
    readdirSync(dir).sort(),
    [
      ...kept.filter((file) => file !== "reminder-2026-10-15"),
      "reminder-2026-11-14",
      "reminder-2026-11-15",
    ].sort()
  );
  const staging = { ...config, backendEndpoint: "https://staging-api.armoriq.ai" };
  assert.match(
    reach.withReach("SessionStart", {}, staging, null, deps).systemMessage,
    /--backend https:\/\/staging-api\.armoriq\.ai/
  );
  assert.equal(
    reach.withReach("SessionStart", {}, { ...staging, backendEndpoint: "https://staging-api.armoriq.io" }, null, deps),
    null
  );
  assert.equal(existsSync(path.join(home, ".armoriq/install-id")), false);
  assert.equal(existsSync(noticeFile(home)), false);
});

test("the reminder follows its own settings independently of ping consent", (t) => {
  for (const [name, contents, env, enabled] of [
    ["missing", undefined, {}, true],
    ["enabled", '{"signInReminder":true}', {}, true],
    ["unrelated", '{"usagePing":false}', {}, true],
    ["false", '{"signInReminder":false}', {}, false],
    ["malformed", "{", {}, false],
    ["null", "null", {}, false],
    ["array", "[]", {}, false],
    ["number", "1", {}, false],
    ["non boolean", '{"signInReminder":"true"}', {}, false],
    ["unreadable", "{}", {}, false],
    ...["1", " TrUe ", " YES "].map((value) => [
      value, undefined, { ARMORIQ_SIGNIN_REMINDER_DISABLED: value }, false,
    ]),
    ["env false", undefined, { ARMORIQ_SIGNIN_REMINDER_DISABLED: "false" }, true],
    ["ping env", undefined, { ARMORIQ_USAGE_PING_DISABLED: "1" }, true],
  ]) {
    const home = tempHome(t);
    if (contents !== undefined) {
      mkdirSync(path.join(home, ".armoriq"));
      const file = path.join(home, ".armoriq/settings.json");
      writeFileSync(file, contents);
      if (name === "unreadable") chmodSync(file, 0);
    }
    const result = reach.withReach(
      "SessionStart", {}, config, null,
      depsFor(home, { env: { DO_NOT_TRACK: "1", ...env } })
    );
    if (enabled) assert.match(result.systemMessage, reminderPattern, name);
    else assert.equal(result, null, name);
    assert.equal(existsSync(path.join(dirFor(home), "reminder-2026-11-14")), enabled, name);
    assert.equal(existsSync(path.join(home, ".armoriq/install-id")), false, name);
  }
});

test("messages do not claim on other events or backends, and signed in sessions get no reminder", (t) => {
  for (const [event, overrides, env] of [
    ["UserPromptSubmit", {}, {}],
    ["PreToolUse", {}, {}],
    ["SessionStart", { backendEndpoint: "https://custom.example.test" }, {}],
    ["SessionStart", { apiKey: "ak_test_signed" }, { DO_NOT_TRACK: "1" }],
  ]) {
    const home = tempHome(t);
    const output = { systemMessage: "kept", hookSpecificOutput: { additionalContext: "context" } };
    assert.equal(
      reach.withReach(event, {}, { ...config, ...overrides }, output, depsFor(home, { env })),
      output
    );
    assert.equal(existsSync(noticeFile(home)), false);
    assert.equal(existsSync(path.join(dirFor(home), "reminder-2026-11-14")), false);
  }
});

// regression: #0016
test("credential read failures suppress the reminder without suppressing the notice", (t) => {
  for (const kind of ["readable", "unreadable", "malformed", "directory"]) {
    const home = tempHome(t);
    const file = path.join(home, ".armoriq/credentials.json");
    mkdirSync(path.dirname(file), { recursive: true });
    if (kind === "directory") mkdirSync(file);
    else {
      writeFileSync(file, kind === "malformed" ? "{" : '{"version":2,"profiles":{}}');
      if (kind === "unreadable") chmodSync(file, 0);
    }
    const result = reach.withReach("SessionStart", {}, config, null, depsFor(home));
    if (kind === "readable") {
      const [notice, reminder] = result.systemMessage.split("\n\n");
      assert.equal(notice, contract.notice);
      assert.match(reminder, reminderPattern);
    } else assert.equal(result.systemMessage, contract.notice, kind);
    assert.equal(existsSync(path.join(dirFor(home), "reminder-2026-11-14")), kind === "readable", kind);
  }
});

test("a failed claim leaves the other message available", (t) => {
  const original = fs.openSync;
  let blocked;
  let code;
  let blockAll = false;
  t.mock.method(fs, "openSync", (file, ...args) => {
    if (
      blockAll ||
      (blocked === "notice"
        ? String(file).endsWith("notice-shown")
        : path.basename(file).startsWith("reminder-"))
    )
      throw Object.assign(new Error(code), { code });
    return original(file, ...args);
  });
  syncBuiltinESMExports();
  t.after(() => {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  });
  for (blocked of ["notice", "reminder"]) {
    for (code of ["EEXIST", "EACCES"]) {
      const result = reach.withReach("SessionStart", {}, config, null, depsFor(tempHome(t)));
      if (blocked === "notice") assert.match(result.systemMessage, reminderPattern);
      else assert.equal(result.systemMessage, contract.notice);
    }
  }
  blockAll = true;
  const output = { hookSpecificOutput: { additionalContext: "unchanged" } };
  assert.equal(reach.withReach("SessionStart", {}, config, output, depsFor(tempHome(t))), output);
});

test("racing hooks show each message once", async (t) => {
  const home = tempHome(t);
  const source = `import { withReach } from ${JSON.stringify(reachUrl)};
    process.send('ready'); process.once('message', () => {
      process.stdout.write(JSON.stringify(withReach('SessionStart', {}, ${JSON.stringify(config)}, {}, {
        home: process.env.HOME, env: {}, now: () => Date.parse('2026-11-14T00:00:00Z'), spawnWorker: () => {}
      }))); process.disconnect();
    });`;
  const children = Array.from({ length: 4 }, () =>
    spawn(process.execPath, ["--input-type=module", "-e", source], {
      env: { PATH: process.env.PATH, HOME: home },
      stdio: ["ignore", "pipe", "pipe", "ipc"],
    })
  );
  t.after(() => children.forEach((child) => {
    if (child.exitCode === null) child.kill();
  }));
  const results = children.map(async (child) => {
    let output = "";
    child.stdout.on("data", (chunk) => {
      output += chunk;
    });
    const [code] = await once(child, "close");
    assert.equal(code, 0);
    return JSON.parse(output).systemMessage ?? "";
  });
  await Promise.all(children.map((child) => once(child, "message")));
  children.forEach((child) => child.send("go"));
  const messages = (await Promise.all(results))
    .flatMap((value) => value.split("\n\n"))
    .filter(Boolean);
  assert.equal(messages.filter((value) => value === contract.notice).length, 1);
  assert.equal(messages.filter((value) => reminderPattern.test(value)).length, 1);
});

test("login commands select an executable at print time and run from another directory with a bare quoted origin", async (t) => {
  const { dependencies } = JSON.parse(readFileSync(new URL("../plugins/armorcodex/package.json", import.meta.url), "utf8"));
  const sdk = dependencies["@armoriq/sdk-dev"] ? "@armoriq/sdk-dev" : "@armoriq/sdk";
  const cli = sdk === "@armoriq/sdk-dev" ? "armoriq-dev" : "armoriq";
  const home = tempHome(t);
  const bin = path.join(home, "bin");
  mkdirSync(bin);
  const log = path.join(home, "argv.json");
  for (const name of [cli, "npx"]) {
    writeFileSync(
      path.join(bin, name),
      `#!${process.execPath}\nrequire('node:fs').writeFileSync(${JSON.stringify(log)}, JSON.stringify(process.argv.slice(2)));\n`
    );
    chmodSync(path.join(bin, name), 0o755);
  }
  const previous = process.env.PATH;
  t.after(() => {
    process.env.PATH = previous;
  });
  process.env.PATH = bin;
  for (const [available, backend, prefix, originArgument] of [
    [true, "https://staging-api.armoriq.ai", cli, "https://staging-api.armoriq.ai"],
    [false, origin, `npx -y ${sdk}`, origin],
    [
      false,
      "https://user:private@custom.example.test:8443/path?token=private#hash",
      `npx -y ${sdk}`,
      "'https://custom.example.test:8443'",
    ],
  ]) {
    chmodSync(path.join(bin, cli), available ? 0o755 : 0o644);
    const command = reach.loginCommand(backend);
    assert.equal(command, `${prefix} login --product armorcodex --backend ${originArgument}`);
    const child = spawn("/bin/sh", ["-c", command], {
      cwd: home,
      env: { PATH: bin, HOME: home },
      stdio: "ignore",
    });
    const [code] = await once(child, "close");
    assert.equal(code, 0);
    assert.deepEqual(JSON.parse(readFileSync(log, "utf8")), [
      ...(available ? [] : ["-y", sdk]),
      "login", "--product", "armorcodex", "--backend",
      originArgument.replaceAll("'", ""),
    ]);
    if (available) {
      const result = reach.withReach(
        "SessionStart", {}, { ...config, backendEndpoint: backend }, null,
        depsFor(tempHome(t), { env: { DO_NOT_TRACK: "1" } })
      );
      assert.ok(result.systemMessage.includes(command));
    }
  }
});
