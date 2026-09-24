/**
 * Adapted from Hermes Agent (MIT) — see NOTICE.md (normalization and command-position ideas).
 *
 * A small, conservative shell parser for safety analysis. It never executes or expands anything.
 * It splits a command line into simple commands (following pipelines, lists, subshells, command
 * and process substitutions, `bash -c` payloads, `eval`, `xargs`, `find -exec` and heredocs fed to
 * shells), strips wrappers such as `sudo`/`env`/`nohup`, and tracks the working directory through
 * `cd` so relative paths can be placed inside or outside the task workspace. Whatever it cannot
 * follow is reported in `error` or marked `dynamic`, never guessed.
 */
import { type Cwd, initialCwd, resolvePath } from "./paths";

export const MAX_SHELL_COMMAND_CHARS = 64_000;
const MAX_DEPTH = 6;
const MAX_COMMANDS = 400;

export interface ShellRedirect {
  op: string;
  fd?: number;
  target: string;
  dynamic: boolean;
}

/** How a command came to run. Anything but `top` is nested inside another command. */
export type ShellVia =
  | "top"
  | "substitution"
  | "process-substitution"
  | "shell-c"
  | "eval"
  | "heredoc"
  | "find-exec";

export interface ShellCommand {
  /** Words after assignments and wrappers, quotes removed. Unresolved expansions stay as written. */
  argv: string[];
  /** Parallel to `argv`: the word contains an expansion we cannot resolve statically. */
  dynamicArgs: boolean[];
  /** Lowercased basename of `argv[0]` (`""` for redirect-only commands such as `> file`). */
  name: string;
  wrappers: string[];
  sudo: boolean;
  /** `sudo -S`: the password is piped in on stdin. */
  sudoStdin: boolean;
  assignments: string[];
  /** Variables referenced anywhere in the command (`$HOME` excluded). */
  vars: string[];
  redirects: ShellRedirect[];
  /** Heredoc / here-string content fed to the command's stdin. */
  stdinText?: string;
  /** Arguments come from stdin at runtime (`xargs`) or a `find -exec` placeholder. */
  argsFromStdin: boolean;
  pipeline: number;
  position: number;
  pipelineLength: number;
  via: ShellVia;
  /** The command whose arguments or payload contain this one. */
  parent?: ShellCommand;
  cwd: Cwd;
  depth: number;
}

export interface ShellAnalysis {
  /** Normalized source text. */
  source: string;
  commands: ShellCommand[];
  /** Set when (part of) the command could not be parsed; callers must not treat it as understood. */
  error?: string;
}

export const SHELL_NAMES: ReadonlySet<string> = new Set([
  "bash",
  "sh",
  "zsh",
  "dash",
  "ksh",
  "fish",
  "ash",
  "mksh",
  "tcsh",
  "csh",
]);

// ── Lexer ───────────────────────────────────────────────────────────────────

interface SubSource {
  kind: "substitution" | "process-substitution";
  source: string;
}

interface WordToken {
  type: "word";
  text: string;
  dynamic: boolean;
  quoted: boolean;
  vars: string[];
  subs: SubSource[];
}

interface HeredocRef {
  delimiter: string;
  stripTabs: boolean;
  body: string;
}

type Token =
  | WordToken
  | { type: "op"; op: string }
  | { type: "redir"; op: string; fd?: number; heredoc?: HeredocRef };

class ShellSyntaxError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ShellSyntaxError";
  }
}

function findBacktickEnd(src: string, start: number): number {
  for (let i = start + 1; i < src.length; i++) {
    if (src[i] === "\\") i++;
    else if (src[i] === "`") return i;
  }
  throw new ShellSyntaxError("unterminated backquote");
}

function skipDoubleQuoted(src: string, start: number): number {
  for (let i = start + 1; i < src.length; i++) {
    const c = src[i];
    if (c === "\\") i++;
    else if (c === '"') return i;
    else if (c === "$" && src[i + 1] === "(") i = findClose(src, i + 1, "(", ")");
    else if (c === "`") i = findBacktickEnd(src, i);
  }
  throw new ShellSyntaxError("unterminated double quote");
}

