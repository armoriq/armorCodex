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
# Idempotent: re-running won't double-write any block. ArmorCodex hooks are
# merged into an existing global hooks file, keeping other tools' hooks.
# If the plugin and credentials are already in place, the script runs in update
# mode (refresh checkout + SDK + npm deps, skip the login prompt).
#
# Flags:
#   --uninstall       remove ArmorCodex blocks
#   --force-install   force the full install flow even if already installed
#   --update          force update mode even without credentials
#
# Non-interactive overrides:
#   ARMORCODEX_MARKETPLACE_REPO   override marketplace source (testing)
#   ARMORCODEX_GIT_URL            override fork source (testing)
#   ARMORCODEX_GIT_REF            branch / tag (default: the latest release tag)
#   ARMORCODEX_RELEASE_API        GitHub API base used to resolve that tag
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
PLUGIN_GIT_REF="${ARMORCODEX_GIT_REF:-}"
RELEASE_API="${ARMORCODEX_RELEASE_API:-https://api.github.com}"
INSTALL_HOME="${ARMORCODEX_INSTALL_HOME:-${HOME}/.armoriq/armorCodex}"
DASHBOARD_URL="${ARMORCODEX_DASHBOARD_URL:-https://platform.armoriq.ai}"

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
LOCAL_CHECKOUT=0
if [[ -n "${SCRIPT_DIR}" && -f "${SCRIPT_DIR}/${PLUGIN_SUBDIR}/scripts/bootstrap.mjs" ]]; then
  PLUGIN_ROOT="${SCRIPT_DIR}"
  LOCAL_CHECKOUT=1
elif [[ -n "${SCRIPT_DIR}" && -f "${SCRIPT_DIR}/scripts/bootstrap.mjs" ]]; then
  # Legacy flat-layout fallback so existing checkouts keep working.
  PLUGIN_ROOT="${SCRIPT_DIR}"
  PLUGIN_SUBDIR="."
  LOCAL_CHECKOUT=1
else
  PLUGIN_ROOT="${INSTALL_HOME}"
fi

CONFIG_TOML="${HOME}/.codex/config.toml"
GLOBAL_HOOKS="${HOME}/.codex/hooks.json"
HOOKS_UNTRUSTED=0
PLUGIN_PATH="${PLUGIN_ROOT}/${PLUGIN_SUBDIR}"
BOOTSTRAP_PATH="${PLUGIN_PATH}/scripts/bootstrap.mjs"

MARK_BEGIN="# >>> ArmorCodex managed block (do not edit manually) >>>"
MARK_END="# <<< ArmorCodex managed block <<<"

DO_UNINSTALL=0
HAD_INSTALL=0
# Captured before anything is written, so a failed run deletes only a plugin
# directory it created itself.
HAD_INSTALL_HOME=0
[[ -d "${INSTALL_HOME}" ]] && HAD_INSTALL_HOME=1
FORCE_MODE=""
if [[ "${ARMORIQ_FORCE_INSTALL:-0}" == "1" ]]; then
  FORCE_MODE="install"
fi
for arg in "$@"; do
  case "$arg" in
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

# --- Prerequisites -----------------------------------------------------------
# A missing tool is offered for install through the machine's package manager
# when someone is at the terminal to say yes. Otherwise the installer says how
# to get it. Nothing is installed without a yes.

# `curl ... | sudo bash` writes the plugin and the login under root's home
# instead of the user's, so the user never sees them.
refuse_sudo() {
  if [[ "${EUID}" -eq 0 && -n "${SUDO_USER:-}" ]]; then
    err "don't run this installer with sudo"
    echo "  run it as yourself: curl -fsSL https://armoriq.ai/install_armorcodex_dev.sh | bash" 1>&2
    exit 1
  fi
}

pkg_manager() {
  if command -v brew >/dev/null 2>&1; then echo brew
  elif command -v apt-get >/dev/null 2>&1; then echo apt-get
  elif command -v dnf >/dev/null 2>&1; then echo dnf
  fi
}

