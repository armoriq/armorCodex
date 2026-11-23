import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { handleSessionStart } from "../plugins/armorcodex/scripts/lib/engine.mjs";
import {
  CHECK_INTERVAL_SECONDS,
  checkForUpdate,
  compareVersions,
  isNewerVersion,
  parseVersion,
  runningVersion,
  updateNotice,
  updateStateFile
} from "../plugins/armorcodex/scripts/lib/update-check.mjs";

const NOW = 1_800_000_000;

function configIn(t, version = "0.3.3") {
  const dataDir = mkdtempSync(join(tmpdir(), "armorcodex-update-"));
  t.after(() => rmSync(dataDir, { recursive: true, force: true }));
  return { dataDir, clientVersion: `armorcodex/${version}` };
}

/** A real server on 127.0.0.1; `hits` is what proves a call did or did not happen. */
async function releaseServer(t, handler) {
  const hits = [];
  const server = createServer((req, res) => {
    hits.push(req.url);
    handler(req, res);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return { baseUrl: `http://127.0.0.1:${server.address().port}`, hits };
}

function respondTag(tag) {
  return (_req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ tag_name: tag, name: tag }));
  };
}

test("parseVersion reads a tag with or without the v prefix", () => {
  assert.deepEqual(parseVersion("v0.3.2"), { major: 0, minor: 3, patch: 2, prerelease: "" });
  assert.deepEqual(parseVersion("1.10.0"), { major: 1, minor: 10, patch: 0, prerelease: "" });
  assert.deepEqual(parseVersion("v2.0.0-rc.1"), { major: 2, minor: 0, patch: 0, prerelease: "rc.1" });
  for (const bad of ["", "v", "0.3", "0.3.x", "latest", "v0.3.2.1", null, undefined, 3]) {
    assert.equal(parseVersion(bad), null, `${String(bad)} is not a semver`);
  }
});

test("compareVersions orders equal, older and newer, and rejects malformed", () => {
  assert.equal(compareVersions("0.3.3", "0.3.3"), 0);
  assert.equal(compareVersions("v0.3.3", "0.3.3"), 0);
  assert.equal(compareVersions("0.3.4", "0.3.3"), 1);
  assert.equal(compareVersions("0.3.2", "0.3.3"), -1);
  assert.equal(compareVersions("0.10.0", "0.9.9"), 1);
  assert.equal(compareVersions("1.0.0", "0.99.99"), 1);
  assert.equal(compareVersions("1.0.0", "1.0.0-rc.1"), 1);
  assert.equal(compareVersions("1.0.0-rc.1", "1.0.0-rc.2"), -1);
  assert.equal(compareVersions("not-a-tag", "0.3.3"), null);
  assert.equal(compareVersions("0.3.3", "nightly"), null);
});

test("isNewerVersion is true only for a strictly higher released version", () => {
  assert.equal(isNewerVersion("0.3.4", "0.3.3"), true);
  assert.equal(isNewerVersion("0.3.3", "0.3.3"), false);
  assert.equal(isNewerVersion("0.3.2", "0.3.3"), false);
  assert.equal(isNewerVersion("garbage", "0.3.3"), false);
});

test("runningVersion strips the product and channel from the client header", () => {
  assert.equal(runningVersion({ clientVersion: "armorcodex/0.3.3" }), "0.3.3");
  assert.equal(runningVersion({ clientVersion: "armorcodex-dev/0.4.0" }), "0.4.0");
  const manifest = JSON.parse(
    readFileSync(new URL("../plugins/armorcodex/package.json", import.meta.url), "utf8")
  );
  assert.equal(runningVersion({}), manifest.version, "the real config carries no clientVersion");
});

