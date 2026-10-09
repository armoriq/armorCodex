# ArmorCodex — Apps SDK / Codex Marketplace Prerequisites

> **Goal:** get ArmorCodex listed in the in-product Codex plugins marketplace ("Make Codex work your way" surface) via OpenAI's official submission path.

## 🆕 Status snapshot — 2026-06-24 re-verification

A month after the original write-up, two things changed materially:

1. **Apps SDK submission portal is LIVE at `https://platform.openai.com/apps-manage`.** Accepting third-party submissions today. The "submission unavailable" framing in the original v1 of this doc is outdated.
2. **Approved ChatGPT App → automatic Codex plugin listing.** OpenAI's doc explicitly says: "When you publish an approved app, OpenAI creates the plugin for Codex distribution." So Apps SDK is a single submission with two surfaces (ChatGPT App Directory + Codex Plugin Directory).

What's still the same:
- **Hard requirement: remote HTTPS MCP server.** Local stdio (what we ship today) is explicitly listed as not acceptable.
- **Direct Codex plugin self-serve still "coming soon"** with no ETA.
- **KYB / developer verification at `platform.openai.com` is mandatory** before the submission form opens.
- `hashgraph-online/awesome-codex-plugins` is **not** referenced by OpenAI's docs as a canonical marketplace (it's community-curated).

### Submission paths today

| # | Path | Live? | What it gets us | Effort |
|---|---|---|---|---|
| 1 | Apps SDK → ChatGPT App → auto Codex listing | ✅ live | Both surfaces in one submission | 2-3 weeks (build remote HTTPS MCP variant + OAuth + KYB) |
| 2 | Wait for direct Codex plugin self-serve | ❌ coming soon, no ETA | Codex Plugin Directory only | Indefinite |
| 3 | OpenAI partnerships outreach | Always available | Either or both surfaces, sponsor-curated | Async relationship work |
| 4 | Repo marketplace at `.agents/plugins/marketplace.json` | ✅ live | Self-installable by URL, not "Curated by OpenAI" | Already done in PR #189 |

### Recommendation today

**Path 1 (Apps SDK)** is the highest-leverage move because it gets BOTH surfaces. Requires the 2-3 weeks engineering to build a remote HTTPS MCP variant. **Path 4 is already done** — users can self-install ArmorCodex via the awesome-codex-plugins marketplace URL. **Path 3** (partnerships) can run in parallel with no engineering cost.

What's NOT useful: continuing to bet on Path 2 alone. The "coming soon" phrasing has been unchanged since May 2026 with no public update.

### Phase 1 work shipped in v0.3.0 (this commit)

These items are needed **regardless** of which submission path we pursue:

- ✅ MCP tool annotations (`readOnlyHint`, `destructiveHint`, `idempotentHint`, `openWorldHint`) on all 3 tools — the auto-reject blocker
- ✅ `plugin.json` + `package.json` 0.2.0 → 0.3.0
- ✅ `DATA_RETENTION.md` at repo root with 90-day retention, GDPR/CCPA paths, deletion flows
- ✅ `CHANGELOG.md` at repo root
- ✅ `SECURITY.md` mirrored at repo root (from plugin dir)
- ✅ `LICENSE` mirrored at repo root (MIT)

### Phase 2 — needed for Apps SDK submission specifically (Path 1)

These are the architectural items. They require a decision, not just engineering hours.

- [ ] Build hosted HTTPS MCP variant at e.g. `https://mcp.armoriq.ai/codex/mcp`
- [ ] OAuth 2.1 multi-tenant auth flow (replaces our API-key model for this surface)
- [ ] Create `support@armoriq.ai` mailbox + monitoring
- [ ] Create reviewer test account at `platform.armoriq.ai` with sample policies and audit history
- [ ] Capture 3-5 screenshots at OpenAI's required dimensions
- [ ] Complete KYB / developer verification at `platform.openai.com` (3-5 business day turnaround)
- [ ] First submission via `https://platform.openai.com/apps-manage`

### Phase 3 — parallel partnerships outreach

