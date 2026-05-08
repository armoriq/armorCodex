# ArmorClaude vs ArmorCodex — Feature Comparison

A side-by-side accounting of what each plugin does and where they differ. Most differences are driven by the underlying agent platform (Claude Code vs OpenAI Codex), not by intentional design choices.

## At a Glance

| Aspect | ArmorClaude | ArmorCodex |
| --- | --- | --- |
| Target | Claude Code (CLI + Desktop) | OpenAI Codex (CLI + Desktop) |
| Tool coverage | Every tool the agent calls | Bash, `apply_patch` (file edits), MCP tool calls — verified end-to-end. Outside coverage today: `list_dir`, `view_image`, `web_search`, `mcp_resource`, orchestration tools |
| Plan registration paths | MCP `register_intent_plan` + `ExitPlanMode` capture | MCP `register_intent_plan` only |
| Install command | `claude plugin install armorclaude@armoriq` | `bash install_armorcodex.sh` (CLI 0.125.0 has no `plugin install` subcommand yet) |
| MCP server discovery | Project-level `.mcp.json` auto-loaded | Must be wired into `~/.codex/config.toml` |
| Audit events | Success + failure (`PostToolUse` + `PostToolUseFailure`) | Success only — Codex doesn't emit `PostToolUseFailure` |
| Lifecycle events | `SessionStart`, `SessionEnd`, `Stop` | `SessionStart`, `Stop` — Codex doesn't emit `SessionEnd` |
| Approval gating | Not exposed by Claude harness | `PermissionRequest` handler (Codex-specific) |
| Default token validity | 60 seconds | 600 seconds (multi-step friendly) |
| Windows support | Yes | No (Codex hooks disabled on Windows) |

## What ArmorClaude Has That ArmorCodex Doesn't

These gaps are all upstream Codex platform limits — not implementation gaps in ArmorCodex. They cannot be fixed from our side until OpenAI ships the missing harness features.

| Feature | Why it's not in ArmorCodex |
| --- | --- |
| **`ExitPlanMode` plan-mode capture (Plan Path B)** | Codex has no plan-mode hook event. Claude Code emits `ExitPlanMode` when the user approves a plan; we intercept it and lift the plan into our intent token. Codex Desktop has a "Plan mode" toggle, but it does not emit a hook event — it just constrains the agent's permissions for that turn. |
| **Hook coverage for `list_dir`, `view_image`, `web_search`, orchestration tools** | Their handlers don't implement `pre_tool_use_payload` upstream, so no hook event is emitted. (`Bash`, `apply_patch`/file edits, and MCP tool calls *do* emit events and are gated by ArmorCodex.) |
| **`PostToolUseFailure` event for failed tool calls** | Not emitted by Codex. ArmorClaude routes failed Bash to a separate audit path; ArmorCodex collapses success + fail into one `PostToolUse`. |
| **`SessionEnd` cleanup event** | Not emitted by Codex. Session state is pruned by the next session start instead. |
| **Matcher filtering on `UserPromptSubmit` and `Stop`** | Matcher field is silently ignored by Codex. ArmorCodex does in-script filtering instead. |
| **Native `<plugin> install` flow** | Claude CLI ships `claude plugin install`. Codex CLI 0.125.0 only has `marketplace add/upgrade/remove` — `install` doesn't exist yet. ArmorCodex's installer wires hooks + MCP via direct `~/.codex/config.toml` edits. |
| **Auto-loaded project-level `.mcp.json`** | Claude Code reads `<repo>/.mcp.json` automatically. Codex requires `[mcp_servers.*]` blocks in `~/.codex/config.toml`. |
| **Hook ordering / chained enforcement** | Codex fires multiple matching hooks concurrently — no ordering guarantee. ArmorCodex collapses everything into a single hook script per event to avoid the issue. |
| **`suppressOutput` honored** | Parsed but not implemented by Codex. ArmorCodex avoids depending on it. |

## What ArmorCodex Has That ArmorClaude Doesn't

Improvements added during the Codex port that haven't been backported to ArmorClaude. These are real upgrades that the Claude version could benefit from.

