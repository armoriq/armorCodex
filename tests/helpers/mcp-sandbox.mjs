import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const home = process.env.ARMORCODEX_TEST_HOME;
if (!home || os.homedir() !== home || !home.startsWith(os.tmpdir())) {
  process.stderr.write(`home ${os.homedir()} is not the sandbox\n`);
  process.exit(99);
}

const axios = createRequire(new URL("../../plugins/armorcodex/package.json", import.meta.url))("axios");
axios.defaults.adapter = async (config) => {
  fs.appendFileSync(
    path.join(home, "requests.jsonl"),
    `${JSON.stringify({ method: config.method, url: config.url, body: config.data ?? null })}\n`
  );
  return { status: 403, statusText: "Forbidden", headers: {}, config, data: { message: "sandbox" } };
};

const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init = {}) => {
  if (new URL(String(url)).hostname === "127.0.0.1") return realFetch(url, init);
  fs.appendFileSync(
    path.join(home, "requests.jsonl"),
    `${JSON.stringify({ method: init.method ?? "GET", url: String(url), body: init.body ?? null })}\n`
  );
  return new Response(JSON.stringify({ message: "sandbox" }), { status: 403, headers: { "content-type": "application/json" } });
};
