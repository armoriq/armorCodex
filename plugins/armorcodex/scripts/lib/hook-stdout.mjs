import { claimStdout } from "./stdio.mjs";

const writeStdout = claimStdout();

export function emitJson(value) {
  writeStdout(`${JSON.stringify(value)}\n`);
}
