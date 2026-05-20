#!/usr/bin/env bash
set -euo pipefail

# Local-stack test wrapper for armorCodex on the feat/latency-parity-armorclaude branch.
#
# Wires Codex to use:
#   - working-tree plugin at  ./plugins/armorcodex/scripts/bootstrap.mjs
#   - local backend URLs      :3000 conmap-auto, :3001 proxy, :8080 csrg-iap
#   - npm-linked @armoriq/sdk (the unpublished PR #57 build)
#
# Prerequisites:
#   - conmap-auto running on :3000   (cd enterprise/conmap-auto && nohup node dist/main.js > /tmp/conmap-auto.log 2>&1 &)
#   - armoriq-proxy-server on :3001
#   - csrg-iap on :8080
#   - cloud-sql-proxy running on :5433 (for conmap-auto -> staging DB)
#   - sdk-ts npm-linked globally (cd armoriq-sdk-customer-ts && npm link)
#   - plugin linked to local SDK (cd armorCodex/plugins/armorcodex && npm link @armoriq/sdk)
#   - ~/.armoriq/credentials.json contains a staging-compatible API key

PLUGIN_ROOT="$(cd "$(dirname "$0")" && pwd)/plugins/armorcodex"
BOOTSTRAP="${PLUGIN_ROOT}/scripts/bootstrap.mjs"
CONFIG="${HOME}/.codex/config.toml"
HOOKS="${HOME}/.codex/hooks.json"
MARK_BEGIN="# >>> ArmorCodex managed block (do not edit manually) >>>"
MARK_END="# <<< ArmorCodex managed block <<<"

mkdir -p "$(dirname "$CONFIG")" "$(dirname "$HOOKS")"
touch "$CONFIG"

# Strip any existing managed block (idempotent)
awk -v b="$MARK_BEGIN" -v e="$MARK_END" '
  $0 == b { skip=1; next }
  $0 == e { skip=0; next }
  !skip   { print }
' "$CONFIG" > "$CONFIG.tmp" && mv "$CONFIG.tmp" "$CONFIG"

# Append local-pointed managed block. env vars override the config.mjs defaults.
cat >> "$CONFIG" <<EOF

$MARK_BEGIN
[features]
codex_hooks = true

[mcp_servers.armorcodex-policy]
command = "node"
args = ["$BOOTSTRAP", "mcp"]
env = { ARMORIQ_ENV = "local", ARMORCODEX_USE_SDK_INTENT = "true", ARMORCODEX_INTENT_DEADLINE_MS = "500", ARMORCODEX_BACKEND_ENDPOINT = "http://127.0.0.1:3000", ARMORCODEX_PROXY_ENDPOINT = "http://127.0.0.1:3001", ARMORCODEX_IAP_ENDPOINT = "http://127.0.0.1:8080", CSRG_ENDPOINT = "http://127.0.0.1:8080", ARMORCODEX_DEBUG = "true" }
$MARK_END
EOF

# Hooks.json fires fresh node per event; inject env so PreToolUse/PostToolUse also see local URLs.
cat > "$HOOKS" <<EOF
{
  "hooks": {
    "SessionStart": [
      {
        "matcher": "startup|resume",
        "hooks": [
          { "type": "command", "command": "ARMORIQ_ENV=local ARMORCODEX_BACKEND_ENDPOINT=http://127.0.0.1:3000 ARMORCODEX_IAP_ENDPOINT=http://127.0.0.1:8080 ARMORCODEX_PROXY_ENDPOINT=http://127.0.0.1:3001 CSRG_ENDPOINT=http://127.0.0.1:8080 ARMORCODEX_DEBUG=true node $BOOTSTRAP router", "statusMessage": "Starting ArmorCodex (local)" }
        ]
      }
    ],
    "UserPromptSubmit": [
      {
        "hooks": [
          { "type": "command", "command": "ARMORIQ_ENV=local ARMORCODEX_BACKEND_ENDPOINT=http://127.0.0.1:3000 ARMORCODEX_IAP_ENDPOINT=http://127.0.0.1:8080 ARMORCODEX_PROXY_ENDPOINT=http://127.0.0.1:3001 CSRG_ENDPOINT=http://127.0.0.1:8080 ARMORCODEX_DEBUG=true node $BOOTSTRAP router", "statusMessage": "Loading ArmorCodex intent policy (local)" }
        ]
      }
    ],
    "PreToolUse": [
      {
        "matcher": "*",
        "hooks": [
          { "type": "command", "command": "ARMORIQ_ENV=local ARMORCODEX_BACKEND_ENDPOINT=http://127.0.0.1:3000 ARMORCODEX_IAP_ENDPOINT=http://127.0.0.1:8080 ARMORCODEX_PROXY_ENDPOINT=http://127.0.0.1:3001 CSRG_ENDPOINT=http://127.0.0.1:8080 ARMORCODEX_DEBUG=true node $BOOTSTRAP router", "statusMessage": "Checking ArmorCodex policy (local)" }
        ]
      }
    ],
    "PermissionRequest": [
      {
        "matcher": "*",
        "hooks": [
          { "type": "command", "command": "ARMORIQ_ENV=local ARMORCODEX_BACKEND_ENDPOINT=http://127.0.0.1:3000 ARMORCODEX_IAP_ENDPOINT=http://127.0.0.1:8080 ARMORCODEX_PROXY_ENDPOINT=http://127.0.0.1:3001 CSRG_ENDPOINT=http://127.0.0.1:8080 ARMORCODEX_DEBUG=true node $BOOTSTRAP router", "statusMessage": "Checking ArmorCodex approval policy (local)" }
        ]
      }
    ],
    "PostToolUse": [
      {
        "matcher": "*",
        "hooks": [
          { "type": "command", "command": "ARMORIQ_ENV=local ARMORCODEX_BACKEND_ENDPOINT=http://127.0.0.1:3000 ARMORCODEX_IAP_ENDPOINT=http://127.0.0.1:8080 ARMORCODEX_PROXY_ENDPOINT=http://127.0.0.1:3001 CSRG_ENDPOINT=http://127.0.0.1:8080 ARMORCODEX_DEBUG=true node $BOOTSTRAP router", "statusMessage": "Auditing ArmorCodex command (local)" }
        ]
      }
    ]
  }
}
EOF

echo "✓ wired ~/.codex/config.toml -> working-tree plugin + local backend URLs"
echo "✓ wired ~/.codex/hooks.json  -> fresh node per event, same env"
echo
echo "Smoke-checks:"
printf "  conmap-auto :3000  "; curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:3000/iap/sdk/token -X POST -H "X-API-Key: $(jq -r .apiKey ~/.armoriq/credentials.json 2>/dev/null)" -H "Content-Type: application/json" --data '{"user_id":"x","agent_id":"x","context_id":"x","plan":{"steps":[],"metadata":{}},"expires_in":60}' || echo "FAIL"
printf "  proxy       :3001  "; curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:3001/ || echo "FAIL"
printf "  csrg-iap    :8080  "; curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:8080/ || echo "FAIL"
echo
echo "Restart Codex.app:"
echo "  osascript -e 'quit app \"Codex\"' && sleep 1 && open -a Codex"
