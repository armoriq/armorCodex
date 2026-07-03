#!/usr/bin/env bash
set -euo pipefail

# ArmorCodex installer for OpenAI Codex.
#
# Usage:
#   curl -fsSL https://armoriq.ai/install_armorcodex.sh | bash
#
# Works two ways:
#   A. curl-pipe (no clone): script fetches the plugin into ~/.armoriq/armorCodex
#   B. From an existing checkout: cd armorCodex && bash install_armorcodex.sh
#
# Wires the four things Codex actually reads on CLI 0.125.0+:
#   1. [features] hooks = true            in ~/.codex/config.toml
#   2. [mcp_servers.armorcodex-policy]          in ~/.codex/config.toml
#   3. ~/.codex/hooks.json with absolute paths  (so hooks fire from any folder)
#   4. plugin npm dependencies                  (so the first hook fire is fast)
#
# Idempotent: re-running won't double-write any block. Will not overwrite a
# user's existing global hooks file unless --force-hooks is passed. If the
# plugin and credentials are already in place, the script runs in update mode
# (refresh checkout + SDK + npm deps, skip the login prompt).
#
# Flags:
#   --uninstall       remove ArmorCodex blocks
#   --force-hooks     overwrite existing ~/.codex/hooks.json
#   --force-install   force the full install flow even if already installed
#   --update          force update mode even without credentials
#
# Non-interactive overrides:
#   ARMORCODEX_MARKETPLACE_REPO   override marketplace source (testing)
#   ARMORCODEX_GIT_URL            override fork source (testing)
#   ARMORCODEX_GIT_REF            branch / tag (default main)
#   ARMORCODEX_INSTALL_HOME       where to clone (default ~/.armoriq/armorCodex)
#   ARMORIQ_FORCE_INSTALL=1       same as --force-install

R=$'\033[1;31m'
G=$'\033[32m'
Y=$'\033[33m'
C=$'\033[38;2;0;229;204m'
M=$'\033[38;2;185;112;255m'
B=$'\033[1m'
D=$'\033[0;90m'
N=$'\033[0m'

MARKETPLACE_REPO="${ARMORCODEX_MARKETPLACE_REPO:-armoriq/armorCodex}"
PLUGIN_GIT_URL="${ARMORCODEX_GIT_URL:-https://github.com/armoriq/armorCodex.git}"
PLUGIN_GIT_REF="${ARMORCODEX_GIT_REF:-main}"
INSTALL_HOME="${ARMORCODEX_INSTALL_HOME:-${HOME}/.armoriq/armorCodex}"
DASHBOARD_URL="https://platform.armoriq.ai"

# Recover if the caller is running this from a deleted directory (common when
# piping curl into bash from /tmp).
pwd >/dev/null 2>&1 || cd "${HOME:-/}"

# If invoked via `bash <(curl ...)` BASH_SOURCE may not point at a real file.
# Detect that and fall back to clone-mode.
SCRIPT_PATH="${BASH_SOURCE[0]:-}"
if [[ -n "${SCRIPT_PATH}" && -f "${SCRIPT_PATH}" ]]; then
  SCRIPT_DIR="$(cd "$(dirname "${SCRIPT_PATH}")" && pwd)"
else
  SCRIPT_DIR=""
fi

# Plugin sources live under plugins/<name>/ per the Codex marketplace spec.
# Older checkouts kept everything at repo root, so accept both layouts.
PLUGIN_SUBDIR="plugins/armorcodex"
if [[ -n "${SCRIPT_DIR}" && -f "${SCRIPT_DIR}/${PLUGIN_SUBDIR}/scripts/bootstrap.mjs" ]]; then
  PLUGIN_ROOT="${SCRIPT_DIR}"
elif [[ -n "${SCRIPT_DIR}" && -f "${SCRIPT_DIR}/scripts/bootstrap.mjs" ]]; then
  # Legacy flat-layout fallback so existing checkouts keep working.
  PLUGIN_ROOT="${SCRIPT_DIR}"
  PLUGIN_SUBDIR="."
