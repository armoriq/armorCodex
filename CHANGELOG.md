# Changelog

All notable changes to ArmorCodex are recorded here. Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses [Semantic Versioning](https://semver.org/).

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
