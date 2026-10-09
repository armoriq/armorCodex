import { format } from "node:util";

const toStderr = (...args) => process.stderr.write(`${format(...args)}\n`);

export function routeConsoleToStderr() {
  for (const method of ["log", "info", "warn", "error", "debug", "trace"]) {
    console[method] = toStderr;
  }
}

export function claimStdout() {
  const write = process.stdout.write.bind(process.stdout);
  process.stdout.write = process.stderr.write.bind(process.stderr);
  return write;
}