else
  PLUGIN_ROOT="${INSTALL_HOME}"
fi

CONFIG_TOML="${HOME}/.codex/config.toml"
GLOBAL_HOOKS="${HOME}/.codex/hooks.json"
PLUGIN_PATH="${PLUGIN_ROOT}/${PLUGIN_SUBDIR}"
BOOTSTRAP_PATH="${PLUGIN_PATH}/scripts/bootstrap.mjs"

MARK_BEGIN="# >>> ArmorCodex managed block (do not edit manually) >>>"
MARK_END="# <<< ArmorCodex managed block <<<"

FORCE_HOOKS=0
DO_UNINSTALL=0
FORCE_MODE=""
if [[ "${ARMORIQ_FORCE_INSTALL:-0}" == "1" ]]; then
  FORCE_MODE="install"
fi
for arg in "$@"; do
  case "$arg" in
    --force-hooks) FORCE_HOOKS=1 ;;
    --uninstall) DO_UNINSTALL=1 ;;
    --force-install) FORCE_MODE="install" ;;
    --update) FORCE_MODE="update" ;;
    -h|--help)
      sed -n '4,35p' "${SCRIPT_PATH:-$0}" 2>/dev/null || true
      exit 0
      ;;
  esac
done

# ---------------------------------------------------------------------------
# UI helpers
# ---------------------------------------------------------------------------

ok()      { printf "${G}✔${N} %s\n" "$*"; }
warn()    { printf "${Y}!${N} %s\n" "$*"; }
err()     { printf "${R}✘${N} %s\n" "$*" 1>&2; }
info()    { printf "${D}·${N} %s\n" "$*"; }
section() { printf "\n${B}${M}┃ %s${N}\n" "$*"; }

banner() {
  cat <<EOF

${C}${B}     █████╗ ██████╗ ███╗   ███╗ ██████╗ ██████╗  ██████╗ ██████╗ ██████╗ ███████╗██╗  ██╗${N}
${C}${B}    ██╔══██╗██╔══██╗████╗ ████║██╔═══██╗██╔══██╗██╔════╝██╔═══██╗██╔══██╗██╔════╝╚██╗██╔╝${N}
${C}${B}    ███████║██████╔╝██╔████╔██║██║   ██║██████╔╝██║     ██║   ██║██║  ██║█████╗   ╚███╔╝ ${N}
${C}${B}    ██╔══██║██╔══██╗██║╚██╔╝██║██║   ██║██╔══██╗██║     ██║   ██║██║  ██║██╔══╝   ██╔██╗ ${N}
${C}${B}    ██║  ██║██║  ██║██║ ╚═╝ ██║╚██████╔╝██║  ██║╚██████╗╚██████╔╝██████╔╝███████╗██╔╝ ██╗${N}
${C}${B}    ╚═╝  ╚═╝╚═╝  ╚═╝╚═╝     ╚═╝ ╚═════╝ ╚═╝  ╚═╝ ╚═════╝ ╚═════╝ ╚═════╝ ╚══════╝╚═╝  ╚═╝${N}

      ${D}Intent-based security enforcement for OpenAI Codex${N}
      ${D}Policy rules · Intent verification · CSRG proofs · Audit logging${N}

EOF
}

# ---------------------------------------------------------------------------
# Prereq checks
# ---------------------------------------------------------------------------

require_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    err "missing required command: $1"
    case "$1" in
      codex) echo "  install Codex from https://developers.openai.com/codex" 1>&2 ;;
      node)  echo "  install Node.js >= 20 from https://nodejs.org" 1>&2 ;;
      git)   echo "  install git from https://git-scm.com/downloads" 1>&2 ;;
      npm)   echo "  npm comes bundled with Node.js" 1>&2 ;;
    esac
    exit 1
  fi
}

