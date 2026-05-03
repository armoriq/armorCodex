import test from "node:test";
import assert from "node:assert/strict";
import {
  isMatcherSpec,
  matchesScalar,
  matchParams,
  matchesAnyStringField
} from "../scripts/lib/common.mjs";
import { evaluatePolicy, parsePolicyTextCommand } from "../scripts/lib/policy.mjs";

// ---------------------------------------------------------------------------
// matchesScalar — operator coverage
// ---------------------------------------------------------------------------

test("matchesScalar plain literal exact", () => {
  assert.equal(matchesScalar("ls /etc", "ls /etc"), true);
  assert.equal(matchesScalar("ls /etc", "ls /tmp"), false);
});

test("matchesScalar $contains case-insensitive", () => {
  assert.equal(matchesScalar({ $contains: ".SSH" }, "ls ~/.ssh"), true);
  assert.equal(matchesScalar({ $contains: ".ssh" }, "ls /tmp"), false);
});

test("matchesScalar $startsWith / $endsWith", () => {
  assert.equal(matchesScalar({ $startsWith: "rm " }, "rm -rf /"), true);
  assert.equal(matchesScalar({ $startsWith: "rm " }, "ls"), false);
  assert.equal(matchesScalar({ $endsWith: ".pem" }, "/keys/id_rsa.pem"), true);
  assert.equal(matchesScalar({ $endsWith: ".pem" }, "/keys/id_rsa"), false);
});

test("matchesScalar $matches regex", () => {
  assert.equal(matchesScalar({ $matches: "id_(rsa|ed25519)" }, "/.ssh/id_ed25519"), true);
  assert.equal(matchesScalar({ $matches: "id_(rsa|ed25519)" }, "/.ssh/known_hosts"), false);
});

test("matchesScalar $pathContains canonicalizes ~/ and $HOME", () => {
  // Rule mentions ~/.ssh, actual path is /Users/foo/.ssh
  assert.equal(
    matchesScalar({ $pathContains: "~/.ssh" }, "/Users/alice/.ssh/id_rsa"),
    true
  );
  // /home/<user> form too
  assert.equal(
    matchesScalar({ $pathContains: "~/.ssh" }, "/home/bob/.ssh/known_hosts"),
    true
  );
  // Doesn't match unrelated path
  assert.equal(
    matchesScalar({ $pathContains: "~/.ssh" }, "/etc/hosts"),
    false
  );
});

test("matchesScalar $pathContains with $HOME prefix", () => {
  assert.equal(
    matchesScalar({ $pathContains: "$HOME/.aws" }, "/Users/alice/.aws/credentials"),
    true
  );
});

test("isMatcherSpec recognizes operator objects", () => {
  assert.equal(isMatcherSpec({ $contains: "x" }), true);
  assert.equal(isMatcherSpec({ command: "x" }), false);
  assert.equal(isMatcherSpec("plain string"), false);
  assert.equal(isMatcherSpec(null), false);
  assert.equal(isMatcherSpec({}), false);
});

// ---------------------------------------------------------------------------
// matchParams — recursive, surfaces missingKeys
// ---------------------------------------------------------------------------

test("matchParams plain literal exact (back-compat)", () => {
  const result = matchParams({ command: "ls" }, { command: "ls" });
  assert.equal(result.matched, true);
});

test("matchParams operator on nested key", () => {
  const result = matchParams(
    { command: { $contains: ".ssh" } },
    { command: "ls -la ~/.ssh" }
  );
  assert.equal(result.matched, true);
});

test("matchParams reports missing keys (rule key not in tool input)", () => {
  const result = matchParams(
    { pathContains: "/.ssh" },
    { command: "ls" } // no pathContains key
  );
  assert.equal(result.matched, false);
  assert.deepEqual(result.missingKeys, ["pathContains"]);
});

test("matchParams missing keys for operator-spec values too", () => {
  const result = matchParams(
    { file_path: { $contains: ".pem" } },
    { command: "ls" }
  );
  assert.equal(result.matched, false);
  assert.deepEqual(result.missingKeys, ["file_path"]);
});

// ---------------------------------------------------------------------------
// matchesAnyStringField — wildcard scan over input
// ---------------------------------------------------------------------------

test("matchesAnyStringField finds .ssh inside any value", () => {
  assert.equal(
    matchesAnyStringField({ $contains: ".ssh" }, { command: "ls ~/.ssh/id_rsa" }),
    true
  );
  assert.equal(
    matchesAnyStringField({ $contains: ".ssh" }, { pattern: "**/.ssh/**", path: "/home/u" }),
    true
  );
  assert.equal(
    matchesAnyStringField({ $contains: ".ssh" }, { command: "ls /etc" }),
    false
  );
});

test("matchesAnyStringField with $pathContains canonicalizes", () => {
  assert.equal(
    matchesAnyStringField(
      { $pathContains: "~/.ssh" },
      { file_path: "/Users/alice/.ssh/authorized_keys" }
    ),
    true
  );
});

// ---------------------------------------------------------------------------
// evaluatePolicy — end-to-end with operator-based rules
// ---------------------------------------------------------------------------

test("evaluatePolicy denies via $contains on Bash command", () => {
  const decision = evaluatePolicy({
    policy: {
      rules: [
        {
          id: "ssh-block",
          action: "deny",
          tool: "Bash",
          params: { command: { $contains: ".ssh" } }
        }
      ]
    },
    toolName: "Bash",
    toolParams: { command: "ls -la ~/.ssh" }
  });
  assert.equal(decision.allowed, false);
  assert.match(decision.reason, /policy deny: ssh-block/);
});

