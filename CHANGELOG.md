# Changelog

All notable changes to ArmorCodex are recorded here. Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses [Semantic Versioning](https://semver.org/).

## [0.3.5] - Unreleased

### Added
- Turn latency: the usage worker sends each session-day's turn durations from Codex's `task_complete` records to the latency chart.
- Session titles: the usage worker sends each session's latest Codex name from `session_index.jsonl`, only for sessions whose usage this login sends. Titles over 200 characters are cut to 199 and an ellipsis.
- Per-call usage: every changed session-hour goes out with each of its model requests (key: Codex's response id), so a plan can show its own model, tokens and cost.
- The backend's v2 plan check is enforced: in enforce mode a call to a tool the check lists as denied is blocked with the backend's reason; in monitor mode it is allowed and logged to `<data dir>/monitor.jsonl`.
- Audit rows carry a stable `client_row_id`, so a resend after a kill is stored once.

### Changed
- Spans keep the time their hook ran and Codex's call id, so a turn's spans are no longer squeezed into the moment of Stop, and a policy decision links to its tool call. A failed replay is exported with status error.
- One generation span per model request instead of one summed span per turn.
- Intent plans carry the Codex session id as their context id instead of `default`.
- `register_intent_plan` replies only once the ArmorIQ token is issued (30 s deadline), and each Codex session keeps its own pending plan.
- Codex hook names for namespaced tools (`clock__curr_time` reaches hooks as `clockcurr_time`) are matched at registration and by policy rules.
- Audit rows reference the plan by id instead of carrying the intent token, every PreToolUse deny writes a blocked row, and queued rows are flushed when Codex closes the MCP server.
- Intent token validity is capped at 3600 s.
- Depends on `@armoriq/sdk-dev` ^0.8.15.

### Fixed
- The hook signs the registered plan and never a one-tool plan of its own.
- Config is resolved once and the SDK no longer receives `useProduction`, so the plugin can't switch the SDK to a local environment.
- The installer requires Codex 0.162 or newer, merges its hooks into an existing `hooks.json` and removes only its own on uninstall, checks the login at the end of an update, offers missing tools, and works with git configs that rewrite GitHub HTTPS to SSH.
- A re-run of the installer always runs `npm install`, so an install left on an old SDK is upgraded, and a piped re-run (`curl ... | bash`) refreshes the existing install instead of taking it for a local checkout.

## [0.3.4] - 2026-10-10

### Added
- Each Stop uploads that Codex session's usage on its own, from the login time on, through a crash-safe local queue (batch upload with per-hour revisions).
- A background worker runs while a Codex session is open (a pass every 60 s) to upload sessions that sent no Stop and an earlier-history request after you allow it in Tools. It stops after the last session ends. Codex asks you once in `/hooks` to trust the new SessionEnd hook.
- `disable_usage_sync` plugin option and `ARMORCODEX_USAGE_SYNC_DISABLED`; turning off observability also turns the sync off.

### Changed
- Depends on `@armoriq/sdk-dev` ^0.8.13 instead of `@armoriq/sdk` 0.6. Observability ships each turn over OTLP (`/v1/traces`) instead of `POST /observability/spans`.
- Usage comes from `token_usage_record` lines (Codex 0.153 and later) and from `token_count` growth before the first record.

### Removed
- The Stop hook's cumulative `/dashboard/token-usage` post, `scripts/backfill.mjs`, `summarizeCodexTranscriptUsage`, and the old usage scanner (`scripts/usage-sync.mjs`) and its hook launches.

## [0.3.2] — 2026-07-16

### Added
- Per-turn ArmorCodex observability generation spans with input, output, cached-token, latency, and cost metrics
- Regression coverage for cumulative Codex token snapshots and multi-turn sessions

### Fixed
- Prevent cumulative token totals from being counted again on resumed Codex sessions
- Report non-zero cost for `gpt-5.6-sol` through ArmorIQ SDK 0.6.3 pricing
- Keep plugin, package, lockfile, and marketplace release versions aligned

## [0.3.0] — 2026-06-24

OpenAI Apps SDK / Codex Marketplace submission readiness release.

### Added
- MCP tool annotations (`readOnlyHint`, `destructiveHint`, `idempotentHint`, `openWorldHint`) on all three tools — `policy_update`, `policy_read`, `register_intent_plan` — per the Apps SDK MCP tool-definition spec
- `DATA_RETENTION.md` at the repo root describing retention windows, deletion paths, and GDPR/CCPA rights
- `SECURITY.md` at the repo root mirroring the per-plugin SECURITY.md added during community-marketplace compliance work
- `LICENSE` (MIT) at the repo root
- `CHANGELOG.md` (this file)

### Changed
- `plugins/armorcodex/.codex-plugin/plugin.json` version bumped 0.2.0 → 0.3.0
- `plugins/armorcodex/package.json` version bumped 0.2.0 → 0.3.0
- `APPS_SDK_PREREQUISITES.md` refreshed against current state of OpenAI's submission flow as of 2026-06-24 (Apps SDK is now LIVE at `platform.openai.com/apps-manage`; direct Codex self-serve still pending; remote HTTPS MCP requirement confirmed)

### Submission notes

- Apps SDK submission endpoint as of v0.3.0: `https://platform.openai.com/apps-manage`
- ChatGPT App approval auto-creates the Codex plugin listing — single submission, two surfaces
- KYB / developer verification at `platform.openai.com` is a hard prerequisite before any submission

## [0.2.x] — 2026-05

### Added
- HOL Plugin Scanner workflow + 92/100 compliance score (`.github/workflows/hol-plugin-scanner.yml`)
- Plugin-level `LICENSE`, `SECURITY.md`, `README.md`, `.codexignore` (community marketplace requirements)
- Per-plugin `.agents/plugins/marketplace.json` for the Codex repo marketplace path
- Bundle landed in `hashgraph-online/awesome-codex-plugins` (PR #189)

### Changed
- Tests moved from `plugins/armorcodex/tests/` to repo-root `tests/` (HOL scanner false-positive avoidance; tests don't belong in the shipped bundle)
- Test imports updated to reference `../plugins/armorcodex/scripts/...`

### Fixed
- Latency cleanup: hook overhead reduced to <200ms p95 (PR #15)

## [0.1.0] — 2026-04

Initial release.

### Added
- Codex plugin manifest at `.codex-plugin/plugin.json` declaring hooks + MCP server
- MCP server `armorcodex-policy` exposing `register_intent_plan`, `policy_read`, `policy_update`
- Hook router handling `sessionStart`, `userPromptSubmitted`, `preToolUse`, `postToolUse`, `permissionRequest`
- Intent plan registration + drift detection on `bash` and `apply_patch`
- Natural-language policy command parsing (`Policy new: deny webfetch`)
- Backend audit pipeline + signed JWT intent tokens via ArmorIQ
- Curl-pipe installer at `armoriq.ai/install_armorcodex.sh`
