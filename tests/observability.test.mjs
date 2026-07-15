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

async function startIngestServer() {
  const requests = [];
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    requests.push({
      method: request.method,
      url: request.url,
      body: JSON.parse(Buffer.concat(chunks).toString("utf8")),
    });
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ accepted: 1, rejected: 0 }));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  return {
    endpoint: `http://127.0.0.1:${address.port}`,
    requests,
    close: async () => {
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

  assert.equal(ingest.requests.length, 2);
  const generationSpans = ingest.requests.map((request) => {
    const spans = request.body.batches.flatMap((batch) => batch.spans);
    const generations = spans.filter((span) => span.kind === "generation");
    assert.equal(generations.length, 1);
    assert.ok(generations[0].attributes.costUsd > 0);
    return generations[0];
  });

  assert.deepEqual(
    generationSpans.map((span) => ({
      inputTokens: span.attributes.inputTokens,
      outputTokens: span.attributes.outputTokens,
      cacheReadTokens: span.attributes.cacheReadTokens,
    })),
    [
      { inputTokens: 100, outputTokens: 10, cacheReadTokens: 20 },
      { inputTokens: 50, outputTokens: 15, cacheReadTokens: 30 },
    ],
  );

  const summed = generationSpans.reduce(
    (totals, span) => ({
      inputTokens: totals.inputTokens + span.attributes.inputTokens,
      outputTokens: totals.outputTokens + span.attributes.outputTokens,
      cacheReadTokens: totals.cacheReadTokens + span.attributes.cacheReadTokens,
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

  assert.equal(ingest.requests.length, 1);
  assert.equal(ingest.requests[0].method, "POST");
  assert.equal(ingest.requests[0].url, "/observability/spans");

  const [{ spans }] = ingest.requests[0].body.batches;
  const policyCall = spans.find((span) => span.kind === "policy_call");
  assert.ok(policyCall);
  assert.equal(policyCall.status, "denied");
  assert.equal(policyCall.attributes.decision, "deny");
  assert.equal(policyCall.attributes.enforcementAction, "block");
  assert.equal(policyCall.attributes.reason, "Protected files cannot be removed");
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

  assert.equal(ingest.requests.length, 1);
  const wireJson = JSON.stringify(ingest.requests[0].body);
  assert.doesNotMatch(wireJson, new RegExp(promptSecret));
  assert.doesNotMatch(wireJson, new RegExp(bearerSecret));
  assert.match(wireJson, /Deploy the release with/);
  assert.match(wireJson, /release verification/);
  assert.match(wireJson, /<redacted>/);
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

  assert.equal(ingest.requests.length, 2);
  const wireJson = JSON.stringify(ingest.requests.map((request) => request.body));
  assert.doesNotMatch(wireJson, /p@ssw0rd/);
  assert.doesNotMatch(wireJson, /tiny-key/);
  assert.doesNotMatch(wireJson, /deep-password/);
  assert.match(wireJson, /<redacted>/);
  assert.match(wireJson, /<max-depth>/);
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