| Feature | Where | Reason |
| --- | --- | --- |
| **`PermissionRequest` handler** | `scripts/lib/engine.mjs` (`handlePermissionRequest`) | Codex-specific event; gates approval prompts using the same policy engine. Claude has no equivalent event. |
| **Auto-refresh of expiring intent tokens** | `scripts/lib/engine.mjs` (refresh near expiry) | Reissues the token silently when it has < 30s of life left, so multi-step turns don't hit an expiry boundary mid-execution. |
| **Secret redaction in audit logs** | `scripts/lib/common.mjs` (`redactSecrets`) | Strips Bearer tokens, AWS keys, GitHub PATs, JWT-shaped values, private key blocks before payloads leave the host. |
| **Atomic JSON file writes** | `scripts/lib/fs-store.mjs` | `write to .tmp -> rename` prevents torn JSON when two hooks race or the process is killed mid-write. |
| **Corrupt-JSON recovery** | `scripts/lib/fs-store.mjs` | A `SyntaxError` on read falls back to the default value instead of crashing the session. |
| **Stricter tool-name validation** | `scripts/lib/policy.mjs` (`sanitizeToolName`) | Free-text like "all tools" or regex fragments can't accidentally become rule matchers. |
| **Robust JSON-block extraction** | `scripts/lib/planner.mjs` (`extractPlanJsonBlock`) | Returns the last block with a `steps` array, so example/illustration blocks earlier in the file aren't accidentally parsed as the plan. |
| **Fail-closed on malformed payloads** | `scripts/hook-router.mjs` | Invalid JSON or missing `tool_name` on a `PreToolUse` payload denies in enforce mode instead of silently allowing. |
| **Version-aware install marker** | `scripts/bootstrap.mjs` | `node_modules/.armorcodex-installed` records the package version; mismatched versions trigger reinstall. Prevents partial-install crashes. |
| **`--uninstall` and `--force-hooks` installer flags** | `install_armorcodex.sh` | Clean removal and explicit overwrite paths. |
| **Idempotent managed-block markers** | `install_armorcodex.sh` | `# >>> ArmorCodex managed block` markers in `~/.codex/config.toml` mean re-running the installer replaces in place — no duplicate growth. |
| **Auto-clone fallback in installer** | `install_armorcodex.sh` | Runs cleanly via `curl ... \| bash` (clones to `~/.armoriq/armorCodex`) without requiring the user to clone first. |

## Shared Surface (Identical or Trivially Renamed)

These pieces are functionally equivalent on both sides — the same code with `armorClaude`/`claude-code` renamed to `armorCodex`/`codex`.

- Intent plan schema (`intent-schema.mjs`) — same Zod schema, same normalization.
- IAP service client (`iap-service.mjs`) — byte-identical (`verifyStep`, `verifyWithCsrg`, `createAuditLog`).
- CSRG cryptographic policy binding (`crypto-policy.mjs`) — byte-identical.
- Runtime state management (`runtime-state.mjs`) — byte-identical.
- Policy evaluator core logic (`policy.mjs`) — same matching rules, only ArmorCodex adds tool-name sanitization.
- MCP tools — both expose `register_intent_plan`, `policy_read`, `policy_update` with the same shapes.

## Net Read

- **ArmorClaude is broader in coverage** because Claude Code's hook harness is more complete: every tool fires hooks, `ExitPlanMode` exists, `PostToolUseFailure` and `SessionEnd` are emitted, and matcher filtering works.
- **ArmorCodex is more hardened** because the Codex port forced us to handle real-world edge cases: token refresh, atomic writes, secret redaction, fail-closed payload validation, idempotent installs.
- **Together they cover the full set of ArmorIQ enforcement features** — every capability in one is either also in the other or genuinely impossible there due to platform constraints documented in [`CODEX_HARNESS_LIMITATIONS.md`](CODEX_HARNESS_LIMITATIONS.md).

## Action Items Worth Tracking

- Backport ArmorCodex's hardening (atomic writes, secret redaction, auto-refresh, corrupt-JSON recovery, stricter sanitization) to ArmorClaude.
- Watch Codex release notes for: non-Bash hook coverage, `PostToolUseFailure`/`SessionEnd` events, native `plugin install` subcommand, `.mcp.json` auto-load, `ExitPlanMode`-equivalent event.
- Build compensating layers for non-Bash coverage on Codex (MCP-gateway proxy, fswatch daemon, transcript-replay audit) — see roadmap discussion.
