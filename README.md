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
- `policy_update`

## Configuration

Sign in with `armoriq login --product armorcodex --backend https://api.armoriq.ai` (production) or `--backend https://staging-api.armoriq.ai` (staging, with `ARMORIQ_ENV=staging`). If you point ArmorCodex at another backend, pass that origin instead. ArmorCodex reads the API key from `~/.armoriq/credentials.json`.

Core environment variables:

| Variable | Default | Description |
| --- | --- | --- |
| `ARMORCODEX_MODE` | `enforce` | `enforce` blocks failures; `monitor` logs only |
| `ARMORCODEX_INTENT_REQUIRED` | `true` | Require a registered intent plan before Bash |
| `ARMORCODEX_DATA_DIR` | `~/.codex/armorcodex` | Runtime, policy, and pending-plan storage |
| `ARMORCODEX_DEBUG` | `false` | Debug logs on stderr |
| `ARMORIQ_API_KEY` | from `~/.armoriq/credentials.json` | ArmorIQ backend key |
| `ARMORCODEX_AUDIT_ENABLED` | true when API key exists | Send audit logs |
| `ARMORCODEX_CRYPTO_POLICY_ENABLED` | `false` | Enable Merkle policy binding |

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
