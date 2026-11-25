import { chmodSync, existsSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";

export function routerCommand(bootstrapPath) {
  return `node ${bootstrapPath} router`;
}

export function hookGroups(command) {
  const hook = (extra) => ({ type: "command", command, ...extra });
  return {
    SessionStart: { matcher: "startup|resume", hooks: [hook({ statusMessage: "Starting ArmorCodex" })] },
    UserPromptSubmit: { hooks: [hook({ statusMessage: "Loading ArmorCodex intent policy" })] },
    PreToolUse: { matcher: "*", hooks: [hook({ statusMessage: "Checking ArmorCodex policy" })] },
    PermissionRequest: { matcher: "*", hooks: [hook({ statusMessage: "Checking ArmorCodex approval policy" })] },
    PostToolUse: { matcher: "*", hooks: [hook({ statusMessage: "Auditing ArmorCodex command" })] },
    PostToolUseFailure: { matcher: "*", hooks: [hook({ statusMessage: "Auditing failed ArmorCodex command" })] },
    Stop: { hooks: [hook({ timeout: 30 })] },
    SessionEnd: { hooks: [hook({ timeout: 3 })] }
  };
}

export function isOurEntry(entry) {
  return (
    entry?.type === "command" &&
    typeof entry.command === "string" &&
    entry.command.endsWith("bootstrap.mjs router") &&
    /armorcodex/i.test(`${entry.command} ${entry.statusMessage ?? ""}`)
  );
}

function hasOurs(group) {
  return Array.isArray(group?.hooks) && group.hooks.some(isOurEntry);
}

export function parseHooksText(text) {
  const config = JSON.parse(text);
  const layout = {
    indent: text.match(/^([ \t]+)\S/m)?.[1] ?? (text.trim().includes("\n") ? 2 : 0),
    newline: text.endsWith("\n") ? "\n" : ""
  };
  if (!config || typeof config !== "object" || Array.isArray(config)) throw new Error("hooks.json must be an object");
  if (!config.hooks || typeof config.hooks !== "object" || Array.isArray(config.hooks)) {
    throw new Error("top-level hooks must be an object");
  }
  for (const [event, groups] of Object.entries(config.hooks)) {
    if (!Array.isArray(groups)) throw new Error(`hooks.${event} must be an array`);
  }
  return { config, layout };
}

export function serializeHooks(config, layout = { indent: 2, newline: "\n" }) {
  return `${JSON.stringify(config, null, layout.indent)}${layout.newline}`;
}

export function addMissingHooks(hooks, command) {
  const groups = hookGroups(command);
  const added = Object.keys(groups).filter((event) => !(hooks[event] ?? []).some(hasOurs));
  for (const event of added) hooks[event] = [...(hooks[event] ?? []), groups[event]];
  return added;
}

export function refreshOurHooks(hooks, { onlyCommand } = {}) {
  const refreshed = [];
  for (const [event, canonicalGroup] of Object.entries(hookGroups(""))) {
    const [canonical] = canonicalGroup.hooks;
    for (const group of hooks[event] ?? []) {
      if (!hasOurs(group)) continue;
      group.hooks = group.hooks.map((entry) => {
        if (!isOurEntry(entry)) return entry;
        if (onlyCommand !== undefined && entry.command !== onlyCommand) return entry;
        const wanted = { ...canonical, command: entry.command };
        if (JSON.stringify(entry) === JSON.stringify(wanted)) return entry;
        if (!refreshed.includes(event)) refreshed.push(event);
        return wanted;
      });
    }
  }
  return refreshed;
}

export function removeOurHooks(hooks) {
  let removed = 0;
  for (const [event, groups] of Object.entries(hooks)) {
    const kept = groups
      .map((group) => (hasOurs(group) ? { ...group, hooks: group.hooks.filter((entry) => !isOurEntry(entry)) } : group))
      .filter((group) => !Array.isArray(group?.hooks) || group.hooks.length > 0);
    removed += groups.filter(hasOurs).length;
    if (kept.length > 0) hooks[event] = kept;
    else delete hooks[event];
  }
  return removed;
}

export function writeHooksText(hooksPath, text) {
  const tempPath = `${hooksPath}.armorcodex.tmp-${process.pid}`;
  const existed = existsSync(hooksPath);
  try {
    writeFileSync(tempPath, text, { flag: "wx" });
    if (existed) chmodSync(tempPath, statSync(hooksPath).mode & 0o7777);
    renameSync(tempPath, hooksPath);
  } catch (error) {
    rmSync(tempPath, { force: true });
    throw error;
  }
}

export function installHooks(hooksPath, bootstrapPath) {
  const existed = existsSync(hooksPath);
  const { config, layout } = existed
    ? parseHooksText(readFileSync(hooksPath, "utf8"))
    : { config: { hooks: {} }, layout: { indent: 2, newline: "\n" } };
  const refreshed = refreshOurHooks(config.hooks);
  const added = addMissingHooks(config.hooks, routerCommand(bootstrapPath));
  if (added.length === 0 && refreshed.length === 0) return "present";
  writeHooksText(hooksPath, serializeHooks(config, layout));
  if (!existed) return "created";
  return `repaired:${added.join(", ")}|${refreshed.join(", ")}`;
}

export function uninstallHooks(hooksPath) {
  if (!existsSync(hooksPath)) return "absent";
  const { config, layout } = parseHooksText(readFileSync(hooksPath, "utf8"));
  if (removeOurHooks(config.hooks) === 0) return "absent";
  if (Object.keys(config.hooks).length === 0 && Object.keys(config).length === 1) {
    rmSync(hooksPath, { force: true });
    return "removed";
  }
  writeHooksText(hooksPath, serializeHooks(config, layout));
  return "stripped";
}