check_node_version() {
  local raw major
  raw="$(node --version 2>/dev/null || true)"
  major="$(printf '%s' "${raw#v}" | cut -d. -f1)"
  if [[ -z "${major}" || "${major}" -lt 20 ]]; then
    err "Node.js >= 20 required (found ${raw:-none})"
    exit 1
  fi
}

is_promptable() {
  [[ -e /dev/tty ]] || return 1
  (: < /dev/tty) 2>/dev/null || return 1
  return 0
}

prompt_yes_no() {
  local question="$1" default="${2:-Y}"
  local hint="(Y/n)"
  [[ "$default" == "N" ]] && hint="(y/N)"
  if ! is_promptable; then
    [[ "$default" == "Y" ]]; return $?
  fi
  printf "${B}?${N} %s ${D}%s${N} " "$question" "$hint" >&2
  local answer
  read -r answer < /dev/tty || answer=""
  [[ -z "$answer" ]] && { [[ "$default" == "Y" ]]; return $?; }
  [[ "$answer" =~ ^[Yy] ]]
}

# ---------------------------------------------------------------------------
# Managed-block helpers (idempotent config.toml editing)
# ---------------------------------------------------------------------------

strip_managed_block() {
  local file="$1"
  [[ -f "${file}" ]] || return 0
  awk -v b="${MARK_BEGIN}" -v e="${MARK_END}" '
    $0 == b { skip=1; next }
    $0 == e { skip=0; next }
    !skip   { print }
  ' "${file}" > "${file}.armorcodex.tmp"
  mv "${file}.armorcodex.tmp" "${file}"
}

upsert_managed_block() {
  local file="$1"
  local snippet="$2"
  mkdir -p "$(dirname "${file}")"
  touch "${file}"
  strip_managed_block "${file}"
  {
    printf '\n%s\n' "${MARK_BEGIN}"
    printf '%s\n' "${snippet}"
    printf '%s\n' "${MARK_END}"
  } >> "${file}"
}

# ---------------------------------------------------------------------------
# Plugin source + config wiring
# ---------------------------------------------------------------------------

fetch_plugin_source() {
  # Local-first: when this script is run from inside a checkout (bootstrap.mjs
  # already present next to it), install THAT local code and never clone. This
  # is how local testing wires Codex at your working branch. curl-pipe installs
  # (no local checkout) still clone from GitHub below.
  if [[ -f "${BOOTSTRAP_PATH}" ]]; then
    local branch
    branch="$(git -C "${PLUGIN_ROOT}" rev-parse --abbrev-ref HEAD 2>/dev/null || echo 'no-git')"
    info "installing LOCAL checkout at ${PLUGIN_ROOT} (${branch})"
    return 0
  fi

  mkdir -p "$(dirname "${INSTALL_HOME}")"

  if [[ -d "${INSTALL_HOME}/.git" ]]; then
    info "refreshing ${INSTALL_HOME} (git pull)"
    git -C "${INSTALL_HOME}" fetch --quiet origin "${PLUGIN_GIT_REF}" >/dev/null
    git -C "${INSTALL_HOME}" reset --hard --quiet "origin/${PLUGIN_GIT_REF}" >/dev/null
    ok "updated to ${PLUGIN_GIT_REF}"
  else
    info "cloning ${PLUGIN_GIT_URL} into ${INSTALL_HOME}"
    git clone --quiet --depth 1 --branch "${PLUGIN_GIT_REF}" "${PLUGIN_GIT_URL}" "${INSTALL_HOME}"
    ok "cloned to ${INSTALL_HOME}"
  fi

  PLUGIN_ROOT="${INSTALL_HOME}"
  if [[ -f "${PLUGIN_ROOT}/${PLUGIN_SUBDIR}/scripts/bootstrap.mjs" ]]; then
    PLUGIN_PATH="${PLUGIN_ROOT}/${PLUGIN_SUBDIR}"
  elif [[ -f "${PLUGIN_ROOT}/scripts/bootstrap.mjs" ]]; then
    PLUGIN_SUBDIR="."
    PLUGIN_PATH="${PLUGIN_ROOT}"
  else
    err "fetched repo is missing scripts/bootstrap.mjs, refusing to continue"
    exit 1
  fi
  BOOTSTRAP_PATH="${PLUGIN_PATH}/scripts/bootstrap.mjs"
}

ensure_config_toml() {
  # ARMORCODEX_USE_SDK_INTENT=true tells the MCP register_intent_plan tool to
  # call the ArmorIQ SDK so plans are registered with the backend (signed JWT
  # + dashboard visibility). The SDK round-trip is bounded by
  # ARMORCODEX_INTENT_DEADLINE_MS (default 500ms) so Codex's ~1s MCP transport
  # timeout is never violated; if the deadline is missed the call continues in
  # the background and the local plan is used as the fallback.
  # Managed block holds only the ArmorCodex MCP server table (unique to us,
  # safe to replace idempotently on re-run).
  local snippet
  snippet="$(cat <<EOF
[mcp_servers.armorcodex-policy]
command = "node"
args = ["${BOOTSTRAP_PATH}", "mcp"]
env = { ARMORCODEX_USE_SDK_INTENT = "true", ARMORCODEX_INTENT_DEADLINE_MS = "500" }
EOF
  )"
  upsert_managed_block "${CONFIG_TOML}" "${snippet}"

  # The hooks feature flag lives under [features] (named `hooks` on Codex
  # 0.142+, formerly `codex_hooks`). Codex itself may already define a
  # [features] table (e.g. js_repl), and TOML forbids two of the same table,
  # so merge the flag into the existing table instead of emitting our own
  # header (a second [features] is what caused "duplicate key [features]").
  if grep -qE '^[[:space:]]*(hooks|codex_hooks)[[:space:]]*=' "${CONFIG_TOML}"; then
    :
  elif grep -qE '^\[features\]' "${CONFIG_TOML}"; then
    awk 'BEGIN{done=0} !done && /^\[features\][[:space:]]*$/ {print; print "hooks = true"; done=1; next} {print}' \
      "${CONFIG_TOML}" > "${CONFIG_TOML}.armorcodex.tmp" \
      && mv "${CONFIG_TOML}.armorcodex.tmp" "${CONFIG_TOML}"
  else
    printf '\n[features]\nhooks = true\n' >> "${CONFIG_TOML}"
  fi
  ok "wired config.toml: hooks + mcp_servers.armorcodex-policy"
}

