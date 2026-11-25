# ArmorCodex

ArmorIQ intent-based security enforcement for OpenAI Codex. ArmorCodex asks Codex to declare a Bash execution plan before it runs commands, checks each Bash command against that plan and local policy, and optionally sends signed intent and audit events to ArmorIQ IAP.

## Current Codex Harness

ArmorCodex is built for the current Codex hook harness documented by OpenAI:

- Hooks are discovered from `~/.codex/hooks.json` and `<repo>/.codex/hooks.json`.
- Hooks require `[features] hooks = true` in `~/.codex/config.toml`.
- `PreToolUse`, `PermissionRequest`, and `PostToolUse` currently emit `Bash` only.
- Non-Bash tools such as MCP, file edits, web search, and write/apply-patch are not directly intercepted by Codex hooks today.

Treat ArmorCodex as a strong Bash guardrail and audit layer, not a complete boundary for every Codex capability.

See [Codex harness limitations](CODEX_HARNESS_LIMITATIONS.md) for the harness gaps that need to be addressed before ArmorCodex can claim broader tool coverage.

Sources: OpenAI Codex hooks docs and plugin build docs:
https://developers.openai.com/codex/hooks
https://developers.openai.com/codex/plugins/build

## How It Works

```
User Prompt -> UserPromptSubmit -> intent-plan directive
                                  |
Codex calls register_intent_plan MCP tool
                                  |
Bash command -> PreToolUse -> policy + intent verification -> allow/deny
Approval request -> PermissionRequest -> policy approval gate
Bash result -> PostToolUse -> audit log to ArmorIQ IAP
```

## Install

Requirements: Codex 0.162 or newer and Node.js 20 or newer. Older Codex sends no session id with MCP calls, so ArmorCodex rejects every plan registration. The installer checks both versions and stops if either is too old.

### Install or Update

The same command installs ArmorCodex and updates an existing install. Run it again whenever Tools says a new version is out:

```bash
# Stable (platform.armoriq.ai)
curl -fsSL https://armoriq.ai/install_armorcodex.sh | bash

# Dev (staging)
curl -fsSL https://armoriq.ai/install_armorcodex_dev.sh | bash
```

An update fetches the latest plugin into `~/.armoriq/armorCodex`, rewires `~/.codex/config.toml` and `~/.codex/hooks.json`, and refreshes the npm dependencies. Your ArmorIQ login is kept. Each command updates only an install of its own channel; run against the other channel's install, it stops without changing anything. If the installer finds no login, it leaves the install in place, prints the login command to run, and exits with status 1. Release notes are in [CHANGELOG.md](CHANGELOG.md) and on the repo's GitHub releases.

### From This Checkout

```bash
npm install
chmod +x install_armorcodex.sh
./install_armorcodex.sh
```

The installer enables `hooks`, installs the Codex plugin through the ArmorIQ marketplace, and can install the repo hook file globally when run from this checkout.

### Manual Repo-Local Setup

```bash
npm install
mkdir -p ~/.codex
printf '\n[features]\nhooks = true\n' >> ~/.codex/config.toml
```

Then run Codex from this repository. The repo-local hook file is already at `.codex/hooks.json`.

### Manual MCP Setup

ArmorCodex ships a Codex plugin manifest at `.codex-plugin/plugin.json` and an MCP server config at `.mcp.json`. The MCP server exposes:

- `register_intent_plan`
- `policy_read`
- `policy_update` (stages a rule change; the user applies it with `armor policy confirm <id>`)

## Configuration

Sign in with `armoriq-dev login --product armorcodex`. ArmorCodex reads the saved login for its backend and product.

Core environment variables:

| Variable | Default | Description |
| --- | --- | --- |
| `ARMORCODEX_MODE` | `enforce` | Signed out: `enforce` blocks failures, `monitor` logs only. Signed in, the [workspace mode](#workspace-mode) decides |
| `ARMORIQ_ORG_MODE` | unset | `enforce` makes this machine block whatever the workspace mode says |
| `ARMORCODEX_INTENT_REQUIRED` | `true` | Require a registered intent plan before Bash |
| `ARMORCODEX_DATA_DIR` | `~/.codex/armorcodex` | Runtime, policy, and pending-plan storage |
| `ARMORIQ_INTENT_VALIDITY_SECONDS` | `3600` | Intent token lifetime, from 180 to 3600 seconds. Takes precedence over `ARMORCODEX_VALIDITY_SECONDS`. An invalid value stops startup and names the variable |
| `ARMORCODEX_VALIDITY_SECONDS` | `3600` | Intent token lifetime when `ARMORIQ_INTENT_VALIDITY_SECONDS` is unset. Accepts 180 to 3600 seconds. An invalid value stops startup and names the variable |
| `ARMORCODEX_DEBUG` | `false` | Debug logs on stderr |
| `ARMORCODEX_AUDIT_ENABLED` | true when API key exists | Send audit logs |
| `ARMORCODEX_RUN_REPORTING_ENABLED` | `true` | Report prompt runs through the durable outbox. Unset means on; `false`, or any value other than exactly `true`, turns it off. A backend without the runs endpoint pauses the stream and keeps the reports locally. Also accepts the `RUN_REPORTING_ENABLED` plugin option and `ARMORIQ_RUN_REPORTING_ENABLED`, the name the other Armor plugins use |
| `ARMORCODEX_CRYPTO_POLICY_ENABLED` | `false` | Enable Merkle policy binding |
| `ARMORCODEX_OBSERVABILITY_DISABLED` | `false` | Stop sending execution traces; also stops the token usage sync. Same as the `disable_observability` plugin option |
| `ARMORCODEX_USAGE_SYNC_DISABLED` | `false` | Stop the token usage sync and keep traces. Applies only while observability is on. Same as the `disable_usage_sync` plugin option |

### Workspace mode

Signed in, ArmorCodex follows the mode your workspace picks under **Tool calls in the chat** on the Monitor page of ArmorIQ Tools. It reads the mode at session start, keeps it in `org-mode.json` in the data directory, and applies it from that session on; until it has an answer it runs Quiet.

| Mode | A call your policy or plan check would stop | What Codex shows |
|---|---|---|
| Quiet (the default) | Runs, and is listed under Would have blocked on the Monitor page | No session banner and no notices. The model is still asked to register a plan |
| Show in chat | Runs, and is listed on the Monitor page | One line per call: `ArmorIQ would block this call in Enforce (<reason>). Monitor let it run.` |
| Block | Is blocked, and a held shell command goes to Codex's approval prompt | The block reason |

In Quiet and Show in chat no intent plan is required, no hold is routed to an approval, an unreachable backend blocks nothing, and Codex's own approval prompts still apply. The audit row of each such call carries `would_be`, `would_be_code` and `would_be_reason`.

Plans work in Monitor as in Block, whether the workspace picks Monitor or `ARMORCODEX_MODE=monitor` sets it: the model is asked to register a plan before the first tool that needs one, the plan is sent to ArmorIQ, refreshed while the prompt is open and retired at the next prompt, and the reply says when it is registered. A failed plan request is recorded and never stops a call. Under a live plan, an audit row with `would_be` also carries the plan's `plan_id` and `prompt_id`. Signed out, a plan is recorded locally and nothing is sent.

### Token usage sync

While observability is on, ArmorCodex uploads token counts per session, model, UTC date and UTC
hour, with the session's working directory and the device name. It sends no prompts or transcript
text, and only usage dated after the current login unless the dashboard asks the device for its
earlier history.

- Each `Stop` uploads that session's usage (its rollout and its subagents' rollouts) on its own.
- `plugins/armorcodex/scripts/usage-worker.mjs --serve` runs while at least one Codex session is
  open: `SessionStart` registers the session and starts it, `SessionEnd` removes the session, and
  it exits when none is left. Every 60 seconds it uploads sessions that changed without a `Stop`,
  retries failed uploads, and handles the dashboard's earlier-history request.

`SessionEnd` is a new hook. Codex runs a hook only after you trust it, so after updating run
`/hooks` in Codex once and trust ArmorCodex's `SessionEnd` hook. The other ArmorCodex hooks are
unchanged and keep their trust. Without it the worker still exits when Codex itself exits.