# The packages that provide a tool under a package manager.
pkg_for() {
  case "$1:$2" in
    node:brew|npm:brew) echo "node" ;;
    node:*|npm:*)       echo "nodejs npm" ;;
    python3:brew)       echo "python" ;;
    *)                  echo "$1" ;;
  esac
}

# offer_install TOOL HINT: succeeds once TOOL is on PATH.
offer_install() {
  local tool="$1" hint="$2" pm pkgs
  command -v "${tool}" >/dev/null 2>&1 && return 0
  pm="$(pkg_manager)"
  if [[ -n "${pm}" ]] && is_promptable && prompt_yes_no "${tool} is not installed. Install it with ${pm} now?" Y; then
    pkgs="$(pkg_for "${tool}" "${pm}")"
    case "${pm}" in
      brew)    brew install ${pkgs} ;;
      apt-get) sudo apt-get update -qq && sudo apt-get install -y ${pkgs} ;;
      dnf)     sudo dnf install -y ${pkgs} ;;
    esac || true
    hash -r
    if command -v "${tool}" >/dev/null 2>&1; then
      ok "${tool} installed"
      return 0
    fi
  fi
  err "${tool} is not installed"
  echo "  ${hint}" 1>&2
  return 1
}

# Plugins are cloned from GitHub over HTTPS. A git config that rewrites GitHub
# HTTPS addresses to SSH (url.<ssh>.insteadOf) turns that into an SSH clone,
# which fails with "Permission denied (publickey)" when no GitHub SSH key is
# set up. Check the clone path first; if only the user's git config is in the
# way, skip that config for this install's git calls and leave it unchanged.
check_github_access() {
  local url="$1" rules
  if GIT_TERMINAL_PROMPT=0 git ls-remote -q "${url}" HEAD >/dev/null 2>&1; then
    return 0
  fi
  if GIT_TERMINAL_PROMPT=0 GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1 \
    git ls-remote -q "${url}" HEAD >/dev/null 2>&1; then
    warn "your git config stops git from downloading ${url} over HTTPS"
    rules="$(git config --get-regexp '^url\..*\.insteadof$' 2>/dev/null | grep -i 'github' || true)"
    if [[ -n "${rules}" ]]; then
      info "it rewrites GitHub addresses to SSH: ${D}${rules//$'\n'/; }${N}"
    fi
    info "this install skips your git config for its own downloads; the config itself is unchanged"
    export GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1
    return 0
  fi
  err "can't download ${url}"
  echo "  check your network or proxy can reach github.com over HTTPS, then run this installer again" 1>&2
  return 1
}

require_cmd() {
  case "$1" in
    codex)    require_codex ;;
    node|npm) offer_install "$1" "install Node.js >= 20 from https://nodejs.org (npm comes with it)" || exit 1 ;;
    git)      offer_install git "install git from https://git-scm.com/downloads" || exit 1 ;;
    *)        offer_install "$1" "install $1, then run this installer again" || exit 1 ;;
  esac
}

require_codex() {
  command -v codex >/dev/null 2>&1 && return 0
  if is_promptable && prompt_yes_no "Codex is not installed. Install it with npm install -g @openai/codex?" Y; then
    npm install -g @openai/codex --no-audit --no-fund || true
    hash -r
    if command -v codex >/dev/null 2>&1; then
      ok "Codex installed"
      return 0
    fi
  fi
  err "Codex is not installed"
  echo "  install Codex from https://developers.openai.com/codex, then run this installer again" 1>&2
  exit 1
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

check_codex_version() {
  local raw major minor
  raw="$(codex --version 2>/dev/null | head -1 || true)"
  if [[ ! "${raw}" =~ ([0-9]+)\.([0-9]+)\.[0-9]+ ]]; then
    err "could not read the Codex version (got: ${raw:-no output}); Codex 0.162 or newer is required"
    exit 1
  fi
  major="${BASH_REMATCH[1]}"
  minor="${BASH_REMATCH[2]}"
  if (( major == 0 && minor < 162 )); then
    err "Codex 0.162 or newer is required (found ${raw})"
    echo "  ArmorCodex needs the session id that Codex 0.162 and later send with MCP calls." 1>&2
    echo "  Update Codex (https://developers.openai.com/codex) and run this installer again." 1>&2
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

# dev installs track the dev branch; main and release tags are one channel.
checkout_channel() {
  case "$1" in
    dev) echo dev ;;
    main | HEAD | v[0-9]*) echo stable ;;
    *) echo "$1" ;;
  esac
}

