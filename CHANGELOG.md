# Changelog

All notable changes to ArmorCodex are recorded here. Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added
- Workspace Monitor. Signed in, ArmorCodex reads the mode set on the Tools Monitor page at session start and keeps it in `org-mode.json`. Quiet (the default) shows nothing in the session, asks for no plan, and lets a call the policy, plan check or outage check would stop run, recording on its audit row what Block would have done (`would_be`, `would_be_code`, `would_be_reason`). Show in chat also shows the user one line per such call. Block enforces as before. `ARMORIQ_ORG_MODE=enforce` forces Block on one machine. Requests send `X-ArmorIQ-Monitor-Aware: 1`.
- Each model prompt has its own registered plan. Open prompts refresh confirmed tokens every 15 seconds when expiry is near. Chat only prompts send no plan request.
- `ARMORIQ_INTENT_VALIDITY_SECONDS` sets token validity from 180 to 3600 seconds, taking precedence over `ARMORCODEX_VALIDITY_SECONDS`.

### Changed

- Registration replies distinguish backend confirmation, local recording and an unconfirmed request. To retry an unconfirmed request, register the same plan again or start a new prompt.
- `ARMORCODEX_VALIDITY_SECONDS` outside 180 to 3600 now prevents startup instead of being capped. Update larger values before upgrading, then restart open Codex sessions.
- This version needs `@armoriq/sdk-dev` 0.8.24 or later. Publishing that SDK and updating the dependency range and lockfile remain release steps.
- The installer and the update path write hook entries from one module, `plugins/armorcodex/scripts/lib/hooks-file.mjs`. The installer runs it from the checked out plugin.

### Fixed

- Runtime and request locks recover after their holder dies, and shutdown waits for active registrations. Hook and MCP environments no longer retire each other's plans. A rejected login key records plans locally again.
- Status and policy commands preserve the active prompt. Token refreshes preserve tool authorization, and audit rows are queued before activity writes.
- An auto-update now brings ArmorCodex's own entries in `~/.codex/hooks.json` up to the current definition, so installs that moved to 0.3.9 on their own stop logging `warning: clamping SessionEnd hook timeout to 3s`. At session start, when an entry pointing at the managed install differs, a background step rewrites it and records trust for the changed hooks through `codex app-server`, as the installer does. If the trust step fails, `hooks.json` and the previous trust are put back and the reason is written to `~/.codex/armorcodex/hooks-sync.log`; it is retried after an hour. Other tools' hooks, hooks the person never trusted, and entries pointing at another checkout are left alone. `ARMORCODEX_NO_AUTO_UPDATE=1` turns it off.

## [0.3.9] - 2026-11-18

### Fixed
- The SessionEnd hook asks Codex for a 3s timeout instead of 30s. Codex caps SessionEnd at 3s and printed `warning: clamping SessionEnd hook timeout to 3s` on every session when asked for more. The installer, `hooks/hooks.json` and `.codex/hooks.json` all use 3, and rerunning the installer brings existing ArmorCodex hook entries up to the current timeout and status message, keeping each entry's command. An auto-update did not: installs that moved to 0.3.9 on their own kept SessionEnd at 30 and still logged the warning (fixed in the next release). SessionEnd's removal from the live sessions list now waits at most 1s for its lock, so it fits inside that cap.
- A failed release lookup (offline, GitHub rate limit) no longer moves an install that sits on a release tag onto unreleased `main`; it keeps the installed version.
- The installer no longer moves an install that is newer than the latest release back to that release.
- A `[features]` header with a trailing comment in `config.toml` now gets `hooks = true`. Before, hooks stayed off.
- A failed first-time install deletes the plugin directory only when that run created it.

### Changed
- `install_armorcodex.sh` in this repository is the single source of the installer. The hosted https://armoriq.ai/install_armorcodex.sh is moving to a small wrapper that downloads this file from `main`. The release lookup timeout is 10s instead of 5s.

## [0.3.8] - 2026-11-17

### Changed
- No functional change. This patch release proves that installs on 0.3.7 move to a new release on their own: the session after it is published prepares 0.3.8 beside the install, and the next session switches to it.

## [0.3.7] - 2026-11-16

### Added
- Auto-update. At most once a day SessionStart checks the repo's latest release. A newer release is cloned at its tag beside the install, its dependencies installed with `npm ci`, and it is swapped in by rename at the next session start; the replaced copy is kept at `~/.armoriq/armorCodex.previous`. The person sees a notice; the model does not. Installs on the dev branch are left alone. `ARMORCODEX_NO_AUTO_UPDATE=1` turns it off.
- The installer checks out the latest release tag instead of the tip of `main`. `ARMORCODEX_GIT_REF` still picks any branch or tag.
- A small anonymous usage ping once per UTC day, an install notice, and a once-a-day sign in reminder when signed out. See "Data & Privacy" in the README for what is sent and how to turn it off.

### Changed
- Brings every change from 0.3.4 to 0.3.6 (below) to the stable channel, on production: depends on `@armoriq/sdk` ^0.8.24, and the plugin and the `armoriq` CLI default to `https://api.armoriq.ai`. `ARMORIQ_ENV=staging` selects staging.

### Fixed
- Logins saved by the `armoriq` CLI as a versioned credentials file are read, as is the older flat file.
- A fresh install now enforces. Codex skips untrusted hooks, and the installer never trusted ArmorCodex's, so a new install ran no hook. The installer now records trust for its own hooks through `codex app-server`, the way `/hooks` does, and if that fails it says to run `/hooks` in Codex and trust them.
- The installer runs `armoriq login --backend <the plugin's backend>`, so the saved login is the one the plugin looks up. Before, an `ARMORIQ_ENV` or `ARMORCODEX_BACKEND_ENDPOINT` override made the installer save a login under the CLI's staging default that the plugin never loaded.

## [0.3.6] - 2026-10-12

### Added
- Every request to the ArmorIQ backend carries `X-ArmorIQ-Client: armorcodex-dev/<version>` (`armorcodex/<version>` on `@armoriq/sdk`), so the platform can tell which ArmorCodex version a key runs and offer updates. The SDK client and telemetry runtime get it through the SDK's `client` option, and the plugin's own requests (audit batches, policy, key owner, history sync) through `clientHeaders`.

### Changed
- Depends on `@armoriq/sdk-dev` ^0.8.16.

## [0.3.5] - 2026-10-12

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
- The stable and dev install commands refuse to update an install on the other channel, and say which command to run, without changing anything.
- An update that finds no usable login keeps the existing install, config block and hooks, prints the login command and exits 1. A fresh install still rolls back, and a run from a local checkout no longer deletes `ARMORCODEX_INSTALL_HOME`.

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
