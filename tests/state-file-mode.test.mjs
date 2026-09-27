import test from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { writeJson } from "../plugins/armorcodex/scripts/lib/fs-store.mjs";
import { handleUserPromptSubmit } from "../plugins/armorcodex/scripts/lib/engine.mjs";

process.umask(0o022);

async function modeOf(file) {
  return (await stat(file)).mode & 0o777;
}

test("runtime.json holding the prompt is owner-only", async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "armorcodex-mode-"));
  const runtimeFile = path.join(tmp, "runtime.json");
  await handleUserPromptSubmit(
    { hook_event_name: "UserPromptSubmit", session_id: "s-mode", prompt: "deploy with token abc123" },
    {
      mode: "enforce",
      dataDir: tmp,
      policyFile: path.join(tmp, "policy.json"),
      runtimeFile,
      apiKey: "",
      planningEnabled: false,
      contextHintsEnabled: false,
      policyUpdateEnabled: true,
      policyUpdateAllowList: ["*"],
      debug: false
    }
  );
  const saved = JSON.parse(await readFile(runtimeFile, "utf8"));
  assert.equal(saved.sessions["s-mode"].lastPrompt, "deploy with token abc123");
  assert.equal(await modeOf(runtimeFile), 0o600);
});

test("writeJson replaces a world-readable file with an owner-only one", async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "armorcodex-mode-"));
  const file = path.join(tmp, "state.json");
  await writeFile(file, "{}");
  await chmod(file, 0o644);
  await writeJson(file, { secret: "x" });
  assert.equal(await modeOf(file), 0o600);
  assert.deepEqual(JSON.parse(await readFile(file, "utf8")), { secret: "x" });
});