refuse_other_channel() {
  local branch command="install_armorcodex.sh"
  branch="$(git -C "${INSTALL_HOME}" rev-parse --abbrev-ref HEAD 2>/dev/null || echo unknown)"
  [[ "$(checkout_channel "${branch}")" == "$(checkout_channel "${PLUGIN_GIT_REF}")" ]] && return 0
  [[ "${branch}" == "dev" ]] && command="install_armorcodex_dev.sh"
  err "${INSTALL_HOME} is on ${branch}, not ${PLUGIN_GIT_REF}. Nothing was changed."
  printf "  Update it with ${B}curl -fsSL https://armoriq.ai/%s | bash${N}\n" "${command}"
  printf "  To switch channels, uninstall first (${B}--uninstall${N}), then delete %s.\n" "${INSTALL_HOME}"
  exit 1
}

installed_version() {
  local manifest
  for manifest in "${INSTALL_HOME}/plugins/armorcodex/package.json" "${INSTALL_HOME}/package.json"; do
    [[ -f "${manifest}" ]] || continue
    node -e 'const v = require(process.argv[1]).version; if (typeof v === "string") process.stdout.write(v);' \
      "${manifest}" 2>/dev/null || true
    return 0
  done
}

# True when version $1 is strictly newer than $2. A prerelease (1.2.0-rc.1) is
# older than its release (1.2.0), which sort -V alone gets backwards.
version_newer() {
  local core1="${1%%-*}" core2="${2%%-*}"
  if [[ "${core1}" == "${core2}" ]]; then
    [[ "$1" == "${core1}" && "$2" != "${core2}" ]]
    return
  fi
  [[ "$(printf '%s\n%s\n' "${core1}" "${core2}" | sort -V | tail -n 1)" == "${core1}" ]]
}

# An install must land on a version that was released and tested, not on
# whatever happens to be on main. ARMORCODEX_GIT_REF overrides with any ref.
# Leaves PLUGIN_GIT_REF empty when the existing checkout should stay put.
resolve_git_ref() {
  if [[ -n "${PLUGIN_GIT_REF}" ]]; then
    return 0
  fi
  local tag current
  # `|| true` because set -e plus pipefail would otherwise abort the whole
  # install when the machine is offline or the repo has no release yet.
  tag="$(curl -fsSL --max-time 10 "${RELEASE_API%/}/repos/${MARKETPLACE_REPO}/releases/latest" 2>/dev/null \
    | grep -o '"tag_name"[[:space:]]*:[[:space:]]*"[^"]*"' \
    | head -n 1 \
    | sed 's/.*"\([^"]*\)"$/\1/' || true)"
  if [[ ! "${tag}" =~ ^v?[0-9]+\.[0-9]+\.[0-9]+ ]]; then
    # One failed lookup (offline, GitHub rate limit) must not move an install
    # that sits on a release tag onto unreleased main.
    if [[ -d "${INSTALL_HOME}/.git" ]] && ! git -C "${INSTALL_HOME}" symbolic-ref -q HEAD >/dev/null 2>&1; then
      warn "couldn't resolve the latest release, leaving the installed version as it is"
      return 0
    fi
    PLUGIN_GIT_REF="main"
    warn "couldn't resolve the latest release, falling back to ${B}main${N}"
    return 0
  fi
  current="$(installed_version)"
  if [[ -d "${INSTALL_HOME}/.git" && -n "${current}" ]] && version_newer "${current}" "${tag#v}"; then
    warn "installed ArmorCodex ${current} is newer than the latest release ${tag}, leaving it as it is"
    return 0
  fi
  PLUGIN_GIT_REF="${tag}"
  info "installing release ${B}${tag}${N}"
}