test("evaluatePolicy denies via anyParam (path canonicalization)", () => {
  const decision = evaluatePolicy({
    policy: {
      rules: [
        {
          id: "ssh-everywhere",
          action: "deny",
          tool: "*",
          anyParam: { $pathContains: "~/.ssh" }
        }
      ]
    },
    toolName: "Glob",
    toolParams: { pattern: "**/id_*", path: "/home/alice/.ssh" }
  });
  assert.equal(decision.allowed, false);
  assert.match(decision.reason, /ssh-everywhere/);
});

test("evaluatePolicy denies macOS path even when rule says ~/.ssh", () => {
  const decision = evaluatePolicy({
    policy: {
      rules: [
        {
          id: "ssh-anywhere",
          action: "deny",
          tool: "*",
          anyParam: { $pathContains: "~/.ssh" }
        }
      ]
    },
    toolName: "Read",
    toolParams: { file_path: "/Users/bob/.ssh/id_ed25519" }
  });
  assert.equal(decision.allowed, false);
});

test("evaluatePolicy surfaces missingKeys warning when rule references absent key", () => {
  const decision = evaluatePolicy({
    policy: {
      rules: [
        {
          id: "wrong-shape",
          action: "deny",
          tool: "Bash",
          params: { pathContains: { $contains: ".ssh" } }
        }
      ]
    },
    toolName: "Bash",
    toolParams: { command: "ls ~/.ssh" }
  });
  assert.equal(decision.allowed, true); // rule didn't fire — Bash has no pathContains key
  assert.ok(Array.isArray(decision.warnings));
  assert.ok(
    decision.warnings.some((w) => w.ruleId === "wrong-shape" && w.missingKeys.includes("pathContains")),
    "should surface missingKeys warning for wrong-shape rule"
  );
});

test("evaluatePolicy still passes back-compat exact-match rules", () => {
  const decision = evaluatePolicy({
    policy: {
      rules: [{ id: "exact", action: "deny", tool: "Bash", params: { command: "ls /etc" } }]
    },
    toolName: "Bash",
    toolParams: { command: "ls /etc" }
  });
  assert.equal(decision.allowed, false);
  assert.match(decision.reason, /exact/);
});

// ---------------------------------------------------------------------------
// parsePolicyTextCommand — auto-attach anyParam matcher for path intents
// ---------------------------------------------------------------------------

test("parsePolicyTextCommand attaches anyParam for ~/.ssh intent", () => {
  const cmd = parsePolicyTextCommand("Policy new: deny access to ~/.ssh", {
    version: 0,
    policy: { rules: [] }
  });
  assert.equal(cmd.kind, "update");
  const rule = cmd.update.rules[0];
  assert.equal(rule.action, "deny");
  assert.ok(rule.anyParam, "should have anyParam matcher");
  assert.equal(rule.anyParam.$pathContains, "~/.ssh");
});

test("parsePolicyTextCommand attaches anyParam for absolute path intent", () => {
  const cmd = parsePolicyTextCommand("Policy new: block /etc/passwd", {
    version: 0,
    policy: { rules: [] }
  });
  const rule = cmd.update.rules[0];
  assert.equal(rule.anyParam.$pathContains, "/etc/passwd");
});

test("parsePolicyTextCommand attaches $contains for quoted phrase", () => {
  const cmd = parsePolicyTextCommand('Policy new: deny "AWS_SECRET_ACCESS_KEY"', {
    version: 0,
    policy: { rules: [] }
  });
  const rule = cmd.update.rules[0];
  assert.equal(rule.anyParam.$contains, "AWS_SECRET_ACCESS_KEY");
});

test("parsePolicyTextCommand still works for plain tool deny (no anyParam)", () => {
  const cmd = parsePolicyTextCommand("Policy new: deny WebFetch", {
    version: 0,
    policy: { rules: [] }
  });
  const rule = cmd.update.rules[0];
  assert.equal(rule.tool, "WebFetch");
  assert.equal(rule.anyParam, undefined);
});

// ---------------------------------------------------------------------------
// End-to-end: text command → rule → blocks the actual tool call
// ---------------------------------------------------------------------------

test("E2E: 'block ~/.ssh' rule actually blocks Bash AND Glob AND Read", () => {
  const cmd = parsePolicyTextCommand("Policy new: block ~/.ssh", {
    version: 0,
    policy: { rules: [] }
  });
  const rules = cmd.update.rules;

  // Bash with command that touches ~/.ssh
  const bashDecision = evaluatePolicy({
    policy: { rules },
    toolName: "Bash",
    toolParams: { command: "cat ~/.ssh/id_rsa" }
  });
  assert.equal(bashDecision.allowed, false, "Bash should be blocked");

  // Glob targeting the .ssh directory
  const globDecision = evaluatePolicy({
    policy: { rules },
    toolName: "Glob",
    toolParams: { pattern: "id_*", path: "/Users/alice/.ssh" }
  });
  assert.equal(globDecision.allowed, false, "Glob should be blocked");

  // Read on a file inside .ssh
  const readDecision = evaluatePolicy({
    policy: { rules },
    toolName: "Read",
    toolParams: { file_path: "/home/bob/.ssh/authorized_keys" }
  });
  assert.equal(readDecision.allowed, false, "Read should be blocked");

  // Unrelated tool call should NOT be blocked
  const okDecision = evaluatePolicy({
    policy: { rules },
    toolName: "Read",
    toolParams: { file_path: "/tmp/notes.txt" }
  });
  assert.equal(okDecision.allowed, true, "Unrelated Read should pass");
});