/** Index of the bracket closing the one at `openIdx`, skipping quoted text. */
function findClose(src: string, openIdx: number, open: string, close: string): number {
  let depth = 0;
  for (let i = openIdx; i < src.length; i++) {
    const c = src[i];
    if (c === "\\") {
      i++;
    } else if (c === "'") {
      const end = src.indexOf("'", i + 1);
      if (end === -1) break;
      i = end;
    } else if (c === '"') {
      i = skipDoubleQuoted(src, i);
    } else if (c === "`") {
      i = findBacktickEnd(src, i);
    } else if (c === open) {
      depth++;
    } else if (c === close && --depth === 0) {
      return i;
    }
  }
  throw new ShellSyntaxError(`unbalanced ${open}${close}`);
}

const ANSI_C_ESCAPES: ReadonlyMap<string, string> = new Map([
  ["n", "\n"],
  ["t", "\t"],
  ["r", "\r"],
  ["\\", "\\"],
  ["'", "'"],
  ['"', '"'],
]);

function readAnsiC(src: string, start: number): { value: string; end: number } {
  let out = "";
  for (let i = start; i < src.length; i++) {
    const c = src[i]!;
    if (c === "'") return { value: out, end: i };
    if (c !== "\\") {
      out += c;
      continue;
    }
    const e = src[++i];
    if (e === undefined) break;
    const mapped = ANSI_C_ESCAPES.get(e);
    if (mapped !== undefined) {
      out += mapped;
    } else if (e === "x" || e === "u" || e === "U") {
      const max = e === "x" ? 2 : e === "u" ? 4 : 8;
      const hex = /^[0-9a-fA-F]+/.exec(src.slice(i + 1, i + 1 + max))?.[0] ?? "";
      const code = Number.parseInt(hex, 16);
      if (hex && code <= 0x10ffff) out += String.fromCodePoint(code);
      i += hex.length;
    } else if (/[0-7]/.test(e)) {
      const oct = /^[0-7]{1,3}/.exec(src.slice(i))?.[0] ?? e;
      out += String.fromCharCode(Number.parseInt(oct, 8));
      i += oct.length - 1;
    }
  }
  throw new ShellSyntaxError("unterminated $'…' string");
}

class Lexer {
  private readonly src: string;
  private i = 0;
  private word: WordToken | null = null;
  private readonly tokens: Token[] = [];
  private readonly pendingHeredocs: HeredocRef[] = [];

  constructor(src: string) {
    this.src = src;
  }

  run(): { tokens: Token[]; error?: string } {
    try {
      while (this.i < this.src.length) this.step();
      this.flush();
      return { tokens: this.tokens };
    } catch (error) {
      this.flush();
      return {
        tokens: this.tokens,
        error: error instanceof ShellSyntaxError ? error.message : "unparseable command",
      };
    }
  }

  private current(): WordToken {
    this.word ??= { type: "word", text: "", dynamic: false, quoted: false, vars: [], subs: [] };
    return this.word;
  }

  private flush(): void {
    if (this.word) this.tokens.push(this.word);
    this.word = null;
  }

  private op(op: string, width: number): void {
    this.flush();
    this.tokens.push({ type: "op", op });
    this.i += width;
  }

  private step(): void {
    const src = this.src;
    const c = src[this.i]!;
    const next = src[this.i + 1];
    switch (c) {
      case " ":
      case "\t":
      case "\r":
        this.flush();
        this.i++;
        return;
      case "\n":
        this.op("\n", 1);
        this.readHeredocBodies();
        return;
      case "\\":
        if (next !== "\n" && next !== undefined) {
          const w = this.current();
          w.text += next;
          w.quoted = true;
        }
        this.i += 2;
        return;
      case "#":
        if (this.word) break;
        while (this.i < src.length && src[this.i] !== "\n") this.i++;
        return;
      case ";":
        this.op(next === ";" ? ";;" : ";", next === ";" ? 2 : 1);
        return;
      case "&":
        if (next === "&") this.op("&&", 2);
        else if (next === ">") this.redirect(">", "&");
        else this.op("&", 1);
        return;
      case "|":
        if (next === "|") this.op("||", 2);
        else this.op(next === "&" ? "|&" : "|", next === "&" ? 2 : 1);
        return;
      case "(":
        this.openParen();
        return;
      case ")":
        this.op(")", 1);
        return;
      case "<":
      case ">":
        this.redirect(c);
        return;
      case "'": {
        const end = src.indexOf("'", this.i + 1);
        if (end === -1) throw new ShellSyntaxError("unterminated single quote");
        const w = this.current();
        w.text += src.slice(this.i + 1, end);
        w.quoted = true;
        this.i = end + 1;
        return;
      }
      case '"':
        this.i++;
        this.doubleQuoted();
        return;
      case "`":
        this.backtick();
        return;
      case "$":
        this.dollar(false);
        return;
    }
    this.current().text += c;
    this.i++;
  }

