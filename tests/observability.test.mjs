import assert from "node:assert/strict";
import { once } from "node:events";
import { access, appendFile, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { randomUUID } from "node:crypto";

import { denyPermissionRequest } from "../plugins/armorcodex/scripts/lib/hook-output.mjs";
import { observeHook } from "../plugins/armorcodex/scripts/lib/observability.mjs";

function protoFields(buf) {
  const fields = [];
  let i = 0;
  const varint = () => {
    let value = 0n;
    for (let shift = 0n; ; shift += 7n) {
      const byte = buf[i++];
      value |= BigInt(byte & 0x7f) << shift;
      if (byte < 0x80) return value;
    }
  };
  while (i < buf.length) {
    const key = Number(varint());
    const no = key >> 3;
    const wire = key & 7;
    if (wire === 0) fields.push({ no, value: varint() });
    else if (wire === 1) {
      fields.push({ no, double: buf.readDoubleLE(i) });
      i += 8;
    } else if (wire === 5) i += 4;
    else if (wire === 2) {
      const len = Number(varint());
      fields.push({ no, bytes: buf.subarray(i, i + len) });
      i += len;
    } else throw new Error(`unsupported wire type ${wire}`);
  }
  return fields;
}

const field = (buf, no) => protoFields(buf).filter((f) => f.no === no);

// AnyValue: string_value(1), bool_value(2), int_value(3), double_value(4)
function anyValue(buf) {
  const [f] = protoFields(buf);
  if (!f) return undefined;
  if (f.no === 1) return f.bytes.toString("utf8");
  if (f.no === 2) return f.value === 1n;
  if (f.no === 3) return Number(f.value);
  if (f.no === 4) return f.double;
  return undefined;
}

// ExportTraceServiceRequest -> ResourceSpans(1) -> ScopeSpans(2) -> Span(2): name(5), attributes(9)
function decodeSpans(body) {
  const spans = [];
  for (const resourceSpans of field(body, 1)) {
    for (const scopeSpans of field(resourceSpans.bytes, 2)) {
      for (const span of field(scopeSpans.bytes, 2)) {
        const attributes = {};
        for (const kv of field(span.bytes, 9)) {
          const key = field(kv.bytes, 1)[0]?.bytes.toString("utf8");
          const value = field(kv.bytes, 2)[0];
          if (key && value) attributes[key] = anyValue(value.bytes);
        }
        spans.push({ name: field(span.bytes, 5)[0]?.bytes.toString("utf8"), attributes });
      }
    }
  }
  return spans;
}

async function startIngestServer() {
  const exports = [];
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    if (request.url === "/observability/policy/lease") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          captureMode: "enhanced",
          revision: 1,
          expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
          contentCaptureAllowed: true,
          externalContentCaptureAllowed: true,
        }),
      );
      return;
    }
    if (request.method === "POST" && request.url === "/v1/traces") {
      const body = Buffer.concat(chunks);
      exports.push({ raw: body.toString("latin1"), spans: decodeSpans(body) });
    }
    response.writeHead(200, { "content-type": "application/x-protobuf" });
    response.end();
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  return {
    endpoint: `http://127.0.0.1:${address.port}`,
    exports,
    close: async () => {
      server.closeAllConnections();
      server.close();
      await once(server, "close");
    },
  };
}

function obsConfig(dataDir, endpoint) {
  return {
    observabilityEnabled: true,
    observabilityEndpoint: endpoint,
    observabilityProduct: "armorcodex",
    apiKey: "ak_test_observability",
    agentId: "codex",
    userId: "codex-user",
    dataDir,
    sanitize: {
      maxChars: 2000,
      maxDepth: 4,
      maxKeys: 50,
      maxItems: 50,
    },
  };
}

function tokenCount(total, last) {
  return {
    type: "event_msg",
    payload: {
      type: "token_count",
      info: {
        total_token_usage: total,
        last_token_usage: last,
      },
    },
  };
}

