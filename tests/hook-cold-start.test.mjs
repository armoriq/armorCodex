import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { signIn } from "./helpers/login.mjs";

const HOOK_ROUTER = path.join(path.dirname(fileURLToPath(import.meta.url)), "../plugins/armorcodex/scripts/hook-router.mjs");

const REPORT_SDK_ROOT = `data:text/javascript,${encodeURIComponent(
  'import Module from "node:module";process.on("exit",()=>{for(const k of Object.keys(Module._cache))if(/@armoriq\\/sdk-dev\\/dist\\/index\\.js$|\\/node_modules\\/axios\\//.test(k))process.stderr.write("loaded "+k+"\\n")});'
)}`;

const PAYLOADS = [
  { hook_event_name: "PreToolUse", session_id: "s-cold", tool_name: "Read", tool_input: { file_path: "x.txt" } },
  { hook_event_name: "PostToolUse", session_id: "s-cold", tool_name: "Read", tool_input: { file_path: "x.txt" }, tool_response: {} },
  { hook_event_name: "UserPromptSubmit", session_id: "s-cold", prompt: "hi" }
];

// Port 9 refuses connections, so a signed-in hook that reaches the network fails fast.
const BACKEND = "http://127.0.0.1:9";

async function runCold(payload, { signedIn }) {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "armorcodex-cold-"));
  const env = { PATH: process.env.PATH, HOME: dataDir, ARMORCODEX_DATA_DIR: dataDir };
  if (signedIn) {
    signIn(dataDir, { backend: BACKEND, apiKey: "ak_test_coldstart0000000000000000000" });
    Object.assign(env, { BACKEND_ENDPOINT: BACKEND, IAP_ENDPOINT: BACKEND, PROXY_ENDPOINT: BACKEND });
  } else {
    env.ARMORIQ_API_KEY = "";
  }
  const child = spawn(process.execPath, ["--import", REPORT_SDK_ROOT, HOOK_ROUTER], { env });
  let stderr = "";
  child.stderr.on("data", (c) => (stderr += c));
  child.stdout.resume();
  child.stdin.end(JSON.stringify(payload));
  const code = await new Promise((resolve) => child.once("close", resolve));
  assert.equal(code, 0, stderr);
  assert.doesNotMatch(stderr, /loaded /);
  return dataDir;
}

for (const payload of PAYLOADS) {
  test(`${payload.hook_event_name} loads neither the SDK root nor axios`, () => runCold(payload, { signedIn: false }));
}

// UserPromptSubmit needs the SDK client when signed in, by design.
test("PreToolUse signed in loads neither the SDK root nor axios", () => runCold(PAYLOADS[0], { signedIn: true }));

test("PostToolUse signed in writes its audit row without the SDK root or axios", async () => {
  const dataDir = await runCold(PAYLOADS[1], { signedIn: true });
  const rows = (await readFile(path.join(dataDir, "audit", "current.jsonl"), "utf8")).split("\n").filter(Boolean);
  assert.equal(rows.length, 1);
});
