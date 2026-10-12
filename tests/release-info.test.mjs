import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { releaseInfo } from "../.github/scripts/release-info.mjs";

const MANIFESTS = [
  "plugins/armorcodex/package.json",
  "plugins/armorcodex/.codex-plugin/plugin.json",
  ".agents/plugins/marketplace.json",
  ".codex-plugin/marketplace.json"
];

function repo(t, { versions = {}, changelog }) {
  const root = mkdtempSync(path.join(tmpdir(), "armorcodex-release-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const file of MANIFESTS) {
    mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    const version = versions[file] ?? "0.3.5";
    const body = file.endsWith("marketplace.json")
      ? { name: "armoriq", plugins: [{ name: "armorcodex", version }] }
      : { name: "armorcodex", version };
    writeFileSync(path.join(root, file), JSON.stringify(body));
  }
  writeFileSync(path.join(root, "CHANGELOG.md"), changelog);
  return root;
}

const CHANGELOG = `# Changelog

Intro.

## [0.3.5] - 2026-10-12

### Added
- Turn latency.

### Fixed
- The hook signs the registered plan.

## [0.3.4] - 2026-10-10

### Added
- Usage upload.
`;

test("the release takes the manifests' version and that version's CHANGELOG section as notes", (t) => {
  const info = releaseInfo(repo(t, { changelog: CHANGELOG }));
  assert.equal(info.version, "0.3.5");
  assert.equal(info.tag, "v0.3.5");
  assert.equal(info.notes, "### Added\n- Turn latency.\n\n### Fixed\n- The hook signs the registered plan.");
});

test("a manifest with another version stops the release and names the file", (t) => {
  const root = repo(t, { versions: { ".codex-plugin/marketplace.json": "0.3.4" }, changelog: CHANGELOG });
  assert.throws(() => releaseInfo(root), /\.codex-plugin\/marketplace\.json has 0\.3\.4, expected 0\.3\.5/);
});

test("a CHANGELOG without a section for the version stops the release", (t) => {
  const root = repo(t, { versions: Object.fromEntries(MANIFESTS.map((f) => [f, "0.3.6"])), changelog: CHANGELOG });
  assert.throws(() => releaseInfo(root), /CHANGELOG\.md has no dated section for 0\.3\.6/);
});

test("an Unreleased section stops the release", (t) => {
  const root = repo(t, { changelog: CHANGELOG.replace("## [0.3.5] - 2026-10-12", "## [0.3.5] - Unreleased") });
  assert.throws(() => releaseInfo(root), /CHANGELOG\.md has no dated section for 0\.3\.5/);
});

test("an empty section stops the release", (t) => {
  const root = repo(t, { changelog: "# Changelog\n\n## [0.3.5] - 2026-10-12\n\n## [0.3.4] - 2026-10-10\n- x\n" });
  assert.throws(() => releaseInfo(root), /CHANGELOG\.md section for 0\.3\.5 is empty/);
});

test("the repo's own manifests agree on one version", () => {
  const info = releaseInfo(path.resolve(import.meta.dirname, ".."), { requireDated: false });
  assert.match(info.version, /^\d+\.\d+\.\d+$/);
});
