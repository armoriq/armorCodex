import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadConfig } from "../plugins/armorcodex/scripts/lib/config.mjs";
import { handlePreToolUse } from "../plugins/armorcodex/scripts/lib/engine.mjs";

const home = mkdtempSync(path.join(os.tmpdir(), "armorcodex-guard-home-"));
const workDir = mkdtempSync(path.join(os.tmpdir(), "armorcodex-guard-work-"));
const savedHome = process.env.HOME;
let config;

before(() => {
  process.env.HOME = home;
  assert.equal(os.homedir(), home);
  config = {
    ...loadConfig({ ARMORCODEX_MODE: "monitor", ARMORCODEX_INTENT_REQUIRED: "false", ARMORCODEX_MCP_DENY_BY_DEFAULT: "false" }),
    apiKey: "",
    useSdkIntent: false,
    intentEndpoint: "",
    verifyStepEndpoint: ""
  };
  assert.equal(config.mode, "monitor");
  assert.equal(config.dataDir, path.join(home, ".codex", "armorcodex"));
  mkdirSync(config.dataDir, { recursive: true });
  mkdirSync(path.join(home, ".armoriq"), { recursive: true });
  writeFileSync(path.join(home, ".armoriq", "credentials.json"), "{}");
});
after(() => {
  process.env.HOME = savedHome;
});

async function toolDecision(tool_name, tool_input, cwd = workDir) {
  const out = await handlePreToolUse(
    { hook_event_name: "PreToolUse", session_id: "guard", tool_name, tool_input, ...(cwd ? { cwd } : {}) },
    config
  );
  return out?.hookSpecificOutput?.permissionDecision ?? "allow";
}

const decision = (command) => toolDecision("Bash", { command });
const data = () => config.dataDir;
const patch = (header) => ({ command: `*** Begin Patch\n${header}\n+{}\n*** End Patch` });

const ALLOWED = [
  () => "cat ~/.armoriq/credentials.json",
  () => "cp ~/.armoriq/credentials.json /tmp/creds-copy",
  () => `echo done > notes.txt && cat ${data()}/policy.json`,
  () => "ls ~/.armoriq 2>&1 | head",
  () => "cp notes.txt ~/",
  () => "mv notes.txt ~",
  () => "rm -rf ~/projects/old node_modules",
  () => "rm -f ./build/*.o",
  () => 'for f in *.log; do rm "$f"; done',
  () => "date > last-clean.txt",
  () => `grep -n stageAndFormat ${data()}/../plugins/armorcodex/scripts/lib/armor-policy-commands.mjs`,
  () => "node scripts/writeJson.mjs out/report.json",
  () => "echo $(date) > build.log",
  () => "bash -c 'echo hi > notes.txt'",
  () => "if true; then rm -f notes.txt; fi"
];

const DENIED = [
  () => `date > ${data()}/last-clean.txt`,
  () => `printf '{"sessions":{}}' > ${data()}/runtime.json`,
  () => `printf '{}' > ${data()}/policy.json`,
  () => `cp /tmp/evil.json ${data()}/policy-pending.json`,
  () => `tee ${data()}/policy.json < /dev/null`,
  () => `sed -i '' s/a/b/ ${data()}/policy.json`,
  () => `rm -rf ${data()}`,
  () => `mv ${data()} /tmp/x`,
  () => "cd ~/.codex/armorcodex && rm policy.json",
  () => "rm -rf ~/.codex",
  () => "echo x > ~/.armoriq/credentials.json",
  () => 'echo {} >> "$HOME/.armoriq/credentials.json"',
  () => "mv ~/.armoriq/credentials.json /tmp/x",
  () => "sudo -u root rm ~/.armoriq/credentials.json",
  () => "echo ~/.armoriq/credentials.json | xargs rm",
  () => "rm -rf ~/.codex/arm*",
  () => "f=policy; rm ~/.codex/armorcodex/$f.json",
  () => "rm ~/.codex/$x",
  () => "if true; then rm ~/.codex/armorcodex/policy.json; fi",
  () => "for x in 1; do rm ~/.armoriq/credentials.json; done",
  () => "! rm ~/.codex/armorcodex/policy.json",
  () => "echo $(rm ~/.codex/armorcodex/policy.json)",
  () => "echo `rm ~/.codex/armorcodex/policy.json`",
  () => "bash -c 'echo {} > ~/.codex/armorcodex/policy.json'",
  () => "sh -lc \"rm ~/.armoriq/credentials.json\"",
  () => `touch ${data()}/pending-plan.guard.json`,
  () => `unlink ${data()}/policy.json`,
  () => `mkdir ${data()}/policy-holds`,
  () => "ln -s ~/.codex/armorcodex d && echo {} > d/policy.json",
  () => `ln -s ${data()}/policy.json ./settings-link.json`
];