ensure_global_hooks() {
  if [[ -f "${GLOBAL_HOOKS}" && "${FORCE_HOOKS}" -eq 0 ]]; then
    if grep -q "ArmorCodex" "${GLOBAL_HOOKS}" 2>/dev/null; then
      ok "global hooks already reference ArmorCodex"
      return 0
    fi
    warn "global ${GLOBAL_HOOKS} exists and is unrelated"
    info "skipping (re-run with --force-hooks to overwrite)"
    info "or merge ${PLUGIN_ROOT}/.codex/hooks.json into it manually"
    return 0
  fi

  cat > "${GLOBAL_HOOKS}" <<EOF
{
  "hooks": {
    "SessionStart": [
      {
        "matcher": "startup|resume",
        "hooks": [
          { "type": "command", "command": "node ${BOOTSTRAP_PATH} router", "statusMessage": "Starting ArmorCodex" }
        ]
      }
    ],
    "UserPromptSubmit": [
      {
        "hooks": [
          { "type": "command", "command": "node ${BOOTSTRAP_PATH} router", "statusMessage": "Loading ArmorCodex intent policy" }
        ]
      }
    ],
    "PreToolUse": [
      {
        "matcher": "*",
        "hooks": [
          { "type": "command", "command": "node ${BOOTSTRAP_PATH} router", "statusMessage": "Checking ArmorCodex policy" }
        ]
      }
    ],
    "PermissionRequest": [
      {
        "matcher": "*",
        "hooks": [
          { "type": "command", "command": "node ${BOOTSTRAP_PATH} router", "statusMessage": "Checking ArmorCodex approval policy" }
        ]
      }
    ],
    "PostToolUse": [
      {
        "matcher": "*",
        "hooks": [
          { "type": "command", "command": "node ${BOOTSTRAP_PATH} router", "statusMessage": "Auditing ArmorCodex command" }
        ]
      }
    ]
  }
}
EOF
  ok "installed global ArmorCodex hooks at ${GLOBAL_HOOKS}"
}

