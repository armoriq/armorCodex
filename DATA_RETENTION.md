# ArmorCodex Data Retention Policy

**Last updated:** 2026-06-24
**Applies to:** ArmorCodex plugin v0.3.0 and later, the ArmorIQ backend it talks to (api.armoriq.ai), and the ArmorIQ admin dashboard (platform.armoriq.ai).

This document describes what ArmorCodex captures, how long ArmorIQ keeps it, and how to delete it.

## Summary

| Data category | Where it lives | Retention | How to delete |
|---|---|---|---|
| Intent plans | ArmorIQ backend (per org) | **90 days** | `armoriq delete-history --plans` |
| Audit log entries (tool calls) | ArmorIQ backend (per org) | **90 days** | `armoriq delete-history --audit` |
| Policy rules + version history | ArmorIQ backend (per org) | **Indefinite while account active**, 30 days after account deletion | Account deletion via `developers@armoriq.io` |
| API keys | ArmorIQ backend (per user, per org) | Until revoked + 30 days | `armoriq keys revoke <id>` |
| OAuth credentials (when applicable) | ArmorIQ backend | Until token revocation + 30 days | OAuth revoke flow |
| Local audit WAL | Customer machine, `~/.codex/armorcodex/audit/` | Cleared on plugin uninstall or by user | `rm -rf ~/.codex/armorcodex/` |
| Pending intent plan files | Customer machine, `~/.codex/armorcodex/pending-plan.json` | Replaced per prompt, removed on session end | n/a (ephemeral) |
| Account metadata (email, org membership) | ArmorIQ backend | While account active, 30 days after deletion | Account deletion request |

## What ArmorCodex does NOT capture

ArmorCodex never captures or transmits the following from a customer machine:

- **Credentials, API keys, OAuth tokens, or session cookies** — the arg-sanitizer scrubs any field name matching `password|secret|token|key|credential|auth` before any payload leaves the host.
- **Source file contents** — only tool *names* and *redacted* argument shapes are recorded. File paths are recorded; file bodies are not.
- **Restricted data types** — PCI cardholder data, PHI, government IDs, biometric identifiers. The data classifier in `scripts/lib/policy.mjs` detects and refuses to forward payloads matching these classes.
- **End-user prompts in full** — only the first line of the user's prompt is recorded (as plan context). Full prompts stay local.

For the complete list of fields captured per audit row, see `plugins/armorcodex/scripts/lib/audit-wal.mjs:auditRowSchema`.

## Retention windows in detail

### Intent plans + audit log: 90 days

After 90 days, audit rows and intent-plan records are deleted from the ArmorIQ backend's hot store. Aggregated metrics (count of tool calls per day per org, count of denies, etc.) are kept indefinitely for billing and analytics — but the underlying row-level records are deleted.

Customers on the Enterprise tier can request extended retention (up to 1 year) via support.

### Policy rules: indefinite while account active

Your policy rules and their full version history are kept as long as your ArmorIQ org account is active. After account deletion (see below), all policy rules are deleted within 30 days.

### API keys: until revoked + 30 days

Revoked API keys are kept in a "revoked" state for 30 days so audit rows that reference them can still be linked back to the actor that performed each action. After 30 days, the key record is purged.

## How to delete your data

### Self-service

- **Revoke an API key**: `armoriq keys revoke <key-id>` (or via the dashboard)
- **Delete audit + plan history** (org admin only): `armoriq delete-history --product armorcodex`
- **Delete local plugin data**: `rm -rf ~/.codex/armorcodex/`

### Full account deletion

Email **developers@armoriq.io** with the subject `[Account deletion]` and your org ID. We respond within 2 business days, complete the deletion within 30 days, and confirm by email when done. After deletion:

- All policy rules, audit rows, intent plans, API keys, OAuth tokens, and user/org metadata associated with your account are removed from the ArmorIQ backend
- Aggregated metrics (counts only, no row-level data) are retained indefinitely for billing reconciliation
- Backups containing your data are purged within an additional 30 days

## GDPR / CCPA rights

ArmorIQ is the data controller for data captured by ArmorCodex. EU and California residents have the right to:

- Access (a copy of data we hold)
- Rectification (correct inaccurate data)
- Erasure (right to be forgotten — covered by the account deletion flow above)
- Restriction (limit processing)
- Portability (machine-readable export)
- Objection (object to processing)

Email **license@armoriq.io** to exercise any of these rights. We respond within 30 days.

## Contact

- General support: `developers@armoriq.io`
- Privacy + data requests: `license@armoriq.io`
- Security disclosure: `developers@armoriq.io`
- Policy questions: refer to https://armoriq.ai/privacy-policy

## Changes to this policy

Material changes are announced at least 30 days in advance via the ArmorIQ status page and in the in-product changelog. Minor edits (typo fixes, link updates) are reflected by updating the **Last updated** date at the top of this document.