test("a newer release tag is reported with the exact update command", async (t) => {
  const config = configIn(t);
  const { baseUrl, hits } = await releaseServer(t, respondTag("v0.4.0"));

  const result = await checkForUpdate(config, { baseUrl, now: NOW, env: {} });

  assert.deepEqual(hits, ["/repos/armoriq/armorCodex/releases/latest"]);
  assert.equal(result.checked, true);
  assert.equal(result.status, "update-available");
  assert.equal(result.latestVersion, "v0.4.0");
  assert.equal(
    updateNotice(result),
    "ArmorCodex v0.4.0 is available (running 0.3.3). Update with: curl -fsSL https://armoriq.ai/install_armorcodex.sh | bash"
  );
});

test("the release API and repo follow the installer's overrides", async (t) => {
  const config = configIn(t);
  const { baseUrl, hits } = await releaseServer(t, respondTag("v0.4.0"));

  const result = await checkForUpdate(config, {
    now: NOW,
    env: { ARMORCODEX_RELEASE_API: baseUrl, ARMORCODEX_MARKETPLACE_REPO: "someone/fork" }
  });

  assert.deepEqual(hits, ["/repos/someone/fork/releases/latest"]);
  assert.equal(result.status, "update-available");
});

test("the running version being the latest release reports current and no notice", async (t) => {
  const config = configIn(t);
  const { baseUrl } = await releaseServer(t, respondTag("v0.3.3"));

  const result = await checkForUpdate(config, { baseUrl, now: NOW, env: {} });

  assert.equal(result.status, "current");
  assert.equal(updateNotice(result), "");
});

test("an older release tag than the running build is not an update", async (t) => {
  const config = configIn(t);
  const { baseUrl } = await releaseServer(t, respondTag("v0.3.2"));

  const result = await checkForUpdate(config, { baseUrl, now: NOW, env: {} });

  assert.equal(result.status, "current");
  assert.equal(updateNotice(result), "");
});

test("a malformed tag is swallowed as unknown rather than thrown", async (t) => {
  const config = configIn(t);
  const { baseUrl } = await releaseServer(t, respondTag("nightly-build"));

  const result = await checkForUpdate(config, { baseUrl, now: NOW, env: {} });

  assert.equal(result.status, "unknown");
  assert.equal(updateNotice(result), "");
});

test("a second check inside the interval reuses the state file and sends no request", async (t) => {
  const config = configIn(t);
  const { baseUrl, hits } = await releaseServer(t, respondTag("v0.4.0"));

  const first = await checkForUpdate(config, { baseUrl, now: NOW, env: {} });
  assert.equal(first.checked, true);

  const state = JSON.parse(readFileSync(updateStateFile(config), "utf8"));
  assert.deepEqual(state, { lastCheckedAt: NOW, latestVersion: "v0.4.0" });

  const later = await checkForUpdate(config, {
    baseUrl,
    now: NOW + CHECK_INTERVAL_SECONDS - 1,
    env: {}
  });

  assert.equal(hits.length, 1, "no second request inside the interval");
  assert.equal(later.checked, false);
  assert.equal(later.status, "update-available", "the cached version still drives the notice");
  assert.equal(later.latestVersion, "v0.4.0");

  const afterInterval = await checkForUpdate(config, {
    baseUrl,
    now: NOW + CHECK_INTERVAL_SECONDS,
    env: {}
  });
  assert.equal(hits.length, 2, "the interval elapsing allows one more request");
  assert.equal(afterInterval.checked, true);
});

test("a lastCheckedAt in the future does not suppress checks forever", async (t) => {
  const config = configIn(t);
  const { baseUrl, hits } = await releaseServer(t, respondTag("v0.4.0"));
  writeFileSync(
    updateStateFile(config),
    JSON.stringify({ lastCheckedAt: NOW + 10 * CHECK_INTERVAL_SECONDS, latestVersion: "" })
  );

  const result = await checkForUpdate(config, { baseUrl, now: NOW, env: {} });

  assert.equal(hits.length, 1, "a clock that jumped backwards still gets a check");
  assert.equal(result.checked, true);
  assert.equal(result.status, "update-available");
  assert.equal(JSON.parse(readFileSync(updateStateFile(config), "utf8")).lastCheckedAt, NOW);
});