install_npm_deps() {
  pushd "${PLUGIN_PATH}" >/dev/null
  if [[ -d node_modules/@armoriq/sdk && -d node_modules/zod && -d node_modules/@modelcontextprotocol/sdk ]]; then
    info "npm dependencies already present"
  else
    info "installing npm dependencies (--omit=dev)"
    npm install --omit=dev --silent --no-audit --no-fund >/dev/null
    ok "npm dependencies installed"
  fi
  popd >/dev/null
}

install_armoriq_cli() {
  info "installing ArmorIQ CLI ${B}(@armoriq/sdk)${N}"
  if npm install -g @armoriq/sdk@latest --silent --no-audit --no-fund >/dev/null 2>&1; then
    ok "armoriq CLI ready"
  else
    warn "couldn't install globally, use ${B}npx @armoriq/sdk${N} instead"
  fi
}

register_marketplace_optional() {
  if codex plugin --help 2>&1 | grep -q '^  marketplace'; then
    info "registering marketplace ${MARKETPLACE_REPO} (best-effort, surfaces in Desktop UI)"
    if codex plugin marketplace add "${MARKETPLACE_REPO}" >/dev/null 2>&1; then
      ok "marketplace registered"
    else
      codex plugin marketplace upgrade armorcodex >/dev/null 2>&1 || true
      info "marketplace add skipped (already added or unreachable)"
    fi
  fi
}

# ---------------------------------------------------------------------------
# Install mode detection
# ---------------------------------------------------------------------------

is_armorcodex_installed() {
  [[ -f "${INSTALL_HOME}/scripts/bootstrap.mjs" ]] \
    || [[ -f "${INSTALL_HOME}/plugins/armorcodex/scripts/bootstrap.mjs" ]]
}

detect_mode() {
  if [[ -n "${FORCE_MODE}" ]]; then
    printf '%s' "${FORCE_MODE}"
    return 0
  fi
  if [[ -f "${HOME}/.armoriq/credentials.json" ]] && is_armorcodex_installed; then
    printf 'update'
  else
    printf 'install'
  fi
}

run_update_path() {
  section "Refreshing plugin source"
  fetch_plugin_source

  section "Re-wiring Codex configuration"
  ensure_config_toml

  section "Re-checking global hooks"
  ensure_global_hooks

  section "Refreshing dependencies"
  pushd "${PLUGIN_PATH}" >/dev/null
  info "running npm install (--omit=dev) to pick up latest deps"
  npm install --omit=dev --silent --no-audit --no-fund >/dev/null \
    && ok "npm dependencies refreshed" \
    || warn "npm install failed, re-run manually if needed"
  popd >/dev/null
  install_armoriq_cli
}

finish_update_banner() {
  local sha=""
  if [[ -d "${INSTALL_HOME}/.git" ]]; then
    sha="$(git -C "${INSTALL_HOME}" rev-parse --short HEAD 2>/dev/null || true)"
  fi
  echo
  printf "${G}${B}ArmorCodex is up to date.${N}\n\n"
  if [[ -n "${sha}" ]]; then
    info "Plugin: ${INSTALL_HOME} (refreshed to ${sha})"
  else
    info "Plugin: ${INSTALL_HOME} (refreshed)"
  fi
  info "SDK:    @armoriq/sdk (latest)"
  info "Hooks:  ${GLOBAL_HOOKS} (verified)"
  if [[ ! -f "${HOME}/.armoriq/credentials.json" ]]; then
    echo
    printf "  Run ${G}${B}armoriq login --product armorcodex${N} to authenticate.\n"
  fi
  echo
}

