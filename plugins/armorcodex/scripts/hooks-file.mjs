import { installHooks, uninstallHooks } from "./lib/hooks-file.mjs";

const [mode, hooksPath, bootstrapPath] = process.argv.slice(2);

try {
  process.stdout.write(mode === "remove" ? uninstallHooks(hooksPath) : installHooks(hooksPath, bootstrapPath));
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
}