fetch_plugin_source() {
  # Local-first: when this script is run from inside a checkout (bootstrap.mjs
  # already present next to it), install THAT local code and never clone. This
  # is how local testing wires Codex at your working branch. curl-pipe installs
  # have no script file, so an existing INSTALL_HOME is refreshed below rather
  # than mistaken for a local checkout.
  if [[ "${LOCAL_CHECKOUT}" -eq 1 ]]; then
    local branch
    branch="$(git -C "${PLUGIN_ROOT}" rev-parse --abbrev-ref HEAD 2>/dev/null || echo 'no-git')"
    info "installing LOCAL checkout at ${PLUGIN_ROOT} (${branch})"
    return 0
  fi

  resolve_git_ref
  mkdir -p "$(dirname "${INSTALL_HOME}")"

  if [[ -d "${INSTALL_HOME}/.git" && -z "${PLUGIN_GIT_REF}" ]]; then
    ok "kept ${INSTALL_HOME} at $(git -C "${INSTALL_HOME}" rev-parse --short HEAD 2>/dev/null || echo HEAD)"
  elif [[ -d "${INSTALL_HOME}/.git" ]]; then
    refuse_other_channel
    info "refreshing ${INSTALL_HOME} (git pull)"
    # FETCH_HEAD rather than origin/<ref>: a release tag has no remote-tracking
    # branch, and this resolves a tag and a branch the same way.
    git -C "${INSTALL_HOME}" fetch --quiet origin "${PLUGIN_GIT_REF}" >/dev/null
    git -C "${INSTALL_HOME}" reset --hard --quiet FETCH_HEAD >/dev/null
    ok "updated to ${PLUGIN_GIT_REF}"
  else
    info "cloning ${PLUGIN_GIT_URL} into ${INSTALL_HOME}"
    git -c advice.detachedHead=false clone --quiet --depth 1 --branch "${PLUGIN_GIT_REF}" "${PLUGIN_GIT_URL}" "${INSTALL_HOME}"
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
  # + dashboard visibility).
  # Managed block holds only the ArmorCodex MCP server table (unique to us,
  # safe to replace idempotently on re-run).
  local snippet
  snippet="$(cat <<EOF
[mcp_servers.armorcodex-policy]
command = "node"
args = ["${BOOTSTRAP_PATH}", "mcp"]
env = { ARMORCODEX_USE_SDK_INTENT = "true" }
EOF
  )"
  upsert_managed_block "${CONFIG_TOML}" "${snippet}"

  # The hooks feature flag lives under [features] (named `hooks` on Codex
  # 0.142+, formerly `codex_hooks`). Codex itself may already define a
  # [features] table (e.g. js_repl), and TOML forbids two of the same table,
  # so merge the flag into the existing table instead of emitting our own
  # header (a second [features] is what caused "duplicate key [features]").
  # The detect and the insert share one pattern: a header with a trailing
  # comment used to pass the detect, miss the insert, and leave hooks off.
  local features_header='^[[:space:]]*\[features\][[:space:]]*(#.*)?$'
  if grep -qE '^[[:space:]]*(hooks|codex_hooks)[[:space:]]*=' "${CONFIG_TOML}"; then
    :
  elif grep -qE "${features_header}" "${CONFIG_TOML}"; then
    FEATURES_HEADER="${features_header}" awk '!done && $0 ~ ENVIRON["FEATURES_HEADER"] {print; print "hooks = true"; done=1; next} {print}' \
      "${CONFIG_TOML}" > "${CONFIG_TOML}.armorcodex.tmp" \
      && mv "${CONFIG_TOML}.armorcodex.tmp" "${CONFIG_TOML}"
  else
    printf '\n[features]\nhooks = true\n' >> "${CONFIG_TOML}"
  fi
  ok "wired config.toml: hooks + mcp_servers.armorcodex-policy"
}

