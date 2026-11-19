// conmap-auto publishes these wire values in docs/contracts/runs-v1.json.
export const RUNS = Object.freeze({
  "endReasons": [
    "stop",
    "next_prompt",
    "session_end",
    "recovered"
  ],
  "noPlanReasons": [
    "monitor_mode",
    "no_tool_use",
    "read_only",
    "backend_unreachable",
    "request_failed",
    "plan_rejected",
    "not_registered"
  ],
  "limits": {
    "maxBatchReports": 200,
    "maxIdChars": 128,
    "maxPlanIds": 20,
    "maxBatchBytes": 8388608,
    "maxInteger": 2147483647
  },
  "capability": {
    "normalization": "Trim, preserve MCP prefixes, remove the first double underscore from other names, lowercase, then resolve exec_command, shell, local_shell, unified_exec and container.exec to bash.",
    "sources": [
      "plugins/armorcodex/scripts/lib/common.mjs",
      "plugins/armorcodex/scripts/lib/backend-posture.mjs",
      "plugins/armorcodex/scripts/lib/engine.mjs:handlePreToolUse"
    ],
    "rules": [
      {
        "patterns": [
          "^(?:register_intent_plan|policy_read|policy_update)$",
          "^(?:.*mcp__armorcodex[-_]policy__|.*armorcodex[-_]policy[.]).*(?:register_intent_plan|policy_read|policy_update)$"
        ],
        "gated": false,
        "counted": false
      },
      {
        "patterns": [
          "^(?:toolsearch|todowrite|listmcpresourcestool|readmcpresourcetool|read|grep|glob|websearch|webfetch)$"
        ],
        "gated": false,
        "counted": true
      },
      {
        "patterns": [
          "^.*$"
        ],
        "gated": true,
        "counted": true
      }
    ],
    "notes": [
      "The current own tool exemption includes policy_update and exposes no trust tools. Codex currently hooks Bash, apply_patch and MCP calls, so it sees no native read calls. Backend capability labels do not define plan exemptions."
    ]
  }
});
