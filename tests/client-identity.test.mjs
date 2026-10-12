import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { CLIENT, clientIdentity } from "../plugins/armorcodex/scripts/lib/client-identity.mjs";
import { createIapService } from "../plugins/armorcodex/scripts/lib/iap-service.mjs";
import { getSdkClient } from "../plugins/armorcodex/scripts/lib/intent.mjs";

const manifest = JSON.parse(readFileSync(new URL("../plugins/armorcodex/package.json", import.meta.url), "utf8"));

test("the channel comes from the SDK package the plugin depends on", () => {
  assert.deepEqual(clientIdentity({ version: "1.2.3", dependencies: { "@armoriq/sdk-dev": "^0.8.16" } }), {
    product: "armorcodex-dev",
    version: "1.2.3",
  });
  assert.deepEqual(clientIdentity({ version: "1.2.3", dependencies: { "@armoriq/sdk": "^0.9.0" } }), {
    product: "armorcodex",
    version: "1.2.3",
  });
  assert.deepEqual(CLIENT, { product: "armorcodex-dev", version: manifest.version });
});

test("the audit batch request carries the X-ArmorIQ-Client header", async (t) => {
  const seen = [];
  const server = createServer((request, response) => {
    seen.push(`${request.url} ${request.headers["x-armoriq-client"]}`);
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ written: 1, failures: [] }));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => server.close());
  const svc = createIapService({
    backendEndpoint: `http://127.0.0.1:${server.address().port}`,
    apiKey: "ak_test_client_header",
    timeoutMs: 5000,
  });

  await svc.shipAuditBatch([{ tool: "Read" }]);

  assert.deepEqual(seen, [`/iap/audit/batch armorcodex-dev/${manifest.version}`]);
});

test("the SDK client is built with ArmorCodex's client identity", () => {
  const client = getSdkClient({
    apiKey: "ak_test_client_header",
    userId: "user",
    agentId: "codex",
    contextId: "ctx",
    iapEndpoint: "http://127.0.0.1:1",
    proxyEndpoint: "http://127.0.0.1:1",
    backendEndpoint: "http://127.0.0.1:1",
    timeoutMs: 1000,
    maxRetries: 0,
    verifySsl: true,
  });
  assert.deepEqual(client._sessionInternals().client, CLIENT);
});
