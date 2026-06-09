import test from "node:test";
import assert from "node:assert/strict";
import {
  computePolicyDigest,
  createCryptoPolicyService
} from "../plugins/armorcodex/scripts/lib/crypto-policy.mjs";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

test("computePolicyDigest produces deterministic hash", () => {
  const rules = [
    { id: "p1", action: "deny", tool: "web_fetch", dataClass: "PCI" },
    { id: "p2", action: "allow", tool: "*" }
  ];
  const d1 = computePolicyDigest(rules);
  const d2 = computePolicyDigest(rules);
  assert.equal(d1, d2);
  assert.equal(d1.length, 64); // SHA-256 hex
});

test("computePolicyDigest differs for different rules", () => {
  const d1 = computePolicyDigest([{ id: "p1", action: "deny", tool: "web_fetch" }]);
  const d2 = computePolicyDigest([{ id: "p1", action: "allow", tool: "web_fetch" }]);
  assert.notEqual(d1, d2);
});

test("computePolicyDigest handles empty rules", () => {
  const d = computePolicyDigest([]);
  assert.equal(d.length, 64);
});

test("verifyPolicyDigest returns valid on match", async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "armorcodex-test-"));
  const config = {
    dataDir: tmp,
    csrgEndpoint: "http://localhost:8000",
    iapEndpoint: "http://localhost:8000",
    timeoutMs: 5000,
    userId: "test",
    agentId: "test",
    contextId: "default"
  };
  const service = createCryptoPolicyService(config);
  const digest = computePolicyDigest([{ id: "p1", action: "deny", tool: "bash" }]);
  const result = service.verifyPolicyDigest(digest, digest);
  assert.equal(result.valid, true);
});

test("verifyPolicyDigest returns invalid on mismatch", async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "armorcodex-test-"));
  const config = {
    dataDir: tmp,
    csrgEndpoint: "http://localhost:8000",
    iapEndpoint: "http://localhost:8000",
    timeoutMs: 5000,
    userId: "test",
    agentId: "test",
    contextId: "default"
  };
  const service = createCryptoPolicyService(config);
  const result = service.verifyPolicyDigest("aaaa", "bbbb");
  assert.equal(result.valid, false);
  assert.match(result.reason, /mismatch/i);
});

test("verifyPolicyDigest returns invalid when no token digest", async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "armorcodex-test-"));
  const config = {
    dataDir: tmp,
    csrgEndpoint: "http://localhost:8000",
    iapEndpoint: "http://localhost:8000",
    timeoutMs: 5000
  };
  const service = createCryptoPolicyService(config);
  const result = service.verifyPolicyDigest("abc123", undefined);
  assert.equal(result.valid, false);
  assert.match(result.reason, /not cryptographically bound/i);
});

test("loadCachedState returns null when no state file", async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "armorcodex-test-"));
  const config = {
    dataDir: tmp,
    csrgEndpoint: "http://localhost:8000",
    iapEndpoint: "http://localhost:8000",
    timeoutMs: 5000
  };
  const service = createCryptoPolicyService(config);
  const state = await service.loadCachedState();
  assert.equal(state, null);
});