## Data & Privacy

ArmorCodex sends one small anonymous usage ping on the first session or prompt of each UTC
day, whether you are signed in or not. It sends a random install id, the plugin name and
version, the host agent and its version (when known), your OS, whether you are signed in,
the backend environment, and daily counts of plans, blocks and approval requests made while
signed out. Counts cover up to seven earlier UTC days. The install id lives in
`~/.armoriq/install-id`, is shared by the ArmorIQ plugins in that home, and is separate from
sign in. It is never used to identify your account or sent anywhere except the daily ping.

The ping never sends prompts, plans, tool names, arguments, paths, repo names, emails,
keys, the sign in device id, or IP addresses. ArmorIQ's app never stores the sender's IP
address, although Google Cloud's request logs record it at the infrastructure level.
Anonymous ping rows and daily counts are kept indefinitely. Signed in token usage reports
have their own controls and payload.

You can turn the ping off with any of these:

- Set `DO_NOT_TRACK=1` or `DO_NOT_TRACK=true`.
- Set `ARMORIQ_USAGE_PING_DISABLED=1`, `true`, or `yes`.
- Set `"usagePing": false` in `~/.armoriq/settings.json`, keeping any other settings.

Environment values ignore case and surrounding spaces. A malformed or unreadable settings
file, a value of the wrong type, or a backend outside the supported production and staging
origins also disables the ping. Disabled pings create no install id, ping claim or counter
files. No reminder changes your ping setting.

If you are not signed in, ArmorCodex also shows a sign in reminder at session start, at
most once per UTC day. It appears only to you and makes no network request. Hide it with
`ARMORIQ_SIGNIN_REMINDER_DISABLED=1` (also `true` or `yes`, ignoring case and surrounding
spaces), or set `"signInReminder": false` in `~/.armoriq/settings.json`. A malformed or
unreadable settings file or a value of the wrong type hides it for that run. `DO_NOT_TRACK`
and `usagePing` do not hide this reminder.

## Policy Commands

Structured `armor` commands (staged: nothing applies until you confirm):

> Type these as plain prompts with no leading slash: `armor policy list`, not `/armor`. Codex reserves `/` for its own built-in commands, so ArmorCodex intercepts the `armor ...` text in the `UserPromptSubmit` hook.

- `armor policy list` and `armor policy view`
- `armor policy add deny bash` (or `allow`/`hold`; multiple: `add allow bash and apply_patch, deny apply_patch`)
- `armor policy remove <id>`
- `armor policy reset`
- `armor policy default deny|allow|hold` (unmatched-tool default)
- `armor policy template <all-allow|lockdown|strict-read-only|balanced>`
- `armor profile save|list|switch|delete <name>`
- `armor mcp approve|deny <server>` and `armor mcp list`
- `armor yes` / `armor no` to apply or discard the staged change

Staging a change shows a diff and risk warnings; applying is human-only (the MCP `policy_command` tool can read and stage, but only a terminal `armor yes` applies). See [POLICY_GUIDE.md](POLICY_GUIDE.md).

Natural-language commands still work for quick edits (applied immediately):

- `Policy list`, `Policy get <id>`, `Policy delete <id>`, `Policy reset`
- `Policy new: deny Bash for payment data`
- `Policy update <id>: allow Bash`
- `Policy prioritize <id> <position>`

## Tests

```bash
cd plugins/armorcodex
npm test
```

## Repository Structure

```
armorCodex/
├── .codex/hooks.json              # Repo-local Codex hook registration
├── .codex-plugin/plugin.json      # Codex plugin manifest
├── .mcp.json                      # ArmorCodex MCP server config
├── hooks/hooks.json               # Plugin-local hook reference
├── scripts/
│   ├── bootstrap.mjs              # Lazy dependency installer and dispatcher
│   ├── hook-router.mjs            # Codex hook router
│   ├── policy-mcp.mjs             # MCP server
│   └── lib/                       # Policy, intent, IAP, crypto, runtime modules
└── tests/
```
