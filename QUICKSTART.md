# ArmorCodex Quickstart

## 1. Enable Codex Hooks

```toml
# ~/.codex/config.toml
[features]
codex_hooks = true
```

## 2. Install Dependencies

```bash
npm install
```

## 3. Run Codex From This Repo

The repository includes `.codex/hooks.json`, so Codex loads ArmorCodex hooks when started from this checkout:

```bash
codex
```

Try:

```text
Policy list
```

Then ask Codex to run a shell command. ArmorCodex will inject an instruction to register an intent plan first, and will block Bash commands that do not match the registered plan in enforce mode.

## 4. Optional ArmorIQ Backend

```bash
export ARMORIQ_API_KEY=...
```

Without an API key, ArmorCodex still performs local policy and local plan enforcement. With an API key, it can request signed intent tokens and send audit logs.

## Current Limitation

Codex hooks currently intercept Bash for `PreToolUse`, `PermissionRequest`, and `PostToolUse`. Other Codex tools are not directly gated by ArmorCodex hooks yet.

For the full list of OpenAI Codex harness limitations ArmorCodex depends on, see [Codex harness limitations](CODEX_HARNESS_LIMITATIONS.md).