for (const command of ALLOWED) {
  test(`a shell command that writes no ArmorCodex file runs: ${command()}`, async () => {
    assert.equal(await decision(command()), "allow");
  });
}

for (const command of DENIED) {
  test(`a shell write to ArmorCodex policy, state or credentials is denied, even in monitor mode: ${command()}`, async () => {
    assert.equal(await decision(command()), "deny");
  });
}

const ADMIN_DENIED = [
  `node -e "import('./scripts/lib/armor-policy-commands.mjs').then((m) => m.handleArmorPolicyCommand('armor policy confirm p1'))"`,
  "node plugins/armorcodex/scripts/lib/armor-policy-commands.mjs confirm",
  'echo "applyPolicyCommand" | node'
];

for (const command of ADMIN_DENIED) {
  test(`running the policy handler from the shell is denied: ${command}`, async () => {
    assert.equal(await decision(command), "deny");
  });
}

for (const header of [
  () => `  *** Add File: ${data()}/policy.json`,
  () => `\t*** Update File: ${data()}/runtime.json`,
  () => `*** Add File: ${data()}/NOTES.md`,
  () => `*** Update File: ${data()}/policy.json`,
  () => `*** Delete File: ${data()}/runtime.json`,
  () => `*** Update File: ${workDir}/a.txt\n*** Move to: ${data()}/policy.json`,
  () => `*** Update File: ${home}/.armoriq/credentials.json`
]) {
  test(`apply_patch to ArmorCodex policy, state or credentials is denied: ${header().split("\n").at(-1)}`, async () => {
    assert.equal(await toolDecision("apply_patch", patch(header())), "deny");
  });
}

test("apply_patch resolves a relative path against the session cwd", async () => {
  assert.equal(await toolDecision("apply_patch", patch("*** Add File: policy.json"), data()), "deny");
  assert.equal(await toolDecision("apply_patch", patch("*** Add File: policy.json"), workDir), "allow");
});

test("apply_patch without a session cwd still catches a protected file name", async () => {
  assert.equal(await toolDecision("apply_patch", patch("*** Update File: runtime.json"), null), "deny");
  assert.equal(await toolDecision("apply_patch", patch("*** Update File: README.md"), null), "allow");
});

test("a patch header past the sanitizer's length limit is still checked", async () => {
  const long = `*** Begin Patch\n*** Update File: ${workDir}/a.txt\n${"+x\n".repeat(2000)}*** Add File: ${data()}/policy.json\n+{}\n*** End Patch`;
  assert.equal(await toolDecision("apply_patch", { command: long }), "deny");
});

test("a symlink in the workspace that points at policy.json does not get past the guard", async () => {
  writeFileSync(path.join(data(), "policy.json"), "{}");
  const link = path.join(workDir, "settings.json");
  symlinkSync(path.join(data(), "policy.json"), link);
  assert.equal(await decision("echo '{}' > settings.json"), "deny");
  assert.equal(await toolDecision("apply_patch", patch("*** Update File: settings.json")), "deny");
  assert.equal(readFileSync(link, "utf8"), "{}");
});

test("the guard matches through a symlinked temp directory", async () => {
  const real = realpathSync(data());
  assert.equal(await decision(`echo x > ${real}/runtime.json`), "deny");
});

test("an apply_patch outside ArmorCodex files runs", async () => {
  assert.equal(await toolDecision("apply_patch", patch(`*** Add File: ${workDir}/notes.md`)), "allow");
});

test("a variable target is not taken as a protected file when cwd is the home directory", async () => {
  for (const command of ['rm -f "$tmpfile"', 'echo hi > "$LOG"', 'cp a.txt "$OUT"', 'mv "$f" "$f.bak"']) {
    assert.equal(await toolDecision("Bash", { command }, home), "allow", command);
  }
});