test("Stop ships exactly one per-turn generation span without cumulative double count", async (t) => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "armorcodex-obs-"));
  const rolloutPath = path.join(dataDir, "rollout.jsonl");
  const ingest = await startIngestServer();
  t.after(async () => {
    await ingest.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  const sessionId = randomUUID();
  const config = obsConfig(dataDir, ingest.endpoint);
  const firstTotals = {
    input_tokens: 120,
    cached_input_tokens: 20,
    output_tokens: 10,
    total_tokens: 130,
  };
  const firstTurn = [
    { type: "event_msg", payload: { type: "task_started" } },
    { type: "turn_context", payload: { model: "gpt-4.1" } },
    tokenCount(firstTotals, firstTotals),
    { type: "event_msg", payload: { type: "task_complete" } },
  ];
  await writeFile(rolloutPath, firstTurn.map((line) => JSON.stringify(line)).join("\n"), "utf8");

  await observeHook(
    "UserPromptSubmit",
    { session_id: sessionId, prompt: "First turn" },
    null,
    config,
  );
  await observeHook(
    "Stop",
    { session_id: sessionId, transcript_path: rolloutPath },
    null,
    config,
  );

  const secondTurnUsage = {
    input_tokens: 80,
    cached_input_tokens: 30,
    output_tokens: 15,
    total_tokens: 95,
  };
  const finalTotals = {
    input_tokens: 200,
    cached_input_tokens: 50,
    output_tokens: 25,
    total_tokens: 225,
  };
  const secondTurn = [
    { type: "event_msg", payload: { type: "task_started" } },
    { type: "turn_context", payload: { model: "gpt-4.1" } },
    tokenCount(finalTotals, secondTurnUsage),
    { type: "event_msg", payload: { type: "task_complete" } },
  ];
  await appendFile(
    rolloutPath,
    `\n${secondTurn.map((line) => JSON.stringify(line)).join("\n")}`,
    "utf8",
  );

  await observeHook(
    "UserPromptSubmit",
    { session_id: sessionId, prompt: "Second turn" },
    null,
    config,
  );
  await observeHook(
    "Stop",
    { session_id: sessionId, transcript_path: rolloutPath },
    null,
    config,
  );

  const usage = (span) => ({
    inputTokens: span.attributes["gen_ai.usage.input_tokens"],
    outputTokens: span.attributes["gen_ai.usage.output_tokens"],
    cacheReadTokens: span.attributes["gen_ai.usage.cache_read_tokens"],
  });
  const generationSpans = ingest.exports
    .flatMap((e) => e.spans)
    .filter((span) => span.name === "gen_ai.chat");
  assert.equal(generationSpans.length, 2);
  for (const span of generationSpans) {
    assert.ok(span.attributes["gen_ai.usage.cost_usd"] > 0);
    assert.equal(span.attributes["armoriq.session_id"], sessionId);
  }

  assert.deepEqual(
    generationSpans.map(usage),
    [
      { inputTokens: 100, outputTokens: 10, cacheReadTokens: 20 },
      { inputTokens: 50, outputTokens: 15, cacheReadTokens: 30 },
    ],
  );

  const summed = generationSpans.reduce(
    (totals, span) => ({
      inputTokens: totals.inputTokens + usage(span).inputTokens,
      outputTokens: totals.outputTokens + usage(span).outputTokens,
      cacheReadTokens: totals.cacheReadTokens + usage(span).cacheReadTokens,
    }),
    { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 },
  );
  assert.deepEqual(summed, {
    inputTokens: finalTotals.input_tokens - finalTotals.cached_input_tokens,
    outputTokens: finalTotals.output_tokens,
    cacheReadTokens: finalTotals.cached_input_tokens,
  });
});

test("PermissionRequest denial ships as a denied policy call with its reason", async (t) => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "armorcodex-obs-"));
  const ingest = await startIngestServer();
  t.after(async () => {
    await ingest.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  const sessionId = randomUUID();
  const config = obsConfig(dataDir, ingest.endpoint);

  await observeHook(
    "UserPromptSubmit",
    { session_id: sessionId, prompt: "Run a protected command" },
    null,
    config,
  );
  await observeHook(
    "PermissionRequest",
    {
      session_id: sessionId,
      tool_name: "Bash",
      tool_input: { command: "rm protected.txt" },
    },
    denyPermissionRequest("Protected files cannot be removed"),
    config,
  );
  await observeHook("Stop", { session_id: sessionId }, null, config);

  const spans = ingest.exports.flatMap((e) => e.spans);
  const policyCall = spans.find((span) => span.name === "armoriq.policy.evaluate");
  assert.ok(policyCall);
  assert.equal(policyCall.attributes["armoriq.policy.decision"], "deny");
  assert.equal(policyCall.attributes["armoriq.intent_plan_item_status"], "blocked");
  assert.equal(policyCall.attributes["armoriq.policy.tool_name"], "Bash");
  assert.equal(policyCall.attributes["armoriq.policy.reason_code"], "Protected files cannot be removed");
  assert.equal(policyCall.attributes["armoriq.session_id"], sessionId);
});

test("PostToolUse ships a tool span with its outcome under the session", async (t) => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "armorcodex-obs-"));
  const ingest = await startIngestServer();
  t.after(async () => {
    await ingest.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  const sessionId = randomUUID();
  const config = obsConfig(dataDir, ingest.endpoint);
  const tool = { session_id: sessionId, tool_name: "Bash", tool_input: { command: "ls" } };
  await observeHook("UserPromptSubmit", { session_id: sessionId, prompt: "List" }, null, config);
  await observeHook("PostToolUse", { ...tool, tool_response: { stdout: "a" } }, null, config);
  await observeHook("PostToolUse", { ...tool, error: "exit 1" }, null, config);
  await observeHook("Stop", { session_id: sessionId }, null, config);

  const tools = ingest.exports.flatMap((e) => e.spans).filter((s) => s.name === "armoriq.tool");
  assert.deepEqual(
    tools.map((s) => [s.attributes["armoriq.tool.outcome"], s.attributes["armoriq.session_id"]]),
    [
      ["success", sessionId],
      ["error", sessionId],
    ],
  );
});

