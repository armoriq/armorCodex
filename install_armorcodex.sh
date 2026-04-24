#!/usr/bin/env bash
set -euo pipefail

# ArmorCodex installer for OpenAI Codex.
#
# This installer enables the current Codex hook harness and adds the ArmorIQ
# plugin marketplace. Codex hooks are still feature-flagged and currently
# intercept Bash only, so ArmorCodex installs both the plugin MCP tools and
# repo/global hook configuration guidance.

R=$'\033[1;31m'
G=$'\033[32m'
Y=$'\033[33m'
C=$'\033[38;2;0;229;204m'
B=$'\033[1m'
D=$'\033[0;90m'
N=$'\033[0m'

MARKETPLACE_REPO="${ARMORCODEX_MARKETPLACE_REPO:-armoriq/armorCodex}"
PLUGIN_REF="armorcodex@armoriq"

ok() { printf "${G}✔${N} %s\n" "$*"; }
warn() { printf "${Y}!${N} %s\n" "$*"; }
err() { printf "${R}✘${N} %s\n" "$*" 1>&2; }
info() { printf "${D}·${N} %s\n" "$*"; }
section() { printf "\n${B}${C}%s${N}\n" "$*"; }

require_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    err "missing required command: $1"
    case "$1" in
      codex) echo "  install Codex from https://developers.openai.com/codex" 1>&2 ;;
      node) echo "  install Node.js >= 20 from https://nodejs.org" 1>&2 ;;
      git) echo "  install git from https://git-scm.com/downloads" 1>&2 ;;
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

ensure_hooks_feature() {
  local cfg="${HOME}/.codex/config.toml"
  mkdir -p "${HOME}/.codex"
  touch "${cfg}"

  if grep -Eq '^[[:space:]]*codex_hooks[[:space:]]*=[[:space:]]*true' "${cfg}"; then
    ok "codex_hooks feature already enabled"
    return 0
  fi

  if grep -Eq '^[[:space:]]*\[features\]' "${cfg}"; then
    cat <<EOF >>"${cfg}"

# Added by ArmorCodex
codex_hooks = true
EOF
  else
    cat <<EOF >>"${cfg}"

[features]
codex_hooks = true
EOF
  fi
  ok "enabled Codex hooks in ${cfg}"
}

install_plugin() {
  section "Installing ArmorCodex plugin"
  info "adding marketplace ${MARKETPLACE_REPO}"
  codex plugin marketplace add "${MARKETPLACE_REPO}" >/dev/null || \
    codex plugin marketplace upgrade armoriq >/dev/null || true

  info "installing ${PLUGIN_REF}"
  codex plugin install "${PLUGIN_REF}" >/dev/null
  ok "plugin installed"
}

install_global_hooks_from_checkout() {
  local root="${1:-}"
  [[ -n "${root}" && -f "${root}/scripts/bootstrap.mjs" ]] || return 0

  local hooks="${HOME}/.codex/hooks.json"
  if [[ -f "${hooks}" ]]; then
    warn "global hooks file already exists at ${hooks}"
    info "repo-local hooks are available at ${root}/.codex/hooks.json"
    info "copy or merge them if you want ArmorCodex in every repo"
    return 0
  fi

  cp "${root}/.codex/hooks.json" "${hooks}"
  ok "installed global ArmorCodex hooks at ${hooks}"
}

main() {
  section "ArmorCodex"
  info "Intent policy, Bash guardrails, approval checks, and audit logging for Codex"

  section "Checking prerequisites"
  require_cmd codex
  require_cmd node
  require_cmd git
  check_node_version
  ok "prerequisites OK ($(codex --version 2>/dev/null | head -1), $(node --version))"

  ensure_hooks_feature
  install_plugin

  if git rev-parse --show-toplevel >/dev/null 2>&1; then
    install_global_hooks_from_checkout "$(git rev-parse --show-toplevel)"
  fi

  section "Done"
  cat <<EOF

ArmorCodex is installed.

Start Codex in a repository that contains .codex/hooks.json, or merge the
hook file from this checkout into ~/.codex/hooks.json for global coverage.

Policy commands:
  Policy list
  Policy new: deny Bash for payment data

EOF
}

main "$@"