codex_hooks_json() {
  local module="${PLUGIN_PATH}/scripts/hooks-file.mjs"
  if [[ -f "${module}" ]]; then
    node "${module}" "$1" "${GLOBAL_HOOKS}" "${BOOTSTRAP_PATH}"
  elif [[ "$1" == "remove" ]]; then
    strip_hooks_without_plugin
  else
    echo "${module} is missing; this checkout predates the shared hooks writer" >&2
    return 1
  fi
}

strip_hooks_without_plugin() {
  [[ -f "${GLOBAL_HOOKS}" ]] || { printf absent; return 0; }
  node --input-type=module - "${GLOBAL_HOOKS}" <<'NODE'
import { chmodSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
const [hooksPath] = process.argv.slice(2);
const tempPath = `${hooksPath}.armorcodex.tmp-${process.pid}`;
const ours = (entry) => entry?.type === "command"
  && typeof entry.command === "string"
  && entry.command.endsWith("bootstrap.mjs router")
  && /armorcodex/i.test(`${entry.command} ${entry.statusMessage ?? ""}`);
const hasOurs = (group) => Array.isArray(group?.hooks) && group.hooks.some(ours);
try {
  const text = readFileSync(hooksPath, "utf8");
  const config = JSON.parse(text);
  if (!config?.hooks || typeof config.hooks !== "object" || Array.isArray(config.hooks)) throw new Error("top-level hooks must be an object");
  let removed = 0;
  for (const [event, groups] of Object.entries(config.hooks)) {
    if (!Array.isArray(groups)) throw new Error(`hooks.${event} must be an array`);
    removed += groups.filter(hasOurs).length;
    const kept = groups
      .map((group) => (hasOurs(group) ? { ...group, hooks: group.hooks.filter((entry) => !ours(entry)) } : group))
      .filter((group) => !Array.isArray(group?.hooks) || group.hooks.length > 0);
    if (kept.length > 0) config.hooks[event] = kept;
    else delete config.hooks[event];
  }
  if (removed === 0) {
    process.stdout.write("absent");
  } else if (Object.keys(config.hooks).length === 0 && Object.keys(config).length === 1) {
    rmSync(hooksPath, { force: true });
    process.stdout.write("removed");
  } else {
    const indent = text.match(/^([ \t]+)\S/m)?.[1] ?? (text.trim().includes("\n") ? 2 : 0);
    writeFileSync(tempPath, `${JSON.stringify(config, null, indent)}${text.endsWith("\n") ? "\n" : ""}`, { flag: "wx" });
    chmodSync(tempPath, statSync(hooksPath).mode & 0o7777);
    renameSync(tempPath, hooksPath);
    process.stdout.write("stripped");
  }
} catch (error) {
  rmSync(tempPath, { force: true });
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
NODE
}

ensure_global_hooks() {
  local result
  if ! result="$(codex_hooks_json add)"; then
    warn "couldn't safely merge ArmorCodex hooks into ${GLOBAL_HOOKS}"
    info "leaving ${GLOBAL_HOOKS} unchanged"
    return 0
  fi
  case "${result}" in
    created) ok "installed global ArmorCodex hooks at ${GLOBAL_HOOKS}" ;;
    repaired:*)
      local added="${result#repaired:}" refreshed
      refreshed="${added#*|}"
      added="${added%%|*}"
      [[ -n "${added}" ]] && ok "added missing ArmorCodex ${added} hook(s) to ${GLOBAL_HOOKS}"
      [[ -n "${refreshed}" ]] && ok "updated ArmorCodex ${refreshed} hook(s) in ${GLOBAL_HOOKS}"
      ;;
    *) ok "global hooks already reference ArmorCodex" ;;
  esac
  trust_codex_hooks
}