test("outbound observability payload redacts prompt and tool-input secrets", async (t) => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "armorcodex-obs-"));
  const ingest = await startIngestServer();
  t.after(async () => {
    await ingest.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  const sessionId = randomUUID();
  const config = obsConfig(dataDir, ingest.endpoint);
  const promptSecret = `ghp_${"a".repeat(40)}`;
  const bearerSecret = "tool-input-bearer-secret-123456789";

  await observeHook(
    "UserPromptSubmit",
    {
      session_id: sessionId,
      prompt: `Deploy the release with ${promptSecret} after verification`,
    },
    null,
    config,
  );
  await observeHook(
    "PreToolUse",
    {
      session_id: sessionId,
      tool_name: "Bash",
      tool_input: {
        command: `curl -H "Authorization: Bearer ${bearerSecret}" https://example.test/deploy`,
        metadata: { purpose: "release verification" },
      },
    },
    { hookSpecificOutput: { permissionDecision: "allow" } },
    config,
  );
  await observeHook("Stop", { session_id: sessionId }, null, config);

  const wireJson = ingest.exports.map((e) => e.raw).join("");
  assert.ok(wireJson.length > 0);
  assert.doesNotMatch(wireJson, new RegExp(promptSecret));
  assert.doesNotMatch(wireJson, new RegExp(bearerSecret));
  assert.match(wireJson, /Deploy the release with/);
  assert.match(wireJson, /release verification/);
  assert.match(wireJson, /<redacted>|\[REDACTED:SECRET\]/);
});

test("outbound observability payload redacts nested secret fields even when values are short and circular", async (t) => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "armorcodex-obs-"));
  const ingest = await startIngestServer();
  t.after(async () => {
    await ingest.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  const sessionId = randomUUID();
  const config = obsConfig(dataDir, ingest.endpoint);
  const toolInput = {
    credentials: {
      password: "p@ssw0rd",
      api_key: "tiny-key",
    },
  };
  toolInput.circular = toolInput;

  await observeHook(
    "UserPromptSubmit",
    { session_id: sessionId, prompt: "Use the provided credentials" },
    null,
    config,
  );
  await observeHook(
    "PreToolUse",
    {
      session_id: sessionId,
      tool_name: "Bash",
      tool_input: toolInput,
    },
    { hookSpecificOutput: { permissionDecision: "allow" } },
    config,
  );
  await observeHook("Stop", { session_id: sessionId }, null, config);

  config.sanitize.maxDepth = 12;
  const deepSessionId = randomUUID();
  const deepInput = {};
  let cursor = deepInput;
  for (let depth = 0; depth < 10; depth += 1) {
    cursor.nested = {};
    cursor = cursor.nested;
  }
  cursor.password = "deep-password";
  await observeHook(
    "UserPromptSubmit",
    { session_id: deepSessionId, prompt: "Use deeply nested credentials" },
    null,
    config,
  );
  await observeHook(
    "PreToolUse",
    { session_id: deepSessionId, tool_name: "Bash", tool_input: deepInput },
    { hookSpecificOutput: { permissionDecision: "allow" } },
    config,
  );
  await observeHook("Stop", { session_id: deepSessionId }, null, config);

  const wireJson = ingest.exports.map((e) => e.raw).join("");
  assert.ok(wireJson.length > 0);
  assert.doesNotMatch(wireJson, /p@ssw0rd/);
  assert.doesNotMatch(wireJson, /tiny-key/);
  assert.doesNotMatch(wireJson, /deep-password/);
  assert.match(wireJson, /<redacted>|\[REDACTED:SECRET\]/);
  assert.match(wireJson, /<max-depth>|\[TRUNCATED:MAX_DEPTH\]/);
});

test("session ids cannot escape the observability data directory", async (t) => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "armorcodex-obs-"));
  const escapedBasename = `armorcodex-escaped-${randomUUID()}.ndjson`;
  const escapedPath = path.join(path.dirname(dataDir), escapedBasename);
  t.after(async () => {
    await rm(dataDir, { recursive: true, force: true });
    await rm(escapedPath, { force: true });
  });

  const config = obsConfig(dataDir, "http://127.0.0.1:1");
  await observeHook(
    "UserPromptSubmit",
    {
      session_id: `../../../${escapedBasename.slice(0, -".ndjson".length)}`,
      prompt: "Keep this turn inside the configured data directory",
    },
    null,
    config,
  );

  await assert.rejects(access(escapedPath), { code: "ENOENT" });
  const names = await readdir(dataDir);
  assert.equal(names.length, 1);
  assert.match(names[0], /^obs-turn\.[a-f0-9]{64}\.ndjson$/);
});
