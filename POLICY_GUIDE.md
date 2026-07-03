# ArmorCodex Policy Guide

ArmorCodex controls what OpenAI Codex is allowed to do with tools (Bash, apply_patch, MCP calls). You manage policy from a Codex prompt using `armor` commands.

Codex can read policy and stage proposals, but only you can apply a change. Nothing takes effect until you confirm.

## Two ways to set policy

1. Structured `armor` commands with a staged proposal -> confirm flow (recommended).
2. Natural language `Policy ...` commands, applied immediately (kept for back-compat).

## Basic commands

Show help:

```text
armor
```

Show the active policy:

```text
armor policy list
```

Show the policy as JSON:

```text
armor policy view
```

Stage a rule:

```text
armor policy add deny bash
```

You can stage several at once:

```text
armor policy add allow bash and apply_patch, deny apply_patch
```

Apply the staged change:

```text
armor yes
```

Discard it:

```text
armor no
```

Remove a rule, then confirm:

```text
armor policy remove policy1
armor yes
```

Clear everything:

```text
armor policy reset
armor yes
```

## Default decision

By default, tools with no matching rule are allowed. To fail closed, set the default to deny (this appends a catch-all rule) and confirm:

```text
armor policy default deny
armor yes
```

Use `allow` or `hold` (require approval) the same way.

## Templates

```text
armor policy template lockdown
armor yes
```

Available: `all-allow`, `lockdown`, `strict-read-only`, `balanced`.

## Profiles

Save the active policy, list, switch (staged), or delete:

```text
armor profile save intern
armor profile list
armor profile switch intern
armor yes
armor profile delete intern
```

`save`, `list`, and `delete` apply immediately (they do not change active enforcement). `switch` stages a proposal, so activating a profile still goes through confirm.

## MCP server trust

Allow or block every tool from an MCP server (`mcp__<server>__*`):

```text
armor mcp deny github
armor yes
```

`armor mcp approve <server>` trusts it (the allow rule is placed before any catch-all deny, so it wins). `armor mcp list` shows current MCP trust rules.

## Staging lifecycle

```text
stage -> confirm
```

- Staging writes a pending proposal (`policy-pending.json`) with an id, hashes, the base version, and a 30 minute expiry. It shows a diff and risk warnings. Nothing is enforced yet.
- Confirm re-checks the base version, base hash, proposal hash, and expiry before applying. If the active policy changed since you staged, the proposal is rejected and you re-stage.
- `armor yes` and `armor no` are shortcuts for confirming or discarding the current proposal. You can also use `armor policy confirm <id>` and `armor policy cancel <id>`.

## Human-only apply

Applying a policy change is human-only. The `policy_command` MCP tool (callable by the agent) can read policy and stage proposals, but it cannot confirm. Only a terminal `armor yes` applies a staged change, and confirm echoes the applied diff and notes who staged it.

## How to know it worked

```text
armor policy list
```

Then ask Codex to run something the policy blocks (for example a denied Bash command). ArmorCodex denies it at the PreToolUse hook and names the rule.

## Policy schema

ArmorCodex stores policy as a rule list:

```json
{
  "rules": [
    { "id": "policy1", "action": "deny", "tool": "bash" },
    { "id": "policy2", "action": "deny", "tool": "*" }
  ]
}
```

Rules match by tool name (with optional trailing `*` glob, e.g. `mcp__github__*`), and support `dataClass` (PCI/PHI/PII) and `anyParam` matchers for finer control. Rules are evaluated in order; the first match wins.