# ---------------------------------------------------------------------------
# Verify + connect
# ---------------------------------------------------------------------------

verify_install() {
  section "Verifying"
  local issues=0
  if [[ ! -f "${BOOTSTRAP_PATH}" ]]; then
    warn "bootstrap.mjs missing at ${BOOTSTRAP_PATH}"
    issues=$((issues+1))
  fi
  if ! grep -qE '^[[:space:]]*(hooks|codex_hooks)[[:space:]]*=[[:space:]]*true' "${CONFIG_TOML}" 2>/dev/null; then
    warn "hooks feature flag not set in ${CONFIG_TOML}"
    issues=$((issues+1))
  fi
  if ! grep -q 'armorcodex-policy' "${CONFIG_TOML}" 2>/dev/null; then
    warn "MCP server entry missing from ${CONFIG_TOML}"
    issues=$((issues+1))
  fi
  if [[ ! -f "${GLOBAL_HOOKS}" ]]; then
    warn "global hooks file missing at ${GLOBAL_HOOKS}"
    issues=$((issues+1))
  fi
  if [[ "${issues}" -eq 0 ]]; then
    ok "armorcodex is wired up correctly"
  else
    warn "${issues} verification check(s) failed, see warnings above"
  fi
}

abort_install() {
  echo
  err "ArmorCodex requires an ArmorIQ account. Install aborted."
  echo
  info "rolling back..."
  if [[ -f "${CONFIG_TOML}" ]]; then
    strip_managed_block "${CONFIG_TOML}" 2>/dev/null && info "removed managed block from ${CONFIG_TOML}" || true
  fi
  if [[ -f "${GLOBAL_HOOKS}" ]] && grep -q "ArmorCodex" "${GLOBAL_HOOKS}" 2>/dev/null; then
    rm -f "${GLOBAL_HOOKS}" && info "removed ${GLOBAL_HOOKS}" || true
  fi
  if [[ -d "${INSTALL_HOME}" ]]; then
    rm -rf "${INSTALL_HOME}" && info "removed plugin source ${INSTALL_HOME}" || true
  fi
  echo
  printf "  Get an account at ${C}${B}https://armoriq.ai${N} and re-run when ready.\n\n"
  exit 1
}

connect_to_armoriq() {
  section "Connect to ArmorIQ"
  cat <<EOF

  Unlocks: signed JWT intent tokens, audit logs, CSRG proofs,
  and dashboard visibility for all intent plans at ${C}${DASHBOARD_URL}${N}.

EOF

  if [[ -n "${ARMORIQ_API_KEY:-}" ]] || [[ -f "$HOME/.armoriq/credentials.json" ]]; then
    ok "ArmorIQ credentials already present"
    return 0
  fi

  if ! is_promptable; then
    err "No TTY available for interactive login."
    printf "  Set ${B}ARMORIQ_API_KEY${N} or run interactively.\n"
    abort_install
  fi

  if ! prompt_yes_no "Connect your ArmorIQ account now?" "Y"; then
    abort_install
  fi

  echo
  # Pass --product so the browser approval page renders ArmorCodex branding.
  # Older CLIs without --product fall back to ARMORIQ_PRODUCT env var, which
  # newer CLIs also honor; older ones simply ignore it.
  local product="armorcodex"
  local login_ok=0
  if command -v armoriq-dev >/dev/null 2>&1; then
    if armoriq-dev login --help 2>&1 | grep -q -- '--product'; then
      armoriq-dev login --product "${product}" && login_ok=1
    else
      ARMORIQ_PRODUCT="${product}" armoriq-dev login && login_ok=1
    fi
  elif command -v armoriq >/dev/null 2>&1; then
    if armoriq login --help 2>&1 | grep -q -- '--product'; then
      armoriq login --product "${product}" && login_ok=1
    else
      ARMORIQ_PRODUCT="${product}" armoriq login && login_ok=1
    fi
  elif command -v npx >/dev/null 2>&1; then
    if npx @armoriq/sdk login --help 2>&1 | grep -q -- '--product'; then
      npx @armoriq/sdk login --product "${product}" && login_ok=1
    else
      ARMORIQ_PRODUCT="${product}" npx @armoriq/sdk login && login_ok=1
    fi
  else
    err "armoriq CLI not found."
    abort_install
  fi

  if [[ "${login_ok}" -ne 1 ]] || [[ ! -f "$HOME/.armoriq/credentials.json" ]]; then
    err "ArmorIQ login did not complete."
    abort_install
  fi

  echo
  ok "ArmorIQ connected. Codex will auto-load the key."
}

