import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { hooksToTrust, trustArmorCodexHooks, trustEdits } from "../plugins/armorcodex/scripts/lib/hook-trust.mjs";

const HOOKS_FILE = "/home/u/.codex/hooks.json";
const BOOTSTRAP = "/home/u/.armoriq/armorCodex/plugins/armorcodex/scripts/bootstrap.mjs";
const OURS = `node ${BOOTSTRAP} router`;

function hook(overrides) {
  return {
    handlerType: "command",
    command: OURS,
    sourcePath: HOOKS_FILE,
    source: "user",
    trustStatus: "untrusted",
    currentHash: "sha256:aa",
    eventName: "stop",
    key: `${HOOKS_FILE}:stop:0:0`,
    ...overrides
  };
}

test("only ArmorCodex's own untrusted or modified hooks from the global file are picked", () => {
  const listed = {
    data: [
      {
        cwd: "/home/u",
        hooks: [
          hook({}),
          hook({ key: `${HOOKS_FILE}:session_start:0:0`, eventName: "sessionStart", trustStatus: "modified", currentHash: "sha256:bb" }),
          hook({ key: `${HOOKS_FILE}:stop:1:0`, command: "echo someone-else" }),
          hook({ key: "/repo/.codex/hooks.json:stop:0:0", sourcePath: "/repo/.codex/hooks.json" }),
          hook({ key: `${HOOKS_FILE}:post_tool_use:0:0`, trustStatus: "trusted" }),
          hook({ key: `${HOOKS_FILE}:pre_tool_use:0:0`, trustStatus: "managed" })
        ]
      },
      { cwd: "/elsewhere", hooks: [hook({})] }
    ]
  };

  assert.deepEqual(hooksToTrust(listed, { hooksFile: HOOKS_FILE, bootstrapPath: BOOTSTRAP }), [
    { key: `${HOOKS_FILE}:stop:0:0`, currentHash: "sha256:aa", eventName: "stop" },
    { key: `${HOOKS_FILE}:session_start:0:0`, currentHash: "sha256:bb", eventName: "sessionStart" }
  ]);
});

test("trust is written under hooks.state as one table, since hook keys contain dots", () => {
  assert.deepEqual(trustEdits([]), []);
  assert.deepEqual(trustEdits([{ key: `${HOOKS_FILE}:stop:0:0`, currentHash: "sha256:aa" }]), [
    {
      keyPath: "hooks.state",
      mergeStrategy: "upsert",
      value: { [`${HOOKS_FILE}:stop:0:0`]: { trusted_hash: "sha256:aa" } }
    }
  ]);
});

/**
 * Speaks the app-server's newline-delimited JSON-RPC. A hook reads as trusted
 * once a batchWrite has recorded its current hash, as Codex does.
 */
function fakeCodex(root, { failList = false } = {}) {
  const writes = join(root, "writes.json");
  const bin = join(root, "codex");
  writeFileSync(
    bin,
    `#!/usr/bin/env node
const fs = require("node:fs");
const writes = ${JSON.stringify(writes)};
const recorded = () => (fs.existsSync(writes) ? JSON.parse(fs.readFileSync(writes, "utf8")) : []);
const hooks = ${JSON.stringify([hook({}), hook({ key: `${HOOKS_FILE}:stop:1:0`, command: "echo someone-else" })])};
if (process.argv[2] !== "app-server") process.exit(2);
let buffer = "";
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let i;
  while ((i = buffer.indexOf("\\n")) !== -1) {
    const msg = JSON.parse(buffer.slice(0, i));
    buffer = buffer.slice(i + 1);
    if (msg.id === undefined) continue;
    const reply = (result) => process.stdout.write(JSON.stringify({ id: msg.id, result }) + "\\n");
    if (msg.method === "initialize") reply({});
    else if (msg.method === "hooks/list") {
      if (${failList}) { process.stdout.write(JSON.stringify({ id: msg.id, error: { message: "boom" } }) + "\\n"); continue; }
      const state = Object.assign({}, ...recorded().map((e) => e.value));
      reply({ data: [{ cwd: msg.params.cwds[0], errors: [], warnings: [], hooks: hooks.map((h) =>
        state[h.key]?.trusted_hash === h.currentHash ? { ...h, trustStatus: "trusted" } : h) }] });
    } else if (msg.method === "config/batchWrite") {
      fs.writeFileSync(writes, JSON.stringify([...recorded(), ...msg.params.edits]));
      reply({ status: "ok" });
    }
  }
});
`
  );
  chmodSync(bin, 0o755);
  return { bin, writes };
}

test("trustArmorCodexHooks records trust through the app-server and confirms it", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "armorcodex-trust-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const { bin, writes } = fakeCodex(root);

  const first = await trustArmorCodexHooks({ hooksFile: HOOKS_FILE, bootstrapPath: BOOTSTRAP, codexBin: bin, cwd: root });
  assert.deepEqual(first, { trusted: ["stop"], total: 1, untrusted: [] });
  const edits = JSON.parse(readFileSync(writes, "utf8"));
  assert.deepEqual(Object.keys(edits[0].value), [`${HOOKS_FILE}:stop:0:0`], "another tool's hook is not trusted");

  const second = await trustArmorCodexHooks({ hooksFile: HOOKS_FILE, bootstrapPath: BOOTSTRAP, codexBin: bin, cwd: root });
  assert.deepEqual(second, { trusted: [], total: 1, untrusted: [] });
  assert.equal(JSON.parse(readFileSync(writes, "utf8")).length, 1, "nothing is rewritten once trusted");
});

test("an app-server error or a missing codex rejects instead of hanging", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "armorcodex-trust-fail-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const { bin, writes } = fakeCodex(root, { failList: true });

  await assert.rejects(
    trustArmorCodexHooks({ hooksFile: HOOKS_FILE, bootstrapPath: BOOTSTRAP, codexBin: bin, cwd: root }),
    /boom/
  );
  assert.equal(existsSync(writes), false);
  await assert.rejects(
    trustArmorCodexHooks({ hooksFile: HOOKS_FILE, bootstrapPath: BOOTSTRAP, codexBin: join(root, "missing"), cwd: root })
  );
});
