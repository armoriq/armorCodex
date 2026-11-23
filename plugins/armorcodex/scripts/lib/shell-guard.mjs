import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

const EVERY_OPERAND = new Set(["rm", "tee", "truncate", "chmod", "chown"]);
const INTO_DESTINATION = new Set(["cp", "install", "ln"]);
const WRITE_COMMANDS = new Set([...EVERY_OPERAND, ...INTO_DESTINATION, "mv", "sed", "dd"]);
const SEPARATOR = /^(&&|\|\||[;|&\n(){}])$/;
const POLICY_ADMIN =
  /armor-policy-commands|handleArmorPolicyCommand|applyPolicyCommand|persistNextState|stageAndFormat|policy-pending|crypto-policy-state/i;
const INTERPRETERS = new Set([
  "node",
  "nodejs",
  "bun",
  "deno",
  "tsx",
  "ts-node",
  "npx",
  "sh",
  "bash",
  "zsh",
  "dash",
  "ksh",
  "fish",
  "source",
  ".",
  "eval",
  "python",
  "python3",
  "perl",
  "ruby",
]);
const TOKEN =
  /[ \t]*(?:(&&|\|\||&>>?|\d*>&(?:\d+|-)|\d*>>?\|?|\d*<<<|\d*<<-?|\d*<&(?:\d+|-)|\d*<>?|[;|&\n(){}])|((?:\$\{[^}]*\}|\$\([^)]*\)|`[^`]*`|"(?:\\.|[^"\\])*"|'[^']*'|\\[^]|[^\s"'`\\;&|<>(){}$]|\$)+))/y;

const WRAPPERS = {
  sudo: { withValue: new Set(["-u", "-g", "-C", "-D", "-h", "-p", "-r", "-t", "-U"]) },
  doas: { withValue: new Set(["-u", "-C"]) },
  env: { withValue: new Set(["-u", "-C", "-S"]) },
  nice: { withValue: new Set(["-n"]) },
  exec: { withValue: new Set(["-a"]) },
  timeout: { withValue: new Set(["-s", "-k"]), positional: 1 },
  xargs: { withValue: new Set(["-I", "-n", "-P", "-L", "-d", "-E", "-s", "-a"]), stdin: true },
  nohup: {},
  command: {},
  builtin: {},
  time: {},
  stdbuf: {},
};

const unquote = (raw) =>
  raw.replace(
    /\\([^])|"((?:\\.|[^"\\])*)"|'([^']*)'/g,
    (_, escaped, dq, sq) => escaped ?? dq?.replace(/\\(.)/g, "$1") ?? sq
  );

function lex(command) {
  const text = command.replace(/[ \t]+$/, "");
  const tokens = [];
  TOKEN.lastIndex = 0;
  while (TOKEN.lastIndex < text.length) {
    const m = TOKEN.exec(text);
    if (!m) return null;
    tokens.push(m[1] !== undefined ? { op: m[1] } : { word: unquote(m[2]) });
  }
  return tokens;
}

function simpleCommands(tokens) {
  const commands = [{ argv: [], redirects: [] }];
  for (let i = 0; i < tokens.length; i++) {
    const { op, word } = tokens[i];
    const current = commands.at(-1);
    if (word !== undefined) current.argv.push(word);
    else if (SEPARATOR.test(op)) commands.push({ argv: [], redirects: [] });
    else if (!/&(\d|-)/.test(op) && tokens[i + 1]?.word !== undefined) {
      i++;
      if (op.includes(">")) current.redirects.push(tokens[i].word);
    }
  }
  return commands;
}

function unwrap(argv) {
  let i = 0;
  let stdin = false;
  for (;;) {
    while (/^\w+=/.test(argv[i] ?? "")) i++;
    const spec = WRAPPERS[path.basename(argv[i] ?? "")];
    if (!spec) return { argv: argv.slice(i), stdin };
    stdin ||= Boolean(spec.stdin);
    i++;
    while (argv[i]?.startsWith("-")) i += spec.withValue?.has(argv[i]) ? 2 : 1;
    i += spec.positional ?? 0;
  }
}

function operands(args) {
  const files = [];
  let targetDir;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "-t" || args[i] === "--target-directory") targetDir = args[++i];
    else if (args[i].startsWith("--target-directory=")) targetDir = args[i].slice(19);
    else if (!args[i].startsWith("-")) files.push(args[i]);
  }
  return { files, targetDir };
}

function destinations(args) {
  const { files, targetDir } = operands(args);
  const dest = targetDir ?? files.at(-1);
  if (!dest) return [];
  const sources = targetDir ? files : files.slice(0, -1);
  return [dest, ...sources.map((s) => path.join(dest, path.basename(s)))];
}

const RECURSIVE = /^(-[a-zA-Z]*R|--recursive$)/;
const whole = (words) => words.map((word) => ({ word, whole: true }));
const exact = (words) => words.map((word) => ({ word, whole: false }));

function commandTargets([name, ...args]) {
  const command = path.basename(name ?? "");
  if (command === "mv") {
    const { files, targetDir } = operands(args);
    return [...whole(targetDir ? files : files.slice(0, -1)), ...exact(destinations(args))];
  }
  if (command === "rm") return whole(operands(args).files);
  if ((command === "chmod" || command === "chown") && args.some((a) => RECURSIVE.test(a)))
    return whole(operands(args).files);
  if (EVERY_OPERAND.has(command)) return exact(operands(args).files);
  if (INTO_DESTINATION.has(command)) return exact(destinations(args));
  if (command === "sed" && args.some((a) => /^(-i|--in-place)/.test(a)))
    return exact(operands(args).files);
  if (command === "dd")
    return exact(args.filter((a) => a.startsWith("of=")).map((a) => a.slice(3)));
  return [];
}

