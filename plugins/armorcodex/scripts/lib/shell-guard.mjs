import { readdirSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

const EVERY_OPERAND = new Set(["rm", "tee", "truncate", "chmod", "chown", "touch", "unlink", "shred", "mkdir"]);
const INTO_DESTINATION = new Set(["cp", "install", "ln"]);
const WRITE_COMMANDS = new Set([...EVERY_OPERAND, ...INTO_DESTINATION, "mv", "sed", "dd"]);
const SEPARATOR = /^(&&|\|\||[;|&\n(){}])$/;
const KEYWORDS = new Set(["if", "then", "else", "elif", "do", "while", "until", "!"]);
const SHELLS = new Set(["sh", "bash", "zsh", "dash", "ksh"]);
const SUBSTITUTION = /\$\(([^()]*)\)|`([^`]*)`/g;
const MAX_DEPTH = 4;
const TARGETED = new Set([...WRITE_COMMANDS, "cd", "pushd"].filter((name) => name !== "sed" && name !== "dd"));
const READ_ONLY = new Set([
  "cat",
  "ls",
  "head",
  "tail",
  "grep",
  "egrep",
  "fgrep",
  "wc",
  "stat",
  "file",
  "jq",
  "diff",
  "cmp",
  "test",
  "[",
  "echo",
  "printf",
  "md5",
  "md5sum",
  "shasum",
  "sha256sum",
  "realpath",
  "readlink",
  "basename",
  "dirname",
  "du",
  "od",
  "hexdump",
  "strings",
  "cut",
  "tr",
  "nl",
  "pwd",
  "true",
  "false"
]);
const STATE_NAMES = [
  "policy.json",
  "runtime.json",
  "backend-posture.json",
  "crypto-policy-state.json",
  "policy-bundle.json",
  "policy-pending.json",
  "policy-profiles.json",
  "policy-shadow.jsonl",
  "monitor.jsonl",
  "usage-sync.log",
  "policy-holds",
  "policy-decisions",
  "tool-starts",
  "usage-live",
  "credentials.json"
];
const STATE_PATTERN = /^(pending-plan\..+\.json|obs-turn\..+\.ndjson)$/;
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
const EXPANSION = /\$(?!HOME\b|\{HOME\})[\w{(]|`/;
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
  setsid: {},
  caffeinate: { withValue: new Set(["-t", "-w"]) },
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
    while (/^\w+=/.test(argv[i] ?? "") || KEYWORDS.has(argv[i])) i++;
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
  if (command === "ln") {
    const { files, targetDir } = operands(args);
    return [...exact(destinations(args)), ...whole(targetDir ? files : files.slice(0, -1))];
  }
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
const expandHomeAll = (text) =>
  text.replace(/(^|[\s=:'"(])~(?=\/|$|[\s'")])/g, `$1${homedir()}`).replace(/\$HOME\b|\$\{HOME\}/g, homedir());

function stateNames(protectedPaths) {
  const names = new Set([...STATE_NAMES, ...protectedPaths.map((p) => path.basename(p))]);
  for (const dir of protectedPaths) {
    try {
      for (const entry of readdirSync(dir)) names.add(entry);
    } catch {}
  }
  return { has: (name) => names.has(name) || STATE_PATTERN.test(name) };
}

function containsPath(text, target) {
  for (let at = text.indexOf(target); at !== -1; at = text.indexOf(target, at + 1)) {
    if (!/[\w.-]/.test(text[at + target.length] ?? "")) return true;
  }
  return false;
}

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
      (p) =>
        p !== dir &&
        isUnder(p, dir) &&
        path.relative(dir, p).startsWith(head) &&
        (head !== "" || path.dirname(p) === dir)
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

function innerCommands(cmd, redirects) {
  const inner = [];
  for (const word of [...cmd, ...redirects]) {
    for (const match of word.matchAll(SUBSTITUTION)) inner.push(match[1] ?? match[2]);
  }
  if (path.basename(cmd[0] ?? "") === "eval") inner.push(cmd.slice(1).join(" "));
  if (SHELLS.has(path.basename(cmd[0] ?? ""))) {
    const flag = cmd.findIndex((arg, i) => i > 0 && /^-[a-zA-Z]*c[a-zA-Z]*$/.test(arg));
    if (flag !== -1 && typeof cmd[flag + 1] === "string") inner.push(cmd[flag + 1]);
  }
  return inner;
}

export function writesProtectedPath(command, cwd, protectedPaths, depth = 0, exactPaths = []) {
  const everyPath = [...protectedPaths, ...exactPaths];
  const resolvedProtected = everyPath.map((p) => realPath(path.resolve(p)));
  const basenames = stateNames(protectedPaths);
  const mentions = (word) => basenames.has(path.basename(word));
  const home = realPath(homedir());
  const literals = [...new Set([...resolvedProtected, ...everyPath.map((p) => path.resolve(p))])];
  const namesLiterally = (text) => literals.some((p) => containsPath(expandHomeAll(text), p));
  const fragments = resolvedProtected.filter((p) => p !== home && isUnder(p, home)).map((p) => path.relative(home, p));
  const names = (word, base) => {
    if (namesLiterally(word)) return true;
    const expanded = expandHome(word);
    if (SPECIAL.test(expanded)) return Boolean(patternHits(expanded, base, resolvedProtected, false)) || mentions(word);
    return expanded.split("=").some((part) => {
      const target = part && absoluteOf(part, base);
      return Boolean(target) && resolvedProtected.some(
        (p) => isUnder(target, p) || (isUnder(p, target) && target !== home && isUnder(target, home))
      );
    });
  };
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
  const commands = simpleCommands(tokens);
  const dynamic =
    EXPANSION.test(command) ||
    commands.some(({ argv }) => {
      const name = path.basename(unwrap(argv).argv[0] ?? "");
      return INTERPRETERS.has(name) || name === "eval";
    });
  if (dynamic && (namesLiterally(command) || fragments.some((f) => containsPath(command, f)))) return true;
  let base = cwd;
  for (const { argv, redirects } of commands) {
    const { argv: cmd, stdin } = unwrap(argv);
    const name = path.basename(cmd[0] ?? "");
    if (cmd[0] === "cd" || cmd[0] === "pushd") base = changeDir(cmd, base);
    if (stdin && !READ_ONLY.has(name) && words.some(mentions)) return true;
    if ([...exact(redirects), ...commandTargets(cmd)].some((w) => hits(w, base))) return true;
    if (cmd.length && !READ_ONLY.has(name) && !TARGETED.has(name) && cmd.some((w) => names(w, base))) return true;
    if (
      depth < MAX_DEPTH &&
      innerCommands(cmd, redirects).some((inner) => writesProtectedPath(inner, base, protectedPaths, depth + 1, exactPaths))
    )
      return true;
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
