import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const router = fileURLToPath(new URL("../plugins/armorcodex/scripts/hook-router.mjs", import.meta.url));
const hookStdout = new URL("../plugins/armorcodex/scripts/lib/hook-stdout.mjs", import.meta.url).href;

test("only emitJson reaches stdout once the hook claims it", () => {
  const script = `
    const { emitJson } = await import(${JSON.stringify(hookStdout)});
    console.log("console.log line");
    console.info("console.info line");
    process.stdout.write("direct stdout write\\n");
    emitJson({ decision: "allow" });
  `;
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
    encoding: "utf8",
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, '{"decision":"allow"}\n');
  assert.match(result.stderr, /console\.log line\nconsole\.info line\ndirect stdout write\n/);
});

test("PreToolUse stdout is only the decision JSON while the SDK logs", (t) => {
  const home = mkdtempSync(path.join(tmpdir(), "armorcodex-stdout-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const unreachable = "http://127.0.0.1:1";
  const result = spawnSync(process.execPath, [router], {
    input: JSON.stringify({
      hook_event_name: "PreToolUse",
      session_id: "stdout-session",
      tool_name: "Bash",
      tool_input: { command: "ls" },
    }),
    encoding: "utf8",
    timeout: 30_000,
    env: {
      PATH: process.env.PATH,
      HOME: home,
      CODEX_HOME: path.join(home, ".codex"),
      ARMORCODEX_DATA_DIR: path.join(home, "data"),
      ARMORIQ_API_KEY: "ak_test_stdout",
      ARMORCODEX_MODE: "enforce",
      ARMORCODEX_BACKEND_ENDPOINT: unreachable,
      ARMORCODEX_IAP_ENDPOINT: unreachable,
      ARMORCODEX_PROXY_ENDPOINT: unreachable,
      ARMORCODEX_MAX_RETRIES: "0",
      ARMORCODEX_OBSERVABILITY_DISABLED: "1",
      ARMORCODEX_USAGE_SYNC_DISABLED: "1",
    },
  });

  assert.equal(result.status, 0, result.stderr);
  const decision = JSON.parse(result.stdout);
  assert.equal(decision.hookSpecificOutput.hookEventName, "PreToolUse");
  assert.equal(decision.hookSpecificOutput.permissionDecision, "deny");
});
