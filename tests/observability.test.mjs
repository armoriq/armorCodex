import assert from "node:assert/strict";
import { once } from "node:events";
import { access, appendFile, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";

import { denyPermissionRequest } from "../plugins/armorcodex/scripts/lib/hook-output.mjs";
import { observeHook } from "../plugins/armorcodex/scripts/lib/observability.mjs";

const { OtelSession } = createRequire(new URL("../plugins/armorcodex/package.json", import.meta.url))(
  "@armoriq/sdk-dev",
);

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
      fields.push({ no, double: buf.readDoubleLE(i), fixed: buf.readBigUInt64LE(i) });
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
        const ms = (no) => Number(field(span.bytes, no)[0].fixed / 1_000_000n);
        const status = field(span.bytes, 15)[0];
        spans.push({
          name: field(span.bytes, 5)[0]?.bytes.toString("utf8"),
          spanId: field(span.bytes, 2)[0]?.bytes.toString("hex"),
          attributes,
          startMs: ms(7),
          endMs: ms(8),
          statusCode: status ? Number(field(status.bytes, 3)[0]?.value ?? 0n) : 0,
        });
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

function usageRecord(timestamp, responseId, usage) {
  return { timestamp, type: "token_usage_record", payload: { response_id: responseId, usage } };
}

test("Stop ships one generation span per model request of the turn, ending at the request's time", async (t) => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "armorcodex-obs-"));
  const rolloutPath = path.join(dataDir, "rollout.jsonl");
  const ingest = await startIngestServer();
  t.after(async () => {
    await ingest.close();
    await rm(dataDir, { recursive: true, force: true });
  });
  const base = Date.now() - 60_000;
  t.mock.timers.enable({ apis: ["Date"], now: base });
  const iso = (offsetMs) => new Date(base + offsetMs).toISOString();
  const sessionId = randomUUID();
  const config = obsConfig(dataDir, ingest.endpoint);
  const turn = (requests) => [
    { type: "event_msg", payload: { type: "task_started" } },
    { type: "turn_context", payload: { model: "gpt-5.5" } },
    ...requests,
    { type: "event_msg", payload: { type: "task_complete" } },
  ];
  const write = (lines) => appendFile(rolloutPath, `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`, "utf8");

  await write(turn([usageRecord(iso(500), "resp_earlier", { input_tokens: 900, cached_input_tokens: 100, output_tokens: 9 })]));
  await observeHook("UserPromptSubmit", { session_id: sessionId, prompt: "First turn" }, null, config);
  t.mock.timers.setTime(base + 1_000);
  await observeHook("Stop", { session_id: sessionId, transcript_path: rolloutPath }, null, config);

  t.mock.timers.setTime(base + 2_000);
  await observeHook("UserPromptSubmit", { session_id: sessionId, prompt: "Second turn" }, null, config);
  const inputs = [20_000, 25_000, 28_000, 30_000, 34_000, 40_680];
  await write(
    turn(inputs.map((input, i) =>
      usageRecord(iso(3_000 + i * 1_000), `resp_${i}`, { input_tokens: input, cached_input_tokens: 15_000, output_tokens: 100 }),
    )),
  );
  t.mock.timers.setTime(base + 10_000);
  await observeHook("Stop", { session_id: sessionId, transcript_path: rolloutPath }, null, config);

  const generations = ingest.exports.flatMap((e) => e.spans).filter((span) => span.name === "gen_ai.chat");
  assert.equal(generations.length, 7);
  const second = generations.slice(1);
  assert.deepEqual(second.map((span) => span.endMs - base), [3_000, 4_000, 5_000, 6_000, 7_000, 8_000]);
  assert.equal(new Set(generations.map((span) => span.spanId)).size, 7);
  const total = (key) => second.reduce((sum, span) => sum + span.attributes[key], 0);
  assert.equal(total("gen_ai.usage.input_tokens") + total("gen_ai.usage.cache_read_tokens"), 177_680);
  assert.equal(total("gen_ai.usage.output_tokens"), 600);
  for (const span of generations) {
    assert.equal(span.attributes["gen_ai.usage.cost_usd"], undefined);
    assert.equal(span.attributes["armoriq.cost.provenance"], undefined);
    assert.equal(span.attributes["armoriq.timing.provenance"], "reported");
    assert.equal(span.attributes["armoriq.session_id"], sessionId);
  }
});

