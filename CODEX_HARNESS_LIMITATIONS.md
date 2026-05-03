# Codex Harness Limitations

ArmorCodex depends on the current OpenAI Codex hooks and plugin harness. The harness is useful for Bash policy enforcement, but it is not yet a complete security interception layer for every Codex capability.

## Verified Coverage (Codex CLI 0.125.0, Codex Desktop)

End-to-end testing confirmed ArmorCodex hooks fire and gate the following tools:

- **`Bash`** (`shell` + `unified_exec`) — `PreToolUse`, `PermissionRequest`, `PostToolUse` all observed.
- **`apply_patch`** (file edit/write/patch flows) — `PreToolUse` and `PostToolUse` observed on real file edits.
- **MCP tool calls** (e.g. `mcp__armorcodex_policy__register_intent_plan`) — full lifecycle observed (PreToolUse + PermissionRequest + PostToolUse).

Tools that do **not** currently emit hook events (handler does not implement `pre_tool_use_payload` upstream):
`list_dir`, `view_image`, `web_search`, `tool_search`, `tool_suggest`, `mcp_resource`, `plan`, `goal`, `agent_jobs`, `multi_agents`, `multi_agents_v2`.

## Current OpenAI Codex Harness Limits

- Hooks are experimental and under active development, so event shape and behavior may change across Codex releases.
- Hooks require `[features] codex_hooks = true` in `~/.codex/config.toml`; if the feature flag is absent, ArmorCodex hooks will not run.
- Hooks are currently disabled on Windows.
- `PreToolUse`, `PermissionRequest`, and `PostToolUse` currently emit hook events for the following tools: `Bash` (shell + `unified_exec`), `apply_patch` (file write/edit/patch flows), and **MCP tool calls**. ArmorCodex gates all three. Tools that do **not** currently emit hook events: `list_dir`, `view_image`, `web_search`, `tool_search`/`tool_suggest`, `mcp_resource`, and the orchestration tools (`plan`, `goal`, `agent_jobs`, `multi_agents`, `multi_agents_v2`). These are gaps in tool-handler `pre_tool_use_payload` coverage upstream — see Open Issues below.
- Multiple matching command hooks for the same event are launched concurrently. One hook cannot prevent another matching hook from starting, so hook ordering cannot be used as a strict enforcement primitive.
- `UserPromptSubmit` and `Stop` do not support matcher filtering. Any configured matcher for those events is ignored by the current runtime.
- Some output controls are parsed but not fully implemented for all events. For example, `suppressOutput` is parsed but not currently supported.

## Impact On ArmorCodex

- ArmorCodex enforces and audits three categories of agent activity today: Bash commands (`shell` + `unified_exec`), file-write operations via `apply_patch`, and MCP tool calls. It is not a complete boundary for every Codex action — the tools listed above as not emitting hook events bypass enforcement.
- Local policy and intent checks block unsupported tool calls in those three categories. Tools without `pre_tool_use_payload` upstream coverage cannot be directly blocked until OpenAI adds the missing handler implementations (or accepts a PR adding them).
- Audit coverage matches enforcement coverage: Bash, `apply_patch`, and MCP. `list_dir`, `view_image`, `web_search`, and the orchestration tools may need supplemental logging through MCP-gateway proxies, fswatch, repository review, or future Codex hook support.
- Security claims should remain scoped to the current harness behavior: plan registration through MCP, intent-plan matching for Bash + `apply_patch` + MCP tool calls, permission gating on the same set, and post-run audit on the same set.

## Open Issues To Track

- Add `pre_tool_use_payload` impls for the remaining tool handlers in `codex-rs/core/src/tools/handlers/`: `list_dir`, `view_image`, `tool_search`, `tool_suggest`, `mcp_resource`, `plan`, `goal`, `agent_jobs`, `multi_agents`, `multi_agents_v2`. The pattern is established in `apply_patch.rs` and `mcp.rs`. (`Bash`, `apply_patch`, and MCP tool calls already emit hook events as of Codex CLI 0.125.0.)
- Add a hook-event-emitting handler for `web_search` (currently has no handler implementation in `codex-rs/core/src/web_search.rs`).
- Add app-connector tool calls to the same coverage.
- Add deterministic hook ordering or an explicit enforcement chain so one policy hook can stop later hooks or tool execution before side effects occur.
- Add first-class Windows hook support.
- Add stable, documented schemas and compatibility guarantees for hook inputs and outputs.
- Add matcher support for prompt and stop lifecycle events, or document a supported alternative for scoped prompt interception.
- Add fully implemented output suppression and consistent blocking semantics across lifecycle events.

Sources:

- OpenAI Codex hooks docs: https://developers.openai.com/codex/hooks
- OpenAI Codex plugin build docs: https://developers.openai.com/codex/plugins/build
