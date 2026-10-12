import { appendFileSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const MANIFESTS = [
  ["plugins/armorcodex/package.json", (json) => json.version],
  ["plugins/armorcodex/.codex-plugin/plugin.json", (json) => json.version],
  [".agents/plugins/marketplace.json", (json) => json.plugins?.find((p) => p.name === "armorcodex")?.version],
  [".codex-plugin/marketplace.json", (json) => json.plugins?.find((p) => p.name === "armorcodex")?.version]
];

const escape = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function manifestVersion(root) {
  const [[firstFile, firstRead], ...rest] = MANIFESTS;
  const read = (file, pick) => pick(JSON.parse(readFileSync(path.join(root, file), "utf8")));
  const version = read(firstFile, firstRead);
  for (const [file, pick] of rest) {
    const found = read(file, pick);
    if (found !== version) throw new Error(`${file} has ${found}, expected ${version} (from ${firstFile})`);
  }
  return version;
}

function changelogNotes(root, version, requireDated) {
  const changelog = readFileSync(path.join(root, "CHANGELOG.md"), "utf8");
  const date = requireDated ? String.raw`\d{4}-\d{2}-\d{2}` : ".*";
  const heading = new RegExp(String.raw`^## \[${escape(version)}\] [-—] ${date}$`, "m");
  const match = heading.exec(changelog);
  if (!match) throw new Error(`CHANGELOG.md has no dated section for ${version}`);
  const rest = changelog.slice(match.index + match[0].length);
  const next = rest.search(/^## /m);
  const notes = (next === -1 ? rest : rest.slice(0, next)).trim();
  if (!notes) throw new Error(`CHANGELOG.md section for ${version} is empty`);
  return notes;
}

export function releaseInfo(root, { requireDated = true } = {}) {
  const version = manifestVersion(root);
  return { version, tag: `v${version}`, notes: changelogNotes(root, version, requireDated) };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [root = ".", notesPath] = process.argv.slice(2);
  const info = releaseInfo(root);
  if (notesPath) appendFileSync(notesPath, `${info.notes}\n`);
  const output = process.env.GITHUB_OUTPUT;
  const lines = `version=${info.version}\ntag=${info.tag}\n`;
  if (output) appendFileSync(output, lines);
  else process.stdout.write(lines);
}
