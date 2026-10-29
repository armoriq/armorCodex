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
armoriq login --product armorcodex
```

Without a saved login, ArmorCodex performs local policy and local plan enforcement. After login, it can request signed intent tokens and send audit logs.

## Update

Re-run the installer you installed with. It updates the existing install in place and keeps your login:

```bash
curl -fsSL https://armoriq.ai/install_armorcodex.sh | bash       # stable
curl -fsSL https://armoriq.ai/install_armorcodex_dev.sh | bash   # dev
```

If it finds no ArmorIQ login, it keeps the install and prints the login command to run.

## Current Limitation

Codex hooks currently intercept Bash for `PreToolUse`, `PermissionRequest`, and `PostToolUse`. Other Codex tools are not directly gated by ArmorCodex hooks yet.

For the full list of OpenAI Codex harness limitations ArmorCodex depends on, see [Codex harness limitations](CODEX_HARNESS_LIMITATIONS.md).