  private openParen(): void {
    const w = this.word;
    if (w && !w.quoted && /^[A-Za-z_]\w*(?:\[[^\]]*\])?\+?=$/.test(w.text)) {
      const end = findClose(this.src, this.i, "(", ")");
      w.text += this.src.slice(this.i, end + 1);
      this.i = end + 1;
      return;
    }
    if (w && this.src[this.i + 1] === ")") {
      // `name()`: a function definition; its body is analyzed like any other commands.
      this.word = null;
      this.i += 2;
      this.tokens.push({ type: "op", op: "\n" });
      return;
    }
    if (w) {
      const end = findClose(this.src, this.i, "(", ")");
      w.text += this.src.slice(this.i, end + 1);
      w.dynamic = true;
      this.i = end + 1;
      return;
    }
    this.op("(", 1);
  }

  private redirect(c: "<" | ">", prefix = ""): void {
    const src = this.src;
    if (!prefix && src[this.i + 1] === "(") {
      const end = findClose(src, this.i + 1, "(", ")");
      const w = this.current();
      w.subs.push({ kind: "process-substitution", source: src.slice(this.i + 2, end) });
      w.text += "/dev/fd/63";
      w.dynamic = true;
      this.i = end + 1;
      return;
    }
    let fd: number | undefined;
    const w = this.word;
    if (!prefix && w && !w.quoted && w.subs.length === 0 && /^\d{1,2}$/.test(w.text)) {
      fd = Number(w.text);
      this.word = null;
    } else {
      this.flush();
    }
    if (prefix) this.i += prefix.length;
    const rest = src.slice(this.i, this.i + 3);
    const ops = c === ">" ? [">>", ">&", ">|", ">"] : ["<<<", "<<-", "<<", "<&", "<>", "<"];
    const op = ops.find((o) => rest.startsWith(o)) ?? c;
    this.i += op.length;
    const fullOp = prefix + op;
    if (op === "<<" || op === "<<-") {
      const heredoc: HeredocRef = {
        delimiter: this.readDelimiter(),
        stripTabs: op === "<<-",
        body: "",
      };
      this.pendingHeredocs.push(heredoc);
      this.tokens.push({ type: "redir", op: fullOp, ...(fd === undefined ? {} : { fd }), heredoc });
      return;
    }
    this.tokens.push({ type: "redir", op: fullOp, ...(fd === undefined ? {} : { fd }) });
  }

  private readDelimiter(): string {
    const src = this.src;
    while (src[this.i] === " " || src[this.i] === "\t") this.i++;
    let out = "";
    while (this.i < src.length) {
      const c = src[this.i]!;
      if (/[\s;|&<>()]/.test(c)) break;
      if (c === "'" || c === '"') {
        const end = src.indexOf(c, this.i + 1);
        if (end === -1) throw new ShellSyntaxError("unterminated heredoc delimiter");
        out += src.slice(this.i + 1, end);
        this.i = end + 1;
      } else if (c === "\\") {
        out += src[this.i + 1] ?? "";
        this.i += 2;
      } else {
        out += c;
        this.i++;
      }
    }
    return out;
  }

  /** Called right after a newline: consumes the bodies of heredocs opened on the previous line. */
  private readHeredocBodies(): void {
    const src = this.src;
    for (
      let heredoc = this.pendingHeredocs.shift();
      heredoc;
      heredoc = this.pendingHeredocs.shift()
    ) {
      const lines: string[] = [];
      while (this.i < src.length) {
        let end = src.indexOf("\n", this.i);
        if (end === -1) end = src.length;
        const line = src.slice(this.i, end);
        this.i = Math.min(end + 1, src.length);
        const candidate = heredoc.stripTabs ? line.replace(/^\t+/, "") : line;
        if (candidate === heredoc.delimiter) break;
        lines.push(candidate);
      }
      heredoc.body = lines.join("\n");
    }
  }

  private doubleQuoted(): void {
    const src = this.src;
    const w = this.current();
    w.quoted = true;
    while (this.i < src.length) {
      const c = src[this.i]!;
      if (c === '"') {
        this.i++;
        return;
      }
      if (c === "\\") {
        const next = src[this.i + 1];
        if (next === "\n") this.i += 2;
        else if (next === '"' || next === "\\" || next === "$" || next === "`") {
          w.text += next;
          this.i += 2;
        } else {
          w.text += "\\";
          this.i++;
        }
      } else if (c === "$") {
        this.dollar(true);
      } else if (c === "`") {
        this.backtick();
      } else {
        w.text += c;
        this.i++;
      }
    }
    throw new ShellSyntaxError("unterminated double quote");
  }

  private backtick(): void {
    const end = findBacktickEnd(this.src, this.i);
    const inner = this.src.slice(this.i + 1, end).replace(/\\([`\\$])/g, "$1");
    const w = this.current();
    w.subs.push({ kind: "substitution", source: inner });
    w.text += "$(…)";
    w.dynamic = true;
    this.i = end + 1;
  }

  private dollar(inDouble: boolean): void {
    const src = this.src;
    const w = this.current();
    const atStart = w.text === "" && w.subs.length === 0;
    const next = src[this.i + 1];
    // Placeholders left by an outer parse (payloads of `bash -c "…"` / `eval`) stay opaque.
    for (const placeholder of ["$((…))", "$(…)"]) {
      if (src.startsWith(placeholder, this.i)) {
        w.text += placeholder;
        w.dynamic = true;
        this.i += placeholder.length;
        return;
      }
    }
    if (next === "(") {
      const end = findClose(src, this.i + 1, "(", ")");
      if (src[this.i + 2] === "(") {
        w.text += "$((…))";
        collectSubstitutions(src.slice(this.i + 3, end - 1), w);
      } else {
        w.subs.push({ kind: "substitution", source: src.slice(this.i + 2, end) });
        w.text += "$(…)";
      }
      w.dynamic = true;
      this.i = end + 1;
      return;
    }
    if (next === "{") {
      const end = findClose(src, this.i + 1, "{", "}");
      const inner = src.slice(this.i + 2, end);
      this.variable(
        w,
        inner,
        /^[#!]?([A-Za-z_]\w*|[0-9@*#?$!-])/.exec(inner)?.[1] ?? "",
        atStart,
        `\${${inner}}`,
      );
      collectSubstitutions(inner, w);
      this.i = end + 1;
      return;
    }
    if (!inDouble && next === "'") {
      const { value, end } = readAnsiC(src, this.i + 2);
      w.text += value;
      w.quoted = true;
      this.i = end + 1;
      return;
    }
    if (!inDouble && next === '"') {
      this.i += 2;
      this.doubleQuoted();
      return;
    }
    if (next !== undefined && /[A-Za-z_]/.test(next)) {
      let j = this.i + 1;
      while (j < src.length && /\w/.test(src[j]!)) j++;
      const name = src.slice(this.i + 1, j);
      this.variable(w, name, name, atStart, `$${name}`);
      this.i = j;
      return;
    }
    if (next !== undefined && /[0-9@*#?$!-]/.test(next)) {
      w.text += `$${next}`;
      w.dynamic = true;
      this.i += 2;
      return;
    }
    w.text += "$";
    this.i++;
  }

  private variable(
    w: WordToken,
    expr: string,
    name: string,
    atStart: boolean,
    spelled: string,
  ): void {
    if (atStart && expr === "HOME") w.text += "~";
    else if (atStart && expr === "PWD") w.text += ".";
    else {
      w.text += spelled;
      w.dynamic = true;
      if (name) w.vars.push(name);
    }
  }
}

function collectSubstitutions(text: string, w: WordToken): void {
  for (let k = text.indexOf("$("); k !== -1; k = text.indexOf("$(", k + 2)) {
    try {
      const end = findClose(text, k + 1, "(", ")");
      w.subs.push({ kind: "substitution", source: text.slice(k + 2, end) });
      k = end;
    } catch {
      w.dynamic = true;
      return;
    }
  }
}

// ── Parser ──────────────────────────────────────────────────────────────────

const RESERVED_PREFIXES: ReadonlySet<string> = new Set([
  "if",
  "then",
  "else",
  "elif",
  "fi",
  "do",
  "done",
  "while",
  "until",
  "!",
  "{",
  "}",
  "esac",
  "coproc",
]);
const CONTROL_HEADERS: ReadonlySet<string> = new Set(["for", "select", "case", "function"]);

const WRAPPER_OPTIONS_WITH_VALUE: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  [
    "sudo",
    new Set([
      "-u",
      "-g",
      "-h",
      "-p",
      "-C",
      "-D",
      "-r",
      "-t",
      "-U",
      "-T",
      "--user",
      "--group",
      "--host",
      "--prompt",
      "--close-from",
      "--chdir",
      "--role",
      "--type",
      "--other-user",
      "--command-timeout",
    ]),
  ],
  ["doas", new Set(["-u", "-C"])],
  ["env", new Set(["-u", "--unset", "-C", "--chdir", "-S", "--split-string", "-P"])],
  ["nice", new Set(["-n", "--adjustment"])],
  ["timeout", new Set(["-s", "--signal", "-k", "--kill-after"])],
  ["gtimeout", new Set(["-s", "--signal", "-k", "--kill-after"])],
  [
    "xargs",
    new Set([
      "-I",
      "-n",
      "-P",
      "-L",
      "-d",
      "-E",
      "-s",
      "-a",
      "--max-args",
      "--max-procs",
      "--delimiter",
      "--arg-file",
      "--replace",
      "--max-lines",
    ]),
  ],
  ["stdbuf", new Set(["-i", "-o", "-e"])],
  ["ionice", new Set(["-c", "-n", "-p"])],
  ["watch", new Set(["-n", "--interval"])],
  ["strace", new Set(["-o", "-e", "-p", "-s", "-u"])],
  ["ltrace", new Set(["-o", "-e", "-p", "-s", "-u"])],
  ["exec", new Set(["-a"])],
  ["caffeinate", new Set(["-t", "-w"])],
  ["chroot", new Set(["--userspec", "--groups"])],
]);

const WRAPPERS: ReadonlySet<string> = new Set([
  "sudo",
  "doas",
  "env",
  "nohup",
  "time",
  "nice",
  "timeout",
  "gtimeout",
  "exec",
  "command",
  "builtin",
  "stdbuf",
  "caffeinate",
  "unbuffer",
  "setsid",
  "xargs",
  "watch",
  "strace",
  "ltrace",
  "ionice",
  "taskset",
  "chrt",
  "chroot",
  "arch",
  "busybox",
]);
/** Wrappers followed by one positional operand before the wrapped command. */
const WRAPPER_POSITIONAL: ReadonlyMap<string, number> = new Map([
  ["timeout", 1],
  ["gtimeout", 1],
  ["taskset", 1],
  ["chrt", 1],
  ["chroot", 1],
]);

interface Frame {
  cwd: Cwd;
  depth: number;
  via: ShellVia;
  parent?: ShellCommand;
  argsFromStdin?: boolean;
}

interface PartialCommand {
  words: WordToken[];
  redirects: Array<{ op: string; fd?: number; target?: WordToken; heredoc?: HeredocRef }>;
}

function basename(word: string): string {
  const slash = word.lastIndexOf("/");
  return (slash === -1 ? word : word.slice(slash + 1)).toLowerCase();
}

function isAssignment(word: WordToken): boolean {
  return /^[A-Za-z_]\w*(?:\[[^\]]*\])?\+?=/.test(word.text) && !/^['"]/.test(word.text);
}

class Parser {
  readonly commands: ShellCommand[] = [];
  error: string | undefined;
  private nextPipeline = 0;
  private readonly workspaceDir: string | undefined;

  constructor(workspaceDir: string | undefined) {
    this.workspaceDir = workspaceDir;
  }

  fail(message: string): void {
    this.error ??= message;
  }

  parseSource(src: string, frame: Frame): void {
    if (frame.depth > MAX_DEPTH) {
      this.fail("command nesting is too deep");
      return;
    }
    const { tokens, error } = new Lexer(src).run();
    if (error) this.fail(error);
    this.parseTokens(tokens, frame);
  }

  private parseTokens(tokens: Token[], frame: Frame): void {
    const cwdStack: Cwd[] = [];
    let cwd = frame.cwd;
    let pipeline = this.nextPipeline++;
    let position = 0;
    let members: ShellCommand[] = [];
    let partial: PartialCommand = { words: [], redirects: [] };

    const finish = (endsPipeline: boolean) => {
      const built = this.build(partial, { ...frame, cwd }, pipeline, position);
      partial = { words: [], redirects: [] };
      if (built) {
        members.push(built.command);
        position++;
        cwd = built.cwdAfter;
      }
      if (endsPipeline) {
        for (const member of members) member.pipelineLength = members.length;
        members = [];
        pipeline = this.nextPipeline++;
        position = 0;
      }
    };

    for (const token of tokens) {
      if (token.type === "word") {
        const last = partial.redirects.at(-1);
        if (last && !last.target && !last.heredoc) last.target = token;
        else partial.words.push(token);
      } else if (token.type === "redir") {
        partial.redirects.push({
          op: token.op,
          ...(token.fd === undefined ? {} : { fd: token.fd }),
          ...(token.heredoc ? { heredoc: token.heredoc } : {}),
        });
      } else if (token.op === "|" || token.op === "|&") {
        finish(false);
      } else if (token.op === "(") {
        finish(true);
        cwdStack.push(cwd);
      } else if (token.op === ")") {
        finish(true);
        cwd = cwdStack.pop() ?? cwd;
      } else {
        finish(true);
      }
    }
    finish(true);
  }

  private build(
    partial: PartialCommand,
    frame: Frame,
    pipeline: number,
    position: number,
  ): { command: ShellCommand; cwdAfter: Cwd } | null {
    if (this.commands.length >= MAX_COMMANDS) {
      this.fail("too many commands to analyze");
      return null;
    }
    const words = partial.words;
    let start = 0;
    while (
      start < words.length &&
      !words[start]!.quoted &&
      RESERVED_PREFIXES.has(words[start]!.text)
    ) {
      start++;
    }
    const header = words[start];
    const isHeader = header !== undefined && !header.quoted && CONTROL_HEADERS.has(header.text);
    const assignments: WordToken[] = [];
    let i = start;
    while (!isHeader && i < words.length && isAssignment(words[i]!)) assignments.push(words[i++]!);

    const unwrapped = isHeader
      ? {
          rest: [] as WordToken[],
          wrappers: [] as string[],
          sudo: false,
          sudoStdin: false,
          fromStdin: false,
        }
      : unwrap(words.slice(i));
    let argvWords = unwrapped.rest;
    if (argvWords.length === 0 && unwrapped.wrappers.length > 0) {
      // A bare wrapper is the command itself: `env` prints the environment, `sudo -s` opens a root shell.
      const last = words.slice(i).find((w) => basename(w.text) === unwrapped.wrappers.at(-1));
      argvWords = last ? [last] : [];
    }

    const redirects: ShellRedirect[] = [];
    let stdinText: string | undefined;
    for (const r of partial.redirects) {
      if (r.heredoc) {
        stdinText = [stdinText, r.heredoc.body].filter((t) => t !== undefined).join("\n");
        redirects.push({
          op: r.op,
          ...(r.fd === undefined ? {} : { fd: r.fd }),
          target: "",
          dynamic: false,
        });
      } else {
        if (!r.target) this.fail("redirection without a target");
        if (r.op === "<<<" && r.target) stdinText = r.target.text;
        redirects.push({
          op: r.op,
          ...(r.fd === undefined ? {} : { fd: r.fd }),
          target: r.target?.text ?? "",
          dynamic: r.target?.dynamic ?? true,
        });
      }
    }

    const allWords = [...words, ...partial.redirects.flatMap((r) => (r.target ? [r.target] : []))];
    const hasCommand = argvWords.length > 0 || redirects.length > 0;
    const command: ShellCommand | undefined = hasCommand
      ? {
          argv: argvWords.map((w) => w.text),
          dynamicArgs: argvWords.map((w) => w.dynamic),
          name: argvWords[0] ? basename(argvWords[0].text) : "",
          wrappers: unwrapped.wrappers,
          sudo: unwrapped.sudo,
          sudoStdin: unwrapped.sudoStdin,
          assignments: assignments.map((w) => w.text),
          vars: [...new Set(allWords.flatMap((w) => w.vars))],
          redirects,
          ...(stdinText === undefined ? {} : { stdinText }),
          argsFromStdin: unwrapped.fromStdin || (frame.argsFromStdin ?? false),
          pipeline,
          position,
          pipelineLength: 1,
          via: frame.via,
          ...(frame.parent ? { parent: frame.parent } : {}),
          cwd: frame.cwd,
          depth: frame.depth,
        }
      : undefined;

    // Substitutions run before the command they appear in, whatever that command turns out to be.
    for (const word of allWords) {
      for (const sub of word.subs) {
        this.parseSource(sub.source, {
          cwd: frame.cwd,
          depth: frame.depth + 1,
          via: sub.kind,
          ...(command ? { parent: command } : {}),
        });
      }
    }
    if (!command) return null;
    this.commands.push(command);
    this.followPayloads(command, argvWords, frame);
    return {
      command,
      cwdAfter:
        command.name === "cd" || command.name === "pushd" || command.name === "popd"
          ? this.cd(command, frame.cwd)
          : frame.cwd,
    };
  }

  /** Parses code that the command itself executes: `bash -c`, `eval`, heredocs fed to a shell, `find -exec`. */
  private followPayloads(command: ShellCommand, argvWords: WordToken[], frame: Frame): void {
    const nested = (via: ShellVia, extra: Partial<Frame> = {}): Frame => ({
      cwd: frame.cwd,
      depth: frame.depth + 1,
      via,
      parent: command,
      ...extra,
    });
    const { name, argv } = command;
    if (SHELL_NAMES.has(name) || name === "su") {
      const payload = shellPayload(argv);
      if (payload !== undefined) this.parseSource(payload, nested("shell-c"));
      else if (command.stdinText !== undefined && !shellScriptOperand(argv)) {
        this.parseSource(command.stdinText, nested("heredoc"));
      }
      return;
    }
    if (name === "eval") {
      this.parseSource(argv.slice(1).join(" "), nested("eval"));
      return;
    }
    if (name === "find") {
      for (let k = 1; k < argvWords.length; k++) {
        if (!/^-(?:exec|execdir|ok|okdir)$/.test(argvWords[k]!.text)) continue;
        const end = argvWords.findIndex((w, idx) => idx > k && (w.text === ";" || w.text === "+"));
        const execWords = argvWords.slice(k + 1, end === -1 ? undefined : end);
        if (execWords.length > 0) {
          this.build(
            { words: execWords, redirects: [] },
            nested("find-exec", { argsFromStdin: true }),
            this.nextPipeline++,
            0,
          );
        }
        if (end === -1) break;
        k = end;
      }
    }
  }

  private cd(command: ShellCommand, cwd: Cwd): Cwd {
    if (command.name === "popd") return { kind: "unknown" };
    let index = 1;
    while (index < command.argv.length && /^-[LPe@]+$/.test(command.argv[index]!)) index++;
    const target = command.argv[index] ?? "~";
    if (target === "-" || command.dynamicArgs[index]) return { kind: "unknown" };
    const resolved = resolvePath(target, cwd, this.workspaceDir);
    return resolved.location === "unknown"
      ? { kind: "unknown" }
      : { kind: "known", path: resolved.path };
  }
}

function unwrap(words: WordToken[]): {
  rest: WordToken[];
  wrappers: string[];
  sudo: boolean;
  sudoStdin: boolean;
  fromStdin: boolean;
} {
  const wrappers: string[] = [];
  let sudo = false;
  let sudoStdin = false;
  let fromStdin = false;
  let i = 0;
  while (i < words.length && wrappers.length < 16) {
    const word = words[i]!;
    const name = basename(word.text);
    if (word.dynamic || !WRAPPERS.has(name)) break;
    if (name === "command" && /^-[vV]$/.test(words[i + 1]?.text ?? "")) break;
    wrappers.push(name);
    if (name === "sudo" || name === "doas") sudo = true;
    if (name === "xargs") fromStdin = true;
    i++;
    const withValue = WRAPPER_OPTIONS_WITH_VALUE.get(name) ?? new Set<string>();
    while (i < words.length) {
      const text = words[i]!.text;
      if (text === "--") {
        i++;
        break;
      }
      if (name === "env" && /^[A-Za-z_]\w*=/.test(text)) {
        i++;
        continue;
      }
      if (!text.startsWith("-") || text === "-") {
        if (name === "env" && text === "-") {
          i++;
          continue;
        }
        break;
      }
      if (name === "sudo" && (/^-[A-Za-z]*S/.test(text) || text === "--stdin")) sudoStdin = true;
      i += withValue.has(text) ? 2 : 1;
    }
    i += WRAPPER_POSITIONAL.get(name) ?? 0;
  }
  return { rest: words.slice(i), wrappers, sudo, sudoStdin, fromStdin };
}

const SHELL_OPTIONS_WITH_VALUE: ReadonlySet<string> = new Set([
  "-o",
  "+o",
  "-O",
  "+O",
  "--rcfile",
  "--init-file",
]);

/** The `-c` payload of `bash -c '…'` / `su -c '…'`, if any. */
export function shellPayload(argv: readonly string[]): string | undefined {
  let wantPayload = false;
  for (let i = 1; i < argv.length; i++) {
    const arg = argv[i]!;
    if (wantPayload && !(arg.startsWith("-") && arg.length > 1)) return arg;
    if (arg === "-c" || arg === "--command" || /^-[a-zA-Z]*c[a-zA-Z]*$/.test(arg)) {
      wantPayload = true;
      continue;
    }
    if (SHELL_OPTIONS_WITH_VALUE.has(arg)) i++;
  }
  return undefined;
}

/** The script file a shell runs (`bash script.sh`), if any. */
export function shellScriptOperand(argv: readonly string[]): string | undefined {
  for (let i = 1; i < argv.length; i++) {
    const arg = argv[i]!;
    if (SHELL_OPTIONS_WITH_VALUE.has(arg)) {
      i++;
      continue;
    }
    if (arg === "-s" || arg === "-") return undefined;
    if (!arg.startsWith("-") && !arg.startsWith("+")) return arg;
  }
  return undefined;
}

/** Undoes spellings that change how text looks but not what the shell runs. */
export function normalizeShellSource(command: string): string {
  return command
    .normalize("NFKC")
    .replaceAll("\0", "")
    .replace(/[\u200B-\u200D\u2060\uFEFF]/g, "")
    .replace(/\r\n?/g, "\n")
    .replace(/\$\{IFS[^}]*\}|\$IFS\b/g, " ");
}

export function parseShell(
  command: string,
  options: { workspaceDir?: string } = {},
): ShellAnalysis {
  const source = normalizeShellSource(command);
  const parser = new Parser(options.workspaceDir);
  if (source.length > MAX_SHELL_COMMAND_CHARS) {
    return { source, commands: [], error: "command is too large to analyze" };
  }
  parser.parseSource(source, { cwd: initialCwd(options.workspaceDir), depth: 0, via: "top" });
  return {
    source,
    commands: parser.commands,
    ...(parser.error ? { error: parser.error } : {}),
  };
}