# Codex skips a hooks.json hook until it is trusted, so without this step a
# fresh install enforces nothing. Recorded the way /hooks records it, for
# ArmorCodex's own hooks only.
trust_codex_hooks() {
  if (cd "${HOME}" && node "${PLUGIN_PATH}/scripts/trust-hooks.mjs" "${GLOBAL_HOOKS}" "${BOOTSTRAP_PATH}") >/dev/null 2>&1; then
    ok "trusted the ArmorCodex hooks in Codex"
    return 0
  fi
  HOOKS_UNTRUSTED=1
  warn "couldn't mark the ArmorCodex hooks as trusted, so Codex will not run them yet"
  printf "  Start ${B}codex${N}, run ${B}/hooks${N}, and trust the ArmorCodex hooks.\n"
}

remove_codex_hooks() {
  local result
  result="$(codex_hooks_json remove)" || { warn "couldn't safely remove ArmorCodex hooks from ${GLOBAL_HOOKS}"; return 0; }
  case "${result}" in
    removed) info "removed ${GLOBAL_HOOKS}" ;;
    stripped) info "removed the ArmorCodex hooks from ${GLOBAL_HOOKS}" ;;
  esac
}

install_npm_deps() {
  pushd "${PLUGIN_PATH}" >/dev/null
  info "installing npm dependencies (--omit=dev)"
  npm install --omit=dev --silent --no-audit --no-fund >/dev/null
  ok "npm dependencies installed"
  popd >/dev/null
}

install_armoriq_cli() {
  info "installing ArmorIQ CLI ${B}(@armoriq/sdk-dev)${N}"
  if npm install -g @armoriq/sdk-dev@latest --silent --no-audit --no-fund >/dev/null 2>&1; then
    ok "armoriq-dev CLI ready"
  else
    warn "couldn't install globally, use ${B}npx @armoriq/sdk-dev${N} instead"
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
  info "SDK:    @armoriq/sdk-dev (latest)"
  info "Hooks:  ${GLOBAL_HOOKS} (verified)"
  info "Restart open Codex sessions to load the updated ArmorCodex server."
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
  if [[ "${HOOKS_UNTRUSTED}" -eq 1 ]]; then
    warn "ArmorCodex hooks are not trusted yet: start ${B}codex${N}, run ${B}/hooks${N}, and trust them"
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
  remove_codex_hooks
  if [[ "${LOCAL_CHECKOUT}" -eq 0 && "${HAD_INSTALL_HOME}" -eq 0 && -d "${INSTALL_HOME}" ]]; then
    rm -rf "${INSTALL_HOME}" && info "removed plugin source ${INSTALL_HOME}" || true
  fi
  echo
  printf "  Get an account at ${C}${B}https://armoriq.ai${N} and re-run when ready.\n\n"
  exit 1
}

stop_without_login() {
  [[ "${HAD_INSTALL}" -eq 1 ]] || abort_install
  echo
  warn "Kept the existing ArmorCodex install, but it has no ArmorIQ login."
  printf "  Run ${B}armoriq-dev login --product armorcodex --backend %s${N}, then start a new Codex session.\n\n" "$(plugin_backend)"
  exit 1
}

# The SDK CLI defaults to the backend it was built for, so the login is pointed
# at the backend the plugin will look its key up under.
plugin_backend() {
  node --input-type=module -e \
    'const { loadSettings } = await import(process.argv[1]); process.stdout.write(loadSettings().backendEndpoint);' \
    "${PLUGIN_PATH}/scripts/lib/config.mjs" 2>/dev/null || printf 'https://staging-api.armoriq.ai'
}

plugin_has_login() {
  node --input-type=module -e \
    'const { loadConfig } = await import(process.argv[1]); process.exit(loadConfig().apiKey ? 0 : 1);' \
    "${PLUGIN_PATH}/scripts/lib/config.mjs" >/dev/null 2>&1
}