- [ ] Draft email to OpenAI developer relations / partnerships. Angle: ArmorClaude marketplace listing (Anthropic plugin marketplace), ArmorCodex traction (community awesome-codex-plugins #189), ArmorCopilot pipeline (github/copilot-plugins #43)
- [ ] Identify warm intro at OpenAI if possible

### Open decisions

1. **Commit to Path 1 (build remote MCP)?** This is the only path that lets us submit ASAP. Estimated 2-3 weeks engineering. Surfaces a different product wedge: "ArmorCodex Cloud" as a policy-management surface inside ChatGPT, complementing the local-runtime gating product.
2. **Path 3 outreach owner?** Who writes the partnerships email — Hari, Ketan, or Hui? What's the lead angle?
3. **KYB owner?** Identity / business verification at platform.openai.com needs a person — typically the founder or COO.

---

Sources re-verified 2026-06-24:

- [Plugin Directory submission flow](https://developers.openai.com/codex/plugins)
- [Apps SDK submission portal](https://developers.openai.com/apps-sdk/deploy/submission)
- [Apps SDK app submission guidelines](https://developers.openai.com/apps-sdk/app-submission-guidelines)
- [Codex plugins build guide](https://developers.openai.com/codex/plugins/build)
- [Developers can now submit apps to ChatGPT (announcement)](https://openai.com/index/developers-can-now-submit-apps-to-chatgpt/)

---

> Below: original 2026-05-21 write-up. Sections 1, 4, and 7 are superseded by the Status Snapshot above.

Sources (verified 2026-05-21):
- [Apps SDK overview](https://developers.openai.com/apps-sdk)
- [App submission guidelines](https://developers.openai.com/apps-sdk/app-submission-guidelines)
- [Submission portal](https://developers.openai.com/apps-sdk/deploy/submission)
- [Codex plugins build guide](https://developers.openai.com/codex/plugins/build)
- [Apps SDK MCP server guide](https://developers.openai.com/apps-sdk/build/mcp-server)
- [Apps SDK quickstart](https://developers.openai.com/apps-sdk/quickstart)
- [Apps SDK security & privacy](https://developers.openai.com/apps-sdk/guides/security-privacy)

---

## 1. Executive summary

There are **two paths** to the Codex in-product marketplace, and only one is live today:

| Path | Status | What it requires | Fit for ArmorCodex today |
|---|---|---|---|
| **ChatGPT App via Apps SDK** | LIVE (dashboard submission) | Remote HTTPS MCP server + ChatGPT App approval. Approved apps auto-generate a Codex plugin entry. | **Architectural mismatch** — our MCP server is local stdio. Needs a hosted remote MCP build. |
| **Direct Codex plugin self-serve** | "Coming soon" (no ETA per docs) | Presumably the local `.codex-plugin/plugin.json` we already have | We're ready — but no portal exists yet. |
| **Partnerships outreach** | Always available | OpenAI sponsor at company | Cold outreach unless we have a contact |

**Bottom line:** to actually appear in the in-product marketplace today, we'd need to build a remote (HTTPS) MCP server version of ArmorCodex and submit it as a ChatGPT App. The local stdio plugin we ship today CAN'T self-publish to the marketplace yet.

---

## 2. What "ChatGPT App" means for ArmorCodex (architecture)

OpenAI's docs are explicit:

> "ChatGPT requires HTTPS" — your MCP server must be reachable via public HTTPS.
> Dev path: `ngrok http <port>` → use ngrok URL as ChatGPT developer-mode connector.
> Production: deploy to "a low-latency HTTPS host."

ArmorCodex today:
- Plugin manifest at `.codex-plugin/plugin.json` ✓
- `.mcp.json` pointing to **local stdio MCP** spawned by Codex (`node ./scripts/bootstrap.mjs mcp`) ✗ (not what Apps SDK wants)
- Hooks routed via local Codex hook events ✗ (not invoked by ChatGPT)

To fit the Apps SDK model we'd need to:
1. **Build a hosted MCP server** (e.g., at `https://mcp.armoriq.ai/codex`) that exposes the same 3 tools (`register_intent_plan`, `policy_update`, `policy_read`) over HTTP transport
2. **Multi-tenant auth** via OAuth 2.1 (Apps SDK recommends this — not the API key model we use today)
3. Accept that ChatGPT calling our hosted MCP is a **different product surface** than our local Codex hook plugin — closer to a "policy management dashboard" tool than a runtime guard

This is a meaningful architecture decision. See section 8 below.

---

## 3. Submission materials checklist

This is what the OpenAI submission dashboard asks for. Everything you submit goes through manual review.

### 3.1 Identity & verification

| Item | Status | Notes |
|---|---|---|
| **OpenAI Platform Dashboard developer verification** | ✗ | Required: identity + organizational affiliation. Apply at platform.openai.com |
| **Company name + support contact** | ✗ | Need a dedicated support email (not `harisudhan@armoriq.io` personal). Suggest `support@armoriq.ai` |
| **Verified business email** | ✗ | OpenAI verifies via DNS/email |

### 3.2 App metadata

| Item | Status | Notes |
|---|---|---|
| App name (specific, not generic) | ✓ | "ArmorCodex" passes |
| Description (clear, accurate) | ✓ | `plugin.json` has both `shortDescription` and `longDescription` |
| App logo | ✓ | `assets/armoriq-logo.png` (verify dimensions match OpenAI's spec) |
| **Screenshots** | ✗ | **Missing.** OpenAI requires accurate screenshots with specific dimensions. Need 3–5 minimum showing: policy management UI, audit log dashboard, install flow, intent plan registration |
| **Localization info** | ✗ | Need to declare supported languages + regions (English-only fine for v1) |

### 3.3 Tool definitions (MCP)

Apps SDK validator will REJECT submissions missing tool annotations.

| Tool | Annotations needed | Current state |
|---|---|---|
| `register_intent_plan` | `readOnlyHint: false`, `destructiveHint: false`, `openWorldHint: false` | ✗ Missing all three |
| `policy_update` | `readOnlyHint: false`, `destructiveHint: true` (mutates), `openWorldHint: false` | ✗ Missing all three |
| `policy_read` | `readOnlyHint: true`, `destructiveHint: false`, `openWorldHint: false` | ✗ Missing all three |

**Action:** add annotations to all 3 tools in `plugins/armorcodex/scripts/policy-mcp.mjs`. Without them, submission auto-rejects.

Also required:
- Tool names must be **human-readable verbs** (we're OK — `register_intent_plan` etc are verb-based)
- **Minimal input schemas** — request only what's needed. Audit our schemas.
- **Tool descriptions must match actual behavior** — review current descriptions against runtime behavior

### 3.4 Privacy + legal

| Item | Status | Notes |
|---|---|---|
| Privacy policy URL | ✓ | `https://armoriq.ai/privacy` declared. **Need to verify** content covers: data categories, purposes, recipients, retention, user controls |
| Terms of service URL | ✓ | `https://armoriq.ai/terms` declared. **Need to verify** content is current and ToS-shaped |
| **Data retention policy** | ✗ | Must be published. We audit-log to ArmorIQ backend — need to document retention window (90d? 365d?) |
| **No restricted data collected** | ⚠️ | Need to verify. Hard prohibitions: PCI DSS, PHI, government IDs, credentials, auth secrets. Our audit pipeline captures intent/tool/payload — must confirm we don't accidentally capture user credentials in payloads |

### 3.5 Authentication

| Item | Status | Notes |
|---|---|---|
| OAuth 2.1 flow | ✗ | Apps SDK recommends OAuth 2.1 for external account integration. Today we use API keys — would need an OAuth provider for the remote MCP variant |
| Client ID Metadata Documents (CIMD) | ✗ | Recommended when available |
| **Test account with sample data** | ✗ | **Mandatory.** Need a working `support@armoriq.ai` (or similar) account at `platform.armoriq.ai` with policies, audit history, and an org for reviewers to log into |

### 3.6 Quality + UX

| Item | Status | Notes |
|---|---|---|
| App must work end-to-end | ✓ | ArmorCodex is shipped and stable |
| No "trial / demo" — must be complete | ✓ | We're a real product |
| Stability & low latency | ✓ | <200ms hook overhead after PR #15 |
| Error handling | ✓ | Hooks fall back to allow on backend errors |
| Tool descriptions accurate | ✓ | But review per 3.3 above |
| UX follows OpenAI's UX principles & UI guidelines | ⚠️ | Only relevant if we ship a UI widget. Tools-only is fine. |

### 3.7 Behavioral compliance

| Hard prohibitions (per submission guidelines) | Our position |
|---|---|
| Cannot serve advertisements | ✓ — none |
| Cannot scrape external sites without auth | ✓ — we only call our own backend |
| No competitor disparagement in tool/app descriptions | ✓ — check existing copy |
| Cannot impersonate OpenAI / imply OpenAI endorsement | ✓ — clean |
| No deceptive or copycat designs | ✓ — clean |
| Cannot manipulate model selection (no "always use ArmorCodex" hints) | ⚠️ — verify our defaultPrompt doesn't violate |
| No prohibited verticals (adult, gambling, weapons, drugs, fraud, malware) | ✓ — we're security |

### 3.8 Versioning

| Item | Status | Notes |
|---|---|---|
| `version` in `plugin.json` | 0.2.0 | **Stale.** Bump to 0.3.0 to reflect post-latency-port shipped state |
| Git tag for release | ✗ | Tag `v0.3.0` once version bumps |
| Changelog / release notes | ✗ | Need CHANGELOG.md or release notes. OpenAI submission asks for "release notes" |

---

## 4. Architectural gap detail — remote MCP server

This is the BIG decision. Two sub-paths:

### Option A: Build hosted-MCP variant of ArmorCodex

- New repo or new package: `armoriq/armorcopilot-mcp-cloud` (or similar)
- HTTPS endpoint: e.g., `https://mcp.armoriq.ai/codex/mcp` (POST-shaped MCP)
- Same 3 tools, but called by ChatGPT instead of local Codex
- Multi-tenant via OAuth — user logs in to ArmorIQ, ChatGPT receives an OAuth token to call our MCP
- **Caveat:** ChatGPT calling our MCP gives us policy management surface, **not runtime tool-call gating** (we can't intercept ChatGPT's other tool calls from outside)
- This becomes a different product: "ArmorCodex Cloud" — policy + audit dashboard accessible via ChatGPT

### Option B: Wait for direct Codex plugin self-serve

- Per docs: "Adding plugins to the official Plugin Directory is coming soon. Self-serve plugin publishing and management are coming soon."
- No published ETA
- When it ships, our current local plugin should fit
- Risk: timeline unknown — could be weeks or quarters

### Option C: Partnerships outreach (parallel to A)

- Cold-outreach OpenAI's developer relations / partnerships team
- Use ArmorClaude marketplace listing + community awesome-codex-plugins #140 as proof of traction
- May unlock a "we'll sponsor your submission" path similar to how Figma/Slack/etc got listed
- Effort: relationship-building, not engineering

**Recommendation**: pursue Option B (passive wait + preparation) + Option C (cold outreach for warm intro) in parallel. **Don't pursue Option A unless we have a clear customer wedge for cloud-side ArmorCodex** — would split focus from the local plugin which is already validated.

---

## 5. What's READY TO SHIP today (preparation work, regardless of path)

These are all things we can finish NOW so we're submission-ready the moment self-serve opens (or we get a partnerships sponsor). None require the cloud architecture decision.

### Tier 1: must-fix blockers
- [ ] Add MCP tool annotations (`readOnlyHint`, `destructiveHint`, `openWorldHint`) to all 3 tools in `policy-mcp.mjs`
- [ ] Bump `plugin.json` version 0.2.0 → 0.3.0 + git tag v0.3.0
- [ ] Verify privacy policy at `armoriq.ai/privacy` covers all required clauses (data categories, purposes, recipients, retention, user controls)
- [ ] Verify terms of service at `armoriq.ai/terms` is current
- [ ] Publish data retention policy (could be a `DATA_RETENTION.md` in repo + linked from privacy policy)
- [ ] Audit our audit pipeline payloads — confirm we never capture credentials, PII secrets, or restricted data types

### Tier 2: submission materials
- [ ] Create `support@armoriq.ai` mailbox + monitoring
- [ ] Create a "review-only" test account at `platform.armoriq.ai` (e.g., `reviewers@armoriq.ai`) with sample data
- [ ] Capture 3–5 screenshots at OpenAI's required dimensions (TBD when we get to the dashboard)
- [ ] Write a CHANGELOG.md + release notes for v0.3.0
- [ ] Add a `SECURITY.md` and `LICENSE` to the repo (the latter exists — verify it's MIT)
- [ ] Add `app_name`/marketing copy variations if needed

### Tier 3: nice-to-have
- [ ] Audit tool descriptions in `policy-mcp.mjs` for accuracy + non-promotional language
- [ ] Audit `defaultPrompt` in `plugin.json` for "manipulating model selection" red flags
- [ ] Consider OAuth 2.1 implementation in our backend (if pursuing remote-MCP path)
- [ ] Apply for developer verification at platform.openai.com

---

## 6. Current `plugin.json` vs Apps SDK manifest fields

Cross-reference our current manifest to what OpenAI documents as supported:

| OpenAI field | We have it | Value |
|---|---|---|
| `name` | ✓ | `armorcodex` |
| `version` | ✓ (stale) | `0.2.0` → bump to `0.3.0` |
| `description` | ✓ | Long, accurate |
| `author` | ✓ | ArmorIQ |
| `homepage` | ✓ | `https://armoriq.ai` |
| `repository` | ✓ | `https://github.com/armoriq/armorCodex` |
| `license` | ✓ | MIT |
| `keywords` | ✓ | 7 keywords |
| `hooks` (component pointer) | ✓ | `./.codex/hooks.json` |
| `mcpServers` (component pointer) | ✓ | `./.mcp.json` |
| `apps` (component pointer) | ✗ | Not applicable yet — would be for `.app.json` if we ship a widget |
| `skills` (component pointer) | ✗ | Not applicable — no skills yet |
| `interface.displayName` | ✓ | ArmorCodex |
| `interface.shortDescription` | ✓ | "Intent-based security policy and audit for Codex." |
| `interface.longDescription` | ✓ | Present |
| `interface.developerName` | ✓ | ArmorIQ |
| `interface.category` | ✓ | Security |
| `interface.capabilities` | ✓ | `["MCP", "Hooks"]` |
| `interface.websiteURL` | ✓ | `https://armoriq.ai` |
| `interface.privacyPolicyURL` | ✓ | `https://armoriq.ai/privacy` |
| `interface.termsOfServiceURL` | ✓ | `https://armoriq.ai/terms` |
| `interface.brandColor` | ✓ | `#00E5CC` |
| `interface.composerIcon` | ✓ | `./assets/icon.png` |
| `interface.logo` | ✓ | `./assets/icon.png` |
| `interface.screenshots` | ✗ | **Missing — required** |
| `interface.defaultPrompt` | ✓ | 3 prompts |
| `userConfig` | ✓ | 5 fields (api_key, mode, intent_required, crypto_policy_enabled, use_production) |

---

## 7. Concrete action plan (sequence)

Ordered by leverage + reversibility. Do Tier 1 first.

| # | Action | Effort | Blocks submission? |
|---|---|---|---|
| 1 | Add `readOnlyHint` / `destructiveHint` / `openWorldHint` to `policy-mcp.mjs` for all 3 tools | 30 min | YES (auto-reject) |
| 2 | Bump `plugin.json` version 0.2.0 → 0.3.0, git tag v0.3.0 | 10 min | No, but stale version looks bad in review |
| 3 | Verify `armoriq.ai/privacy` + `armoriq.ai/terms` content is submission-ready | 30 min (audit + fix) | YES if missing clauses |
| 4 | Publish `DATA_RETENTION.md` + link from privacy policy | 30 min | YES |
| 5 | Code audit: confirm audit logs never contain credentials or restricted data types | 1 hour | YES (would auto-reject during review) |
| 6 | Create `support@armoriq.ai` + monitoring | 30 min | YES |
| 7 | Create reviewer test account at `platform.armoriq.ai` | 1 hour | YES |
| 8 | Write CHANGELOG.md + release notes for v0.3.0 | 30 min | YES |
| 9 | Add SECURITY.md to repo | 20 min | Recommended |
| 10 | Capture 3–5 screenshots | 1 hour | YES |
| 11 | Apply for developer verification at platform.openai.com | 15 min (then waiting period) | YES |
| 12 | (Optional, big) Build hosted-MCP variant for Apps SDK path | 2–3 weeks | Only if pursuing option A |
| 13 | OpenAI partnerships cold outreach | Async | Only path that bypasses self-serve wait |

**Total effort for Tier 1 + Tier 2 (steps 1–11): ~6 hours engineering + waiting for OpenAI verification.** Can be done in a single focused day.

---

## 8. Open decisions

1. **Local plugin vs hosted-MCP architecture** — wait, build cloud, or both? Decision lives with Hari + Ketan + Hui. Recommend wait + cold outreach unless cloud wedge surfaces.
2. **OpenAI partnerships outreach** — who's writing the email? What's the angle (ArmorClaude marketplace listing + ArmorCodex traction + ArmorCopilot pipeline)?
3. **Reviewer test account credentials** — where do we store these long-term? 1Password / Vault?
4. **Production support email** — `support@armoriq.ai` vs new domain. Need to set up SES/Sendgrid + monitoring.

---

## 9. Tracking issue

Will file: `armoriq/armorCodex: tracking: prepare for OpenAI Apps SDK submission (Codex marketplace listing)`. Subtasks = the 11 Tier 1+2 items above.

---

*Verified against OpenAI docs 2026-05-21. Re-verify before submission since "self-serve coming soon" implies the process is still evolving.*
