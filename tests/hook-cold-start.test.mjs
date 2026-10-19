import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HOOK_ROUTER = path.join(path.dirname(fileURLToPath(import.meta.url)), "../plugins/armorcodex/scripts/hook-router.mjs");

const REPORT_SDK_ROOT = `data:text/javascript,${encodeURIComponent(
  'import Module from "node:module";process.on("exit",()=>{for(const k of Object.keys(Module._cache))if(/@armoriq\\/sdk-dev\\/dist\\/index\\.js$|\\/node_modules\\/axios\\//.test(k))process.stderr.write("loaded "+k+"\\n")});'
)}`;

for (const payload of [
  { hook_event_name: "PreToolUse", session_id: "s-cold", tool_name: "Read", tool_input: { file_path: "x.txt" } },
  { hook_event_name: "PostToolUse", session_id: "s-cold", tool_name: "Read", tool_input: { file_path: "x.txt" }, tool_response: {} },
  { hook_event_name: "UserPromptSubmit", session_id: "s-cold", prompt: "hi" }
]) {
  test(`${payload.hook_event_name} loads neither the SDK root nor axios`, async () => {
    const dataDir = await mkdtemp(path.join(os.tmpdir(), "armorcodex-cold-"));
    const child = spawn(process.execPath, ["--import", REPORT_SDK_ROOT, HOOK_ROUTER], {
      env: { PATH: process.env.PATH, HOME: dataDir, ARMORCODEX_DATA_DIR: dataDir, ARMORIQ_API_KEY: "" }
    });
    let stderr = "";
    child.stderr.on("data", (c) => (stderr += c));
    child.stdout.resume();
    child.stdin.end(JSON.stringify(payload));
    const code = await new Promise((resolve) => child.once("close", resolve));
    assert.equal(code, 0, stderr);
    assert.doesNotMatch(stderr, /loaded /);
  });
}