const expandHome = (word) => word.replace(/^(~|\$HOME|\$\{HOME\})(?=\/|$)/, homedir());
const SPECIAL = /[$`*?[]/;

function realPath(target) {
  const tail = [];
  let current = target;
  for (;;) {
    try {
      return path.join(realpathSync(current), ...tail);
    } catch {
      const parent = path.dirname(current);
      if (parent === current) return target;
      tail.unshift(path.basename(current));
      current = parent;
    }
  }
}

function absoluteOf(word, base) {
  if (path.isAbsolute(word)) return realPath(path.resolve(word));
  return base ? realPath(path.resolve(base, word)) : null;
}

function resolveWord(word, base) {
  const expanded = expandHome(word);
  return SPECIAL.test(expanded) ? null : absoluteOf(expanded, base);
}

function globRegex(pattern) {
  let source = "";
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    const close = c === "[" ? pattern.indexOf("]", i + 2) : -1;
    if (pattern[i - 1] === "/" && (c === "*" || c === "?" || close !== -1)) source += "(?!\\.)";
    if (c === "*") source += "[^/]*";
    else if (c === "?") source += "[^/]";
    else if (close !== -1) {
      source += `[${pattern
        .slice(i + 1, close)
        .replace(/^!/, "^")
        .replace(/\\/g, "\\\\")}]`;
      i = close;
    } else source += c.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${source}$`);
}

function lineage(target) {
  const chain = [target];
  while (path.dirname(chain.at(-1)) !== chain.at(-1)) chain.push(path.dirname(chain.at(-1)));
  return chain;
}

function patternHits(expanded, base, resolvedProtected, wholeTree) {
  const special = expanded.search(SPECIAL);
  const slash = expanded.lastIndexOf("/", special);
  const dir = absoluteOf(slash === -1 ? "." : expanded.slice(0, slash + 1) || "/", base);
  if (!dir) return null;
  if (resolvedProtected.some((p) => isUnder(dir, p))) return true;
  if (/[$`]/.test(expanded)) {
    const head = expanded.slice(slash + 1, special);
    return resolvedProtected.some(
      (p) => p !== dir && isUnder(p, dir) && path.relative(dir, p).startsWith(head)
    );
  }
  const regex = globRegex(path.join(dir, expanded.slice(slash + 1)));
  return resolvedProtected.some((p) => (wholeTree ? lineage(p) : [p]).some((c) => regex.test(c)));
}

function changeDir([, ...args], base) {
  const dir = args.find((a) => !/^-[LPe@]+$/.test(a));
  if (dir === undefined) return homedir();
  return /^[-+]/.test(dir) ? null : resolveWord(dir, base);
}

const wordsOf = (tokens) => tokens.flatMap((t) => (t.word === undefined ? [] : [t.word]));

const isUnder = (target, protectedPath) =>
  target === protectedPath ||
  target.startsWith(protectedPath.endsWith(path.sep) ? protectedPath : protectedPath + path.sep);

export const isProtectedPath = (target, protectedPaths) =>
  protectedPaths.some((p) => isUnder(realPath(path.resolve(target)), realPath(path.resolve(p))));

export function writesProtectedPath(command, cwd, protectedPaths) {
  const resolvedProtected = protectedPaths.map((p) => realPath(path.resolve(p)));
  const basenames = new Set(protectedPaths.map((p) => path.basename(p)));
  const mentions = (word) => basenames.has(path.basename(word));
  const hits = ({ word, whole }, base) => {
    const expanded = expandHome(word);
    if (SPECIAL.test(expanded))
      return patternHits(expanded, base, resolvedProtected, whole) || mentions(word);
    const target = absoluteOf(expanded, base);
    if (!target) return mentions(word);
    return resolvedProtected.some((p) => isUnder(target, p) || (whole && isUnder(p, target)));
  };
  const tokens = lex(command);
  if (!tokens) return command.split(/[\s"'=<>]+/).some(mentions);
  const words = wordsOf(tokens);
  let base = cwd;
  for (const { argv, redirects } of simpleCommands(tokens)) {
    const { argv: cmd, stdin } = unwrap(argv);
    if (cmd[0] === "cd" || cmd[0] === "pushd") base = changeDir(cmd, base);
    if (stdin && WRITE_COMMANDS.has(path.basename(cmd[0] ?? "")) && words.some(mentions))
      return true;
    if ([...exact(redirects), ...commandTargets(cmd)].some((w) => hits(w, base))) return true;
  }
  return false;
}

export function invokesPolicyAdmin(command) {
  const tokens = lex(command);
  if (!tokens) return POLICY_ADMIN.test(command);
  if (!wordsOf(tokens).some((w) => POLICY_ADMIN.test(w))) return false;
  return simpleCommands(tokens).some(({ argv }) => {
    const name = path.basename(unwrap(argv).argv[0] ?? "");
    return INTERPRETERS.has(name) || POLICY_ADMIN.test(name);
  });
}
