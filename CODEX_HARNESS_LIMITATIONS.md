# Codex Harness Limitations

ArmorCodex depends on the current OpenAI Codex hooks and plugin harness. The harness is useful for Bash policy enforcement, but it is not yet a complete security interception layer for every Codex capability.

## Current OpenAI Codex Harness Limits

- Hooks are experimental and under active development, so event shape and behavior may change across Codex releases.
- Hooks require `[features] codex_hooks = true` in `~/.codex/config.toml`; if the feature flag is absent, ArmorCodex hooks will not run.
- Hooks are currently disabled on Windows.
- `PreToolUse`, `PermissionRequest`, and `PostToolUse` currently emit `Bash` only. Non-Bash tools, including MCP tools, file edits, apply-patch/write flows, web search, image generation, and app connector calls, are not directly gated by Codex hooks today.
- Multiple matching command hooks for the same event are launched concurrently. One hook cannot prevent another matching hook from starting, so hook ordering cannot be used as a strict enforcement primitive.
- `UserPromptSubmit` and `Stop` do not support matcher filtering. Any configured matcher for those events is ignored by the current runtime.
- Some output controls are parsed but not fully implemented for all events. For example, `suppressOutput` is parsed but not currently supported.

## Impact On ArmorCodex

- ArmorCodex should be described as a strong Bash guardrail and audit layer, not a complete boundary for all Codex actions.
- Local policy and intent checks can block unsupported Bash commands, but they cannot directly block non-Bash tool calls until the Codex harness emits those tools through hook events.
- Audit coverage is strongest for Bash. Non-Bash activity may need supplemental logging through MCP, app-specific controls, repository review, or future Codex hook support.
- Security claims should remain scoped to the current harness behavior: plan registration through MCP, Bash command matching, Bash permission gating, and Bash post-run audit.

## Open Issues To Track

- Add direct hook coverage for non-Bash tools, especially file write/edit operations, MCP tool calls, app connector calls, and web/network tools.
- Add deterministic hook ordering or an explicit enforcement chain so one policy hook can stop later hooks or tool execution before side effects occur.
- Add first-class Windows hook support.
- Add stable, documented schemas and compatibility guarantees for hook inputs and outputs.
- Add matcher support for prompt and stop lifecycle events, or document a supported alternative for scoped prompt interception.
- Add fully implemented output suppression and consistent blocking semantics across lifecycle events.

Sources:

- OpenAI Codex hooks docs: https://developers.openai.com/codex/hooks
- OpenAI Codex plugin build docs: https://developers.openai.com/codex/plugins/build
