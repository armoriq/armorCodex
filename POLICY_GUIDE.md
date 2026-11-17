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

ArmorCodex stores policy in `~/.codex/armorcodex/policy.json` as an `armor.policy.v1` document, the same schema ArmorClaude and the ArmorIQ console use:

```json
{
  "schemaVersion": "armor.policy.v1",
  "kind": "PolicyProfile",
  "metadata": { "name": "current", "description": "" },
  "defaults": { "decision": "deny", "conflictResolution": "deny_overrides" },
  "statements": [
    {
      "id": "policy1",
      "effect": "permit",
      "principal": { "type": "agent", "id": "armorcodex" },
      "action": { "type": "tool", "eq": "bash" },
      "resource": { "type": "workspace", "scope": "current" },
      "conditions": []
    }
  ]
}
```

A statement matches by tool name (a trailing `*` glob such as `mcp__github__*` works), and its conditions narrow it further. `deny_overrides` means a matching `forbid` wins over `require_approval`, which wins over `permit`; rule order does not decide. When nothing matches, `defaults.decision` applies (`allow`, `deny` or `hold`). The `armor policy` commands still show and edit rules, and `armor policy default deny|hold` sets the default.

Codex adds three condition fields so the older rule matchers keep working: `tool.params` and `tool.anyParam` (op `match`, value the matcher) and `data.class` (op `eq`, value `PCI`, `PAYMENT`, `PHI` or `PII`).

### Upgrading from the rule list

Before this release the file held `{ "rules": [...] }`, decided by the first matching rule. The first time ArmorCodex reads such a file it rewrites it as `armor.policy.v1` in place, keeps the original as `policy.json.legacy.bak`, and adds a history entry. A trailing catch-all rule (`tool: "*"` with no matchers) becomes the default decision. Every call the old file blocked stays blocked. A call that an earlier `allow` used to let through ahead of a later `deny` is now blocked, because a deny always wins.

## Organization policies (policy v2)

When you are signed in, ArmorCodex also enforces the v2 policies your organization publishes in the ArmorIQ console for Codex (`armorcodex`), including workspace-wide ones. It fetches `GET /policy/bundles/current?agent=armorcodex`, keeps the bundle on disk, revalidates it with its ETag at most every 60 seconds, and decides each call locally with the same evaluator the backend uses. An edit in the console therefore reaches Codex within about a minute.

- Both the organization policy and the local file apply; the stricter decision wins. With no v2 policy for Codex, only the local file decides.
- A block names the policy: `ArmorIQ policy "<name>" blocked <tool> (...)`.
- A shadow policy is evaluated on every call and logged to `policy-shadow.jsonl`, and is never enforced.
- A hold blocks when Codex runs without approvals (`codex exec`, or approval policy `never`). With approvals on, a held shell command is refused once with instructions to re-run it with escalated permissions; Codex then shows its approval prompt and you decide. Codex cannot route other held tools to a prompt, so they are blocked.
- Each audit row records what decided it in `input.armoriq_policy`: `source` (`v2`, `local`, `default` or `builtin`), the policy id and name, and any shadow verdicts.
- Set `ARMORCODEX_POLICY_V2=false` to turn organization policy enforcement off.
