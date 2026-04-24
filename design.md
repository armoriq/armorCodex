# ArmorCodex Design

ArmorCodex adapts ArmorIQ's intent-security model to the current OpenAI Codex hook and plugin harness.

## Key Codex Differences

The latest Codex hook docs state that hooks are found in `~/.codex/hooks.json` and `<repo>/.codex/hooks.json`, require `[features] codex_hooks = true`, and currently intercept Bash only for `PreToolUse`, `PermissionRequest`, and `PostToolUse`.

That means ArmorCodex does not attempt to claim complete tool coverage. It enforces and audits Bash, and uses MCP for plan and policy management.

## Flow

```
UserPromptSubmit
  -> store prompt
  -> inject instruction to call register_intent_plan

register_intent_plan MCP tool
  -> validate canonical plan schema
  -> optionally request ArmorIQ signed token
  -> write pending-plan.json

PreToolUse(Bash)
  -> consume pending-plan.json
  -> evaluate policy
  -> verify local/signed intent
  -> optionally verify CSRG proof / IAP step
  -> allow or deny command

PermissionRequest(Bash)
  -> evaluate local policy before Codex prompts for approval

PostToolUse(Bash)
  -> send best-effort audit log when ArmorIQ credentials exist
```

## Modules

| Module | Responsibility |
| --- | --- |
| `scripts/hook-router.mjs` | Reads Codex hook JSON and dispatches by event |
| `scripts/policy-mcp.mjs` | MCP tools for policy and intent-plan registration |
| `scripts/lib/engine.mjs` | Hook handlers for Codex events |
| `scripts/lib/intent-schema.mjs` | Shared intent plan schema |
| `scripts/lib/intent.mjs` | Token parsing, plan matching, proof helpers |
| `scripts/lib/policy.mjs` | Local rule parsing and policy evaluation |
| `scripts/lib/iap-service.mjs` | ArmorIQ backend integration |
| `scripts/lib/runtime-state.mjs` | File-backed session state |

## Security Posture

ArmorCodex fails closed in `enforce` mode when:

- a Bash command has no registered plan and intent is required,
- a Bash command is not declared in the registered plan,
- command parameters do not match plan constraints,
- local policy denies the command,
- token or proof verification fails,
- a required ArmorIQ verification call fails.

`monitor` mode preserves decisions and audit behavior but does not block.
