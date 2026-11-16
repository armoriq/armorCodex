import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const workflow = readFileSync(new URL("../.github/workflows/release.yml", import.meta.url), "utf8");

function jobs() {
  const body = workflow.slice(workflow.indexOf("\njobs:\n") + 7);
  return body.split(/\n(?=  [\w-]+:\n)/).map((text) => ({ name: text.match(/^\s*([\w-]+):/)[1], text }));
}

test("the workflow's default token is read-only", () => {
  const header = workflow.slice(0, workflow.indexOf("\njobs:\n"));
  assert.match(header, /^permissions:\n  contents: read\n/m);
  assert.doesNotMatch(header, /write/);
});

test("no checkout leaves the token in .git/config", () => {
  const checkouts = workflow.split(/(?=- uses: )/).filter((step) => step.startsWith("- uses: actions/checkout@"));
  assert.ok(checkouts.length > 0);
  for (const step of checkouts) assert.match(step, /persist-credentials: false/);
});

test("the job that can write releases runs no npm dependency code", () => {
  const writers = jobs().filter((job) => /contents: write/.test(job.text));
  assert.deepEqual(writers.map((job) => job.name), ["release"]);
  assert.doesNotMatch(writers[0].text, /\bnpm\b|\bnpx\b/);
  assert.match(writers[0].text, /needs: check/);
});
