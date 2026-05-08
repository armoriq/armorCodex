# Title

Inconsistent PreToolUse hook coverage across tool handlers (most tools never emit hook events)

# Body

## Summary

`codex-rs/core/src/tools/registry.rs` dispatches `PreToolUse` / `PermissionRequest` / `PostToolUse` generically: any handler that returns `Some(payload)` from `pre_tool_use_payload` will surface a hook event. Today only `shell` (Bash), `unified_exec`, `apply_patch`, and `mcp` opt in. Every other tool handler in `core/src/tools/handlers/` falls back to the trait default (`None`), so hooks never fire for those tools.

The result is that the hooks system, which is otherwise a clean general-purpose interception mechanism, behaves as if it were shell-and-edit-only. Anyone building tooling on top of Codex hooks (observability, audit logging, policy enforcement, telemetry, debugging instrumentation, third-party integrations) silently loses coverage on a large portion of the agent's tool surface.

## Affected handlers (don't currently emit hook events)

From `codex-rs/core/src/tools/handlers/`:

- **Filesystem reads**: `list_dir`, `view_image`
- **MCP resource access**: `mcp_resource` (asymmetric with `mcp` tool calls, which do emit)
- **Agent task plan / objectives**: `plan` (`update_plan`), `goal` (`create_goal` / `update_goal` / `get_goal`)
- **Batch sub-agent orchestration**: `agent_jobs` (`spawn_agents_on_csv`)
- **Tool discovery**: `tool_search`, `tool_suggest`
- **Per-agent control**: `multi_agents/*` (5 sub-handlers), `multi_agents_v2/*` (7 sub-handlers)
- **Web search**: no handler implementation in `core/src/web_search.rs`

The asymmetry between `apply_patch` (file edits: emits hooks) and `list_dir` / `view_image` (file reads: silent) is particularly noticeable for any tool that wants a complete view of agent activity.

## Why this matters

Codex hooks are a public extension point. Their value depends on coverage being consistent across tools. With today's gaps:

- Observability tools cannot record what files the agent listed or what plans it updated.
- Audit logs are incomplete: `apply_patch` is logged, but the `update_plan` that decided to apply the patch is not.
- Policy / safety tooling cannot enforce constraints on agent reasoning surface (`update_plan`, `goal`) or on multi-agent orchestration.
- Telemetry / debugging instrumentation has blind spots on the same boundaries.

This is a consistency gap in an existing public API surface.

## Proposed change

Add `pre_tool_use_payload` implementations to the handlers above. The pattern is already established in `apply_patch.rs:317-322` and `mcp.rs`. Each addition is 5-15 lines of Rust.

A working PoC is available on a fork branch:

- **Branch**: https://github.com/armoriq/codex/tree/feat/expand-pre-tool-use-payload-coverage
- **Commits**:
  - `8597270a9` (*"core: emit PreToolUse hooks from list_dir, view_image, mcp_resource, plan, goal, agent_jobs, tool_search, tool_suggest"*)
  - `f98155cf8` (*"core: add tests for new pre_tool_use_payload impls"*)

The PoC covers 8 of the missing handlers:

- `list_dir.rs`
- `view_image.rs`
- `mcp_resource.rs`
- `plan.rs`
- `goal.rs`
- `agent_jobs.rs`
- `tool_search.rs`
- `tool_suggest.rs`

For handlers that wrap multiple sub-tools (`mcp_resource`, `goal`), the raw function arguments are forwarded as JSON. For handlers with a single args schema (`list_dir`, `view_image`, `tool_search`), the parsed fields are surfaced explicitly.

**Diff size**: 16 files changed, 503 insertions, 0 deletions (8 handler patches + 8 test additions).

**Tests**: 10 new unit tests cover the new `pre_tool_use_payload` paths, asserting each handler returns the expected `PreToolUsePayload` shape (and `None` for non-`Function` payloads where applicable). The pattern follows `apply_patch_tests.rs`. Full `codex-core` lib test count: 1641 -> 1651, all passing on the patched branch (after rebasing on current `main`).

**Live verification**: Built `cargo build -p codex-cli --release` and ran the patched binary in Codex Desktop. Captured a `PreToolUse tool=update_plan` hook event for the first time, confirming the dispatch path is correct end-to-end. Without this patch, `update_plan` calls go through silently.

## Out of scope for the proposed PR

Two pieces are intentionally deferred to keep the first PR reviewable:

1. **`multi_agents/*` (5 sub-handlers)** and **`multi_agents_v2/*` (7 sub-handlers)** for fine-grained agent control. The big-picture orchestration entry (`spawn_agents_on_csv`) is already covered via `agent_jobs.rs` in this PR. Per-agent control can land in a focused follow-up.
2. **`web_search`**: no handler implementation exists today; needs a new handler skeleton in `core/src/web_search.rs`. Better as its own issue + PR.

## Why filing this first

Per `docs/contributing.md`:

> "Start with an issue. Open a new one or comment on an existing discussion so we can agree on the solution before code is written."
>
> "Pull requests that have not been explicitly invited by a member of the Codex team will be closed without review."

Filing this to align on direction before submitting code. Open to:

- Submitting as a single PR covering all 8 handlers, or
- Splitting by category (filesystem reads / MCP resources / agent reasoning / orchestration / tool discovery) if smaller PRs are easier to review.

## Tested against

- `openai/codex` `main` (current head as of filing).
- Codex CLI 0.125.0 baseline + patched build.
- Codex Desktop on macOS (Apple Silicon).

## Open questions for the team

1. Is there an internal roadmap for hook coverage that this overlaps with?
2. Are there any handlers on the deferred list (`multi_agents`, `web_search`) where you'd prefer not to emit hooks for design reasons (privacy, operational noise, etc.)?
3. Preference on PR shape: single PR for all 8, or split by category?
4. Naming convention for hook payloads: should `update_plan`'s `HookToolName` be `"update_plan"` or pulled from the canonical tool registry name?

CLA-ready on our side. Happy to iterate on the design here before any code lands.