test("Stop still ships the turn and logs the error when a model span fails", async (t) => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "armorcodex-obs-"));
  const rolloutPath = path.join(dataDir, "rollout.jsonl");
  const ingest = await startIngestServer();
  t.after(async () => {
    await ingest.close();
    await rm(dataDir, { recursive: true, force: true });
  });
  t.mock.method(OtelSession.prototype, "recordModel", async () => {
    throw new Error("model span failed");
  });
  const stderr = [];
  t.mock.method(process.stderr, "write", (chunk) => {
    stderr.push(String(chunk));
    return true;
  });

  const sessionId = randomUUID();
  const config = obsConfig(dataDir, ingest.endpoint);
  await writeFile(
    rolloutPath,
    [
      { type: "event_msg", payload: { type: "task_started" } },
      { type: "turn_context", payload: { model: "gpt-4.1" } },
      usageRecord(new Date().toISOString(), "resp_1", { input_tokens: 120, cached_input_tokens: 20, output_tokens: 10 }),
    ]
      .map((line) => JSON.stringify(line))
      .join("\n"),
    "utf8",
  );
  await observeHook("UserPromptSubmit", { session_id: sessionId, prompt: "List" }, null, config);
  await observeHook(
    "PreToolUse",
    { session_id: sessionId, tool_name: "Bash", tool_input: { command: "ls" } },
    { hookSpecificOutput: { permissionDecision: "allow" } },
    config,
  );
  await observeHook("Stop", { session_id: sessionId, transcript_path: rolloutPath }, null, config);

  const spans = ingest.exports.flatMap((e) => e.spans);
  assert.deepEqual(spans.map((span) => span.name).sort(), ["armoriq.agent.run", "armoriq.policy.evaluate"]);
  assert.equal(spans.find((span) => span.name === "armoriq.agent.run").statusCode, 2);
  assert.match(stderr.join(""), /Stop could not replay the turn: model span failed/);
  assert.deepEqual(await readdir(dataDir), ["rollout.jsonl"]);
});

test("Stop replays each span at its hook's time, and a tool's policy span carries the tool's call id", async (t) => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "armorcodex-obs-"));
  const ingest = await startIngestServer();
  t.after(async () => {
    await ingest.close();
    await rm(dataDir, { recursive: true, force: true });
  });
  const base = Date.now() - 60_000;
  t.mock.timers.enable({ apis: ["Date"], now: base });
  const at = (offsetMs) => t.mock.timers.setTime(base + offsetMs);

  const sessionId = randomUUID();
  const config = obsConfig(dataDir, ingest.endpoint);
  const allow = { hookSpecificOutput: { permissionDecision: "allow" } };
  const deny = { hookSpecificOutput: { permissionDecision: "deny" } };
  const bash = { session_id: sessionId, tool_name: "Bash", tool_input: { command: "ls" }, tool_use_id: "call_bash" };
  await observeHook("UserPromptSubmit", { session_id: sessionId, prompt: "List" }, null, config);
  at(1_000);
  await observeHook("PreToolUse", { session_id: sessionId, tool_name: "webrun", tool_input: {}, tool_use_id: "call_web" }, deny, config);
  at(2_000);
  await observeHook("PreToolUse", bash, allow, config);
  at(7_000);
  await observeHook("PostToolUse", { ...bash, tool_response: { stdout: "a" } }, null, config);
  at(8_000);
  await observeHook("Stop", { session_id: sessionId }, null, config);

  const spans = ingest.exports.flatMap((e) => e.spans);
  const byCall = (name, callId) =>
    spans.find((span) => span.name === name && span.attributes["armoriq.tool.call_id"] === callId);
  const root = spans.find((span) => span.name === "armoriq.agent.run");
  assert.deepEqual([root.startMs - base, root.endMs - base], [0, 8_000]);
  assert.equal(byCall("armoriq.policy.evaluate", "call_web").endMs - base, 1_000);
  assert.equal(byCall("armoriq.policy.evaluate", "call_bash").endMs - base, 2_000);
  const tool = byCall("armoriq.tool", "call_bash");
  assert.deepEqual([tool.startMs - base, tool.endMs - base], [2_000, 7_000]);
});

test("PermissionRequest denial ships as a denied policy call without its free-text reason", async (t) => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "armorcodex-obs-"));
  const ingest = await startIngestServer();
  t.after(async () => {
    await ingest.close();
    await rm(dataDir, { recursive: true, force: true });
  });
  const policyResults = [];
  const recordPolicy = OtelSession.prototype.recordPolicy;
  t.mock.method(OtelSession.prototype, "recordPolicy", function (call, result) {
    policyResults.push(result);
    return recordPolicy.call(this, call, result);
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
  assert.equal(policyCall.attributes["armoriq.tool.name"], "Bash");
  assert.equal(policyCall.attributes["armoriq.session_id"], sessionId);
  assert.deepEqual(policyResults, [{ decision: "block" }]);
  assert.ok(!JSON.stringify(spans).includes("Protected files cannot be removed"));
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
