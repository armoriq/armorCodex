import { createRequire } from "node:module";

// The SDK root eagerly loads axios and OpenTelemetry (~150 ms), and every hook
// is a fresh Node process. Load only the SDK module a caller uses, on first use.
const require = createRequire(import.meta.url);
const loaded = new Map();

function load(name) {
  try {
    return require(`@armoriq/sdk-dev/dist/${name}`);
  } catch (err) {
    // An SDK laid out differently still serves these exports from its root. One
    // behind an exports map does not: config.mjs deep-requires dist/_build_env.js,
    // which the root does not export, so that SDK fails at import anyway.
    if (err?.code !== "MODULE_NOT_FOUND") throw err;
    process.stderr.write(`[armorcodex] SDK module ${name} not found by name, loading the SDK root\n`);
    return require("@armoriq/sdk-dev");
  }
}

export function sdkModule(name) {
  if (!loaded.has(name)) loaded.set(name, load(name));
  return loaded.get(name);
}