test("ARMORCODEX_NO_AUTO_UPDATE short-circuits before the request and writes no state", async (t) => {
  const config = configIn(t);
  const { baseUrl, hits } = await releaseServer(t, respondTag("v0.4.0"));

  for (const value of ["1", "true", "yes"]) {
    const result = await checkForUpdate(config, {
      baseUrl,
      now: NOW,
      env: { ARMORCODEX_NO_AUTO_UPDATE: value }
    });
    assert.equal(result.status, "disabled", `opted out via ${value}`);
    assert.equal(updateNotice(result), "");
  }

  assert.deepEqual(hits, [], "the opt-out is honoured before any network call");
  assert.throws(() => readFileSync(updateStateFile(config), "utf8"), { code: "ENOENT" });

  const optedIn = await checkForUpdate(config, {
    baseUrl,
    now: NOW,
    env: { ARMORCODEX_NO_AUTO_UPDATE: "0" }
  });
  assert.equal(hits.length, 1, "0 means the check still runs");
  assert.equal(optedIn.status, "update-available");
});

test("a server error is swallowed and still backs off for the interval", async (t) => {
  const config = configIn(t);
  const { baseUrl, hits } = await releaseServer(t, (_req, res) => {
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ message: "Not Found" }));
  });

  const result = await checkForUpdate(config, { baseUrl, now: NOW, env: {} });
  assert.equal(result.status, "unknown");
  assert.equal(result.checked, true);
  assert.equal(updateNotice(result), "");

  const state = JSON.parse(readFileSync(updateStateFile(config), "utf8"));
  assert.equal(state.lastCheckedAt, NOW);

  await checkForUpdate(config, { baseUrl, now: NOW + 60, env: {} });
  assert.equal(hits.length, 1, "a failed check backs off instead of retrying every session");
});

test("a hung server is cut off by the timeout rather than blocking the session", async (t) => {
  const config = configIn(t);
  const { baseUrl } = await releaseServer(t, () => {
    // Never responds: the AbortSignal is the only thing that ends this call.
  });

  const startedAt = Date.now();
  const result = await checkForUpdate(config, { baseUrl, now: NOW, env: {}, timeoutMs: 300 });
  const elapsed = Date.now() - startedAt;

  assert.equal(result.status, "unknown");
  assert.ok(elapsed < 3000, `gave up after ${elapsed}ms`);
  assert.equal(JSON.parse(readFileSync(updateStateFile(config), "utf8")).lastCheckedAt, NOW);
});

test("a refused connection is swallowed", async (t) => {
  const config = configIn(t);
  const closed = createServer();
  await new Promise((resolve) => closed.listen(0, "127.0.0.1", resolve));
  const port = closed.address().port;
  await new Promise((resolve) => closed.close(resolve));

  const result = await checkForUpdate(config, {
    baseUrl: `http://127.0.0.1:${port}`,
    now: NOW,
    env: {},
    timeoutMs: 1000
  });

  assert.equal(result.status, "unknown");
  assert.equal(result.runningVersion, "0.3.3");
  assert.equal(JSON.parse(readFileSync(updateStateFile(config), "utf8")).lastCheckedAt, NOW);
});

test("a corrupt state file does not break the check", async (t) => {
  const config = configIn(t);
  const { baseUrl } = await releaseServer(t, respondTag("v0.4.0"));
  writeFileSync(updateStateFile(config), "{not json");

  const result = await checkForUpdate(config, { baseUrl, now: NOW, env: {} });

  assert.equal(result.status, "update-available");
  assert.equal(result.latestVersion, "v0.4.0");
});

// SessionStart is the one hook that runs once per session, so it is where the
// check is wired. These drive the real handler, not the checker directly.