finale() {
  echo
  printf "${G}${B}ArmorCodex is installed.${N}\n"

  section "Quick start"
  cat <<EOF

  Start a Codex session in any project:

    ${G}${B}codex${N}

  Try a prompt, ArmorCodex will tell Codex to register an intent plan first.
  Tools not in the plan get blocked (intent drift):

    ${D}> read README.md${N}
    ${D}> add a line "this is working" to README.md${N}

  Add policy rules from any prompt (use natural language or "Policy ..."):

    ${D}> Policy new: deny WebFetch${N}
    ${D}> update the policy to not access ~/photos${N}

EOF

  section "Manage anytime"
  cat <<EOF

  ${D}bash $(realpath "${SCRIPT_PATH}" 2>/dev/null || echo install_armorcodex.sh) --uninstall${N}
  ${D}bash $(realpath "${SCRIPT_PATH}" 2>/dev/null || echo install_armorcodex.sh) --force-hooks${N}

  Hooks: ${C}${GLOBAL_HOOKS}${N}
  Config: ${C}${CONFIG_TOML}${N}
  Docs: ${C}https://docs.armoriq.ai/armorcodex${N}

EOF
}

# ---------------------------------------------------------------------------
# Uninstall
# ---------------------------------------------------------------------------

uninstall() {
  section "Uninstalling ArmorCodex"
  if [[ -f "${CONFIG_TOML}" ]]; then
    strip_managed_block "${CONFIG_TOML}"
    ok "removed managed block from ${CONFIG_TOML}"
  fi
  if [[ -f "${GLOBAL_HOOKS}" ]] && grep -q "ArmorCodex" "${GLOBAL_HOOKS}" 2>/dev/null; then
    rm -f "${GLOBAL_HOOKS}"
    ok "removed ${GLOBAL_HOOKS}"
  fi
  ok "uninstalled. ArmorCodex marketplace registration (if any) left in place."
  info "to remove that too: codex plugin marketplace remove armorcodex"
}

# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

main() {
  if [[ "${DO_UNINSTALL}" -eq 1 ]]; then
    uninstall
    exit 0
  fi

  banner

  section "Checking prerequisites"
  require_cmd codex
  require_cmd node
  require_cmd npm
  require_cmd git
  check_node_version
  ok "prerequisites OK ($(codex --version 2>/dev/null | head -1), $(node --version))"

  local mode
  mode="$(detect_mode)"
  if [[ "${mode}" == "update" ]]; then
    section "Updating ArmorCodex"
    run_update_path
    verify_install
    finish_update_banner
    exit 0
  fi

  section "Fetching plugin source"
  fetch_plugin_source

  section "Wiring Codex configuration"
  ensure_config_toml

  section "Installing global hooks"
  ensure_global_hooks

  section "Installing dependencies"
  install_npm_deps
  install_armoriq_cli

  section "Registering marketplace (optional)"
  register_marketplace_optional

  verify_install
  connect_to_armoriq
  finale
}

main "$@"
