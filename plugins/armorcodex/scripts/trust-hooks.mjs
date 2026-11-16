import { trustArmorCodexHooks } from "./lib/hook-trust.mjs";

const [hooksFile, bootstrapPath] = process.argv.slice(2);

try {
  const result = await trustArmorCodexHooks({ hooksFile, bootstrapPath });
  process.stdout.write(`${JSON.stringify(result)}\n`);
  process.exit(result.total > 0 && result.untrusted.length === 0 ? 0 : 1);
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
}
