import assert from "node:assert/strict";
import test from "node:test";
import { credentialFor } from "../plugins/armorcodex/scripts/lib/credentials-profile.mjs";
import { buildAuthHeaders } from "../plugins/armorcodex/scripts/lib/common.mjs";

const BACKEND = "https://api.armoriq.ai";

const v2 = {
  version: 2,
  active: "armorcodex@api.armoriq.ai",
  profiles: {
    "armorclaude@api.armoriq.ai": {
      product: "armorclaude",
      backend: BACKEND,
      apiKey: "ak_live_claude",
      orgId: "org-claude",
    },
    "armorcodex@api.armoriq.ai": {
      product: "armorcodex",
      backend: BACKEND,
      apiKey: "ak_live_codex",
      orgId: "org-codex",
    },
    "armorcodex@staging-api.armoriq.ai": {
      product: "armorcodex",
      backend: "https://staging-api.armoriq.ai",
      apiKey: "ak_test_codex_staging",
      orgId: "org-staging",
    },
  },
};

test("a version 2 document yields this product's key for this backend", () => {
  assert.deepEqual(credentialFor(v2, { backend: BACKEND, product: "armorcodex" }), {
    apiKey: "ak_live_codex",
    orgId: "org-codex",
  });
});

test("a version 2 document never leaks another product's or backend's key", () => {
  assert.equal(
    credentialFor(v2, { backend: BACKEND, product: "armoropencode" }).apiKey,
    "",
  );
  assert.equal(
    credentialFor(v2, { backend: "https://staging-api.armoriq.ai", product: "armorcodex" })
      .apiKey,
    "ak_test_codex_staging",
  );
});

test("a trailing slash or path on the backend still matches the profile", () => {
  assert.equal(
    credentialFor(v2, { backend: "https://api.armoriq.ai/", product: "armorcodex" }).apiKey,
    "ak_live_codex",
  );
});

test("the pre-version-2 flat document still resolves", () => {
  assert.deepEqual(
    credentialFor({ apiKey: "ak_live_flat", orgId: "org-flat" }, {
      backend: BACKEND,
      product: "armorcodex",
    }),
    { apiKey: "ak_live_flat", orgId: "org-flat" },
  );
});

test("a malformed or empty document yields no key rather than throwing", () => {
  for (const creds of [null, undefined, "nonsense", {}, { version: 2 }, { version: 2, profiles: 7 }]) {
    assert.deepEqual(credentialFor(creds, { backend: BACKEND, product: "armorcodex" }), {
      apiKey: "",
      orgId: "",
    });
  }
});

test("backend requests carry the client version so the backend can see this build", () => {
  const headers = buildAuthHeaders({ apiKey: "ak_live_codex", clientVersion: "armorcodex/0.3.3" });
  assert.equal(headers["X-ArmorIQ-Client"], "armorcodex/0.3.3");
});

test("a build with no client version sends no client header", () => {
  assert.equal(buildAuthHeaders({ apiKey: "ak_live_codex" })["X-ArmorIQ-Client"], undefined);
});
