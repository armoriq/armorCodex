// conmap-auto owns these values in docs/contracts/block-capture-v1.json.
export const SIZE_LIMITS = Object.freeze({
  "source": "src/bootstrap/body-parsers.ts",
  "backendRequestLimit": "10mb",
  "backendRequestBytes": 10485760,
  "maxRowBytes": 262144,
  "maxBatchBytes": 8388608,
  "maxBatchRows": 200,
  "encoding": "UTF-8 JSON bytes, including the complete batch envelope",
  "shrinkOrder": [
    "input",
    "output"
  ],
  "truncationMarker": {
    "truncated": true
  },
  "preserve": [
    "client_row_id",
    "plan_id",
    "context_plan_id",
    "prompt_id",
    "session_id",
    "executed_at",
    "decision_code",
    "action",
    "tool",
    "status"
  ],
  "metadataOversizeReason": "oversize"
});

export const CAPTURE_ROW_BYTES = 4000 - Buffer.byteLength(JSON.stringify({
  _seq: Number.MAX_SAFE_INTEGER, _enqueuedAt: Number.MAX_SAFE_INTEGER,
  client_row_id: "00000000-0000-4000-8000-000000000000"
}));