function sessionConfig(t, overrides = {}) {
  const dataDir = mkdtempSync(join(tmpdir(), "armorcodex-session-"));
  t.after(() => rmSync(dataDir, { recursive: true, force: true }));
  return {
    mode: "enforce",
    intentRequired: true,
    dataDir,
    runtimeFile: join(dataDir, "runtime.json"),
    clientVersion: "armorcodex/0.3.3",
    ...overrides
  };
}

const sessionContext = (output) => output?.hookSpecificOutput?.additionalContext ?? "";

test("SessionStart surfaces a pending update from state without any network call", async (t) => {
  const config = sessionConfig(t);
  // Checked just now, so the cached version decides and no request is made.
  writeFileSync(
    updateStateFile(config),
    JSON.stringify({ lastCheckedAt: Math.floor(Date.now() / 1000), latestVersion: "v9.9.9" })
  );

  // A release checkout, whatever branch the tree running this test is on.
  const liveRoot = mkdtempSync(join(tmpdir(), "armorcodex-release-checkout-"));
  t.after(() => rmSync(liveRoot, { recursive: true, force: true }));
  mkdirSync(join(liveRoot, ".git"));
  writeFileSync(join(liveRoot, ".git", "HEAD"), "0123456789abcdef0123456789abcdef01234567\n");

  const output = await handleSessionStart(
    { hook_event_name: "SessionStart", session_id: "sess-update", source: "startup" },
    config,
    { liveRoot }
  );

  assert.equal(sessionContext(output), "ArmorCodex active (ENFORCING, intent=required). Not signed in to ArmorIQ: only the local policy and intent plan apply; org policies, approvals and audit upload are off.");
  // systemMessage, not additionalContext: the notice is for the person, and
  // the model must not be handed an install command to run mid-session.
  assert.match(output.systemMessage, /ArmorCodex v9\.9\.9 is available \(running 0\.3\.3\)/);
  assert.match(output.systemMessage, /curl -fsSL https:\/\/armoriq\.ai\/install_armorcodex\.sh \| bash/);
  assert.doesNotMatch(sessionContext(output), /curl -fsSL/);
  assert.ok(
    JSON.parse(readFileSync(config.runtimeFile, "utf8")).sessions["sess-update"],
    "the session is still recorded"
  );
});

test("SessionStart says nothing extra when the cached release matches the running build", async (t) => {
  const config = sessionConfig(t);
  writeFileSync(
    updateStateFile(config),
    JSON.stringify({ lastCheckedAt: Math.floor(Date.now() / 1000), latestVersion: "v0.3.3" })
  );

  const output = await handleSessionStart(
    { hook_event_name: "SessionStart", session_id: "sess-current", source: "startup" },
    config
  );

  assert.equal(sessionContext(output), "ArmorCodex active (ENFORCING, intent=required). Not signed in to ArmorIQ: only the local policy and intent plan apply; org policies, approvals and audit upload are off.");
  assert.equal(output.systemMessage, undefined);
});

test("SessionStart with the opt-out set never reads or writes update state", async (t) => {
  const config = sessionConfig(t);
  process.env.ARMORCODEX_NO_AUTO_UPDATE = "1";
  t.after(() => delete process.env.ARMORCODEX_NO_AUTO_UPDATE);
  writeFileSync(
    updateStateFile(config),
    JSON.stringify({ lastCheckedAt: Math.floor(Date.now() / 1000), latestVersion: "v9.9.9" })
  );

  const output = await handleSessionStart(
    { hook_event_name: "SessionStart", session_id: "sess-optout", source: "startup" },
    config
  );

  assert.equal(sessionContext(output), "ArmorCodex active (ENFORCING, intent=required). Not signed in to ArmorIQ: only the local policy and intent plan apply; org policies, approvals and audit upload are off.");
  assert.equal(output.systemMessage, undefined);
});