connect_to_armoriq() {
  section "Connect to ArmorIQ"
  cat <<EOF

  Unlocks: signed JWT intent tokens, audit logs, CSRG proofs,
  and dashboard visibility for all intent plans at ${C}${DASHBOARD_URL}${N}.

EOF

  if plugin_has_login; then
    ok "ArmorIQ login for ArmorCodex found"
    return 0
  fi

  if ! is_promptable; then
    err "No TTY available for interactive login."
    printf "  Run ${B}armoriq-dev login --product armorcodex --backend %s${N} interactively.\n" "$(plugin_backend)"
    stop_without_login
  fi

  if ! prompt_yes_no "Connect your ArmorIQ account now?" "Y"; then
    stop_without_login
  fi

  echo
  local login_ok=0 backend
  backend="$(plugin_backend)"
  if command -v armoriq-dev >/dev/null 2>&1; then
    armoriq-dev login --product armorcodex --backend "${backend}" && login_ok=1
  elif command -v npx >/dev/null 2>&1; then
    npx @armoriq/sdk-dev login --product armorcodex --backend "${backend}" && login_ok=1
  else
    err "armoriq-dev CLI not found."
    stop_without_login
  fi

  if [[ "${login_ok}" -ne 1 ]] || ! plugin_has_login; then
    err "ArmorIQ login did not complete for ArmorCodex's backend."
    stop_without_login
  fi

  echo
  ok "ArmorIQ connected. Codex will auto-load the key."
}

finale() {
  echo
  printf "${G}${B}ArmorCodex is installed.${N}\n"
  if [[ "${HAD_INSTALL}" -eq 1 ]]; then
    printf "  Restart open Codex sessions to load the updated ArmorCodex server.\n"
  fi

  node --input-type=module - "$(plugin_backend)" 2>/dev/null <<'NODE' || true
import { closeSync, mkdirSync, openSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
try {
  const dnt = process.env.DO_NOT_TRACK?.trim().toLowerCase();
  const disabled = process.env.ARMORIQ_USAGE_PING_DISABLED?.trim().toLowerCase();
  if (["1", "true"].includes(dnt) || ["1", "true", "yes"].includes(disabled)) process.exit(0);
  if (!["https://api.armoriq.ai", "https://staging-api.armoriq.ai", "https://staging-api.armoriq.io"].includes(process.argv[2])) process.exit(0);
  try {
    const settings = JSON.parse(readFileSync(path.join(homedir(), ".armoriq/settings.json"), "utf8"));
    if (!settings || typeof settings !== "object" || Array.isArray(settings) ||
        (Object.prototype.hasOwnProperty.call(settings, "usagePing") &&
         (typeof settings.usagePing !== "boolean" || !settings.usagePing))) process.exit(0);
  } catch (error) {
    if (error.code !== "ENOENT") process.exit(0);
  }
  const dir = path.join(homedir(), ".armoriq/reach/v1/armorcodex");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  closeSync(openSync(path.join(dir, "notice-shown"), "wx", 0o600));
  console.log("ArmorIQ sends an anonymous daily usage ping (a random install id, plugin and version, OS, signed in or not, and daily counts of plans and blocks); turn it off with ARMORIQ_USAGE_PING_DISABLED=1 or DO_NOT_TRACK=1.");
} catch {}
NODE

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
  remove_codex_hooks
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

  refuse_sudo
  banner

  section "Checking prerequisites"
  require_cmd node
  require_cmd npm
  require_cmd git
  check_node_version
  require_cmd codex
  check_codex_version
  check_github_access "${PLUGIN_GIT_URL}" || exit 1
  ok "prerequisites OK ($(codex --version 2>/dev/null | head -1), $(node --version))"

  is_armorcodex_installed && HAD_INSTALL=1

  local mode
  mode="$(detect_mode)"
  if [[ "${mode}" == "update" ]]; then
    section "Updating ArmorCodex"
    run_update_path
    verify_install
    connect_to_armoriq
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
