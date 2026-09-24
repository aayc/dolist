/**
 * What the safety rules know about individual shell commands: which arguments are paths and
 * whether they are read, written or deleted; how curl/wget/httpie send data; which commands run
 * inline code; and which commands are plain reads or computations (everything else is unknown).
 */
import type { ShellCommand, ShellRedirect } from "./shell";
import { SHELL_NAMES, shellPayload, shellScriptOperand } from "./shell";

export type PathRole = "read" | "write" | "delete" | "meta" | "link-target";

export interface PathTarget {
  path: string;
  dynamic: boolean;
  role: PathRole;
}

interface Operand {
  value: string;
  index: number;
  dynamic: boolean;
}

interface OptionSpec {
  /** Long options that take a separate value (`--output file`). */
  long?: readonly string[];
  /** Short option letters that take a value (`-o file`, `-ofile`). */
  short?: string;
}

const OPTION_SPECS: ReadonlyMap<string, OptionSpec> = new Map<string, OptionSpec>([
  ["cp", { long: ["--target-directory", "--suffix"], short: "tS" }],
  ["mv", { long: ["--target-directory", "--suffix"], short: "tS" }],
  ["ln", { long: ["--target-directory", "--suffix"], short: "tS" }],
  ["install", { long: ["--target-directory", "--mode", "--owner", "--group"], short: "tmogS" }],
  ["touch", { short: "dtr" }],
  ["mkdir", { long: ["--mode"], short: "m" }],
  ["truncate", { long: ["--size", "--reference"], short: "sr" }],
  ["sed", { long: ["--expression", "--file", "--line-length"], short: "efl" }],
  [
    "grep",
    {
      long: [
        "--regexp",
        "--file",
        "--max-count",
        "--label",
        "--include",
        "--exclude",
        "--exclude-dir",
        "--context",
        "--after-context",
        "--before-context",
      ],
      short: "efmABCdD",
    },
  ],
  [
    "rg",
    {
      long: [
        "--regexp",
        "--file",
        "--glob",
        "--iglob",
        "--type",
        "--type-not",
        "--max-count",
        "--max-depth",
        "--context",
        "--after-context",
        "--before-context",
        "--replace",
        "--pre",
      ],
      short: "efgtTmABCrM",
    },
  ],
  ["head", { short: "nc" }],
  ["tail", { short: "nc" }],
  ["cut", { short: "dfcb" }],
  ["sort", { long: ["--output", "--key", "--field-separator"], short: "tkoST" }],
  ["awk", { short: "Ffv" }],
  ["tar", { long: ["--file", "--directory", "--exclude", "--files-from"], short: "fCXT" }],
  ["unzip", { short: "dx" }],
  ["zip", { short: "xi" }],
  ["chmod", { long: ["--reference"] }],
  ["chown", { long: ["--reference", "--from"] }],
  ["scp", { short: "cFiJlOoPS" }],
  [
    "rsync",
    { long: ["--exclude", "--include", "--rsh", "--filter", "--files-from"], short: "efT" },
  ],
  ["ssh", { short: "bcDEeFIiJLlmOoPpQRSWw" }],
]);

const NO_SPEC: OptionSpec = {};

/** Non-option arguments of a command (after its name), honoring `--` and option values. */
export function operands(
  cmd: ShellCommand,
  spec: OptionSpec = OPTION_SPECS.get(cmd.name) ?? NO_SPEC,
): Operand[] {
  const out: Operand[] = [];
  const long = new Set(spec.long ?? []);
  const short = spec.short ?? "";
  let optionsDone = false;
  for (let i = 1; i < cmd.argv.length; i++) {
    const arg = cmd.argv[i]!;
    if (!optionsDone && arg === "--") {
      optionsDone = true;
      continue;
    }
    if (!optionsDone && arg.startsWith("--") && arg.length > 2) {
      if (long.has(arg)) i++;
      continue;
    }
    if (!optionsDone && arg.startsWith("-") && arg.length > 1) {
      const letters = arg.slice(1);
      const valueAt = [...letters].findIndex((ch) => short.includes(ch));
      if (valueAt !== -1 && valueAt === letters.length - 1) i++;
      continue;
    }
    if (arg !== "") out.push({ value: arg, index: i, dynamic: cmd.dynamicArgs[i] ?? false });
  }
  return out;
}

/** Value of an option such as `-o file`, `-ofile`, `--output file` or `--output=file`. */
export function optionValues(
  cmd: ShellCommand,
  shortLetter: string | null,
  longNames: readonly string[],
): string[] {
  const out: string[] = [];
  for (let i = 1; i < cmd.argv.length; i++) {
    const arg = cmd.argv[i]!;
    if (arg === "--") break;
    for (const name of longNames) {
      if (arg === name && i + 1 < cmd.argv.length) out.push(cmd.argv[i + 1]!);
      else if (arg.startsWith(`${name}=`)) out.push(arg.slice(name.length + 1));
    }
    if (shortLetter && /^-[A-Za-z0-9]+/.test(arg) && !arg.startsWith("--")) {
      const at = arg.indexOf(shortLetter, 1);
      if (at === -1) continue;
      const attached = arg.slice(at + 1);
      if (attached) out.push(attached);
      else if (i + 1 < cmd.argv.length) out.push(cmd.argv[i + 1]!);
    }
  }
  return out;
}

export function hasFlag(
  cmd: ShellCommand,
  shortLetters: string,
  longNames: readonly string[] = [],
): boolean {
  for (const arg of cmd.argv.slice(1)) {
    if (arg === "--") return false;
    if (longNames.some((name) => arg === name || arg.startsWith(`${name}=`))) return true;
    if (
      shortLetters &&
      /^-[A-Za-z0-9]+$/.test(arg) &&
      [...arg.slice(1)].some((ch) => shortLetters.includes(ch))
    ) {
      return true;
    }
  }
  return false;
}

const SENSITIVE_BASENAMES_RE =
  /^(?:id_(?:rsa|dsa|ecdsa|ed25519)(?:_sk)?|identity|credentials|known_hosts|authorized_keys|shadow|master\.passwd)$/;

export function looksLikePath(arg: string): boolean {
  if (!arg || arg === "-" || arg.startsWith("-") || /^[a-z][a-z0-9+.-]*:\/\//i.test(arg))
    return false;
  if (/^\d+$/.test(arg)) return false;
  return (
    arg.includes("/") ||
    arg.startsWith("~") ||
    arg.startsWith(".") ||
    /[*?]/.test(arg) ||
    /\.[A-Za-z0-9_-]{1,12}$/.test(arg) ||
    SENSITIVE_BASENAMES_RE.test(arg)
  );
}

/** Embedded databases whose first operand is a local database file. */
const LOCAL_DB_COMMANDS: ReadonlySet<string> = new Set(["sqlite3", "duckdb", "litecli"]);
const DELETE_COMMANDS: ReadonlySet<string> = new Set([
  "rm",
  "rmdir",
  "unlink",
  "shred",
  "srm",
  "trash",
]);
const WRITE_ALL_OPERANDS: ReadonlySet<string> = new Set([
  "touch",
  "mkdir",
  "mkfifo",
  "truncate",
  "tee",
]);
const COPY_COMMANDS: ReadonlySet<string> = new Set(["cp", "install", "ditto", "rsync", "scp"]);
/** Commands that only look at metadata (or data they are given), never print file contents. */
const METADATA_COMMANDS: ReadonlySet<string> = new Set([
  "ls",
  "stat",
  "file",
  "du",
  "test",
  "[",
  "[[",
  "chmod",
  "chown",
  "chgrp",
  "chflags",
  "xattr",
  "realpath",
  "readlink",
  "basename",
  "dirname",
  "which",
  "type",
  "mdls",
  "echo",
  "printf",
  "cd",
  "pushd",
  "ssh-keygen",
  "ssh-add",
  "wc",
]);

function inPlaceEdit(cmd: ShellCommand): boolean {
  if (cmd.name === "sed" || cmd.name === "gsed")
    return hasFlag(cmd, "iI", ["--in-place"]) || cmd.argv.some((a) => /^-i/.test(a));
  if (cmd.name === "perl" || cmd.name === "ruby")
    return cmd.argv.some((a) => /^-[a-zA-Z]*i/.test(a));
  return false;
}

/** Paths a command touches and how. Unknown commands report path-like operands as reads. */
export function pathTargets(cmd: ShellCommand): PathTarget[] {
  const out: PathTarget[] = [];
  const add = (path: string, dynamic: boolean, role: PathRole) => out.push({ path, dynamic, role });
  const ops = operands(cmd);
  const name = cmd.name;

  if (DELETE_COMMANDS.has(name)) {
    for (const o of ops) add(o.value, o.dynamic, "delete");
  } else if (name === "ln" && ops.length === 1) {
    add(ops[0]!.value, ops[0]!.dynamic, "link-target");
    add(".", false, "write");
  } else if (name === "mv" || COPY_COMMANDS.has(name) || name === "ln") {
    // Remote `host:path` operands of scp/rsync are not local paths (network rules cover them).
    const local = ops.filter(
      (o) => !/^(?:[\w.-]+@)?[\w.-]+:/.test(o.value) || o.value.startsWith("/"),
    );
    const targetDir = optionValues(cmd, "t", ["--target-directory"])[0];
    const last = ops.at(-1);
    const destIsLocal = last !== undefined && local.includes(last);
    const sources = targetDir === undefined ? local.filter((o) => o !== last) : local;
    const sourceRole: PathRole = name === "mv" ? "delete" : name === "ln" ? "link-target" : "read";
    for (const o of sources) add(o.value, o.dynamic, sourceRole);
    if (targetDir !== undefined) add(targetDir, false, "write");
    else if (last && destIsLocal && ops.length > 1) add(last.value, last.dynamic, "write");
  } else if (WRITE_ALL_OPERANDS.has(name)) {
    for (const o of ops) add(o.value, o.dynamic, "write");
  } else if (name === "dd") {
    for (const arg of cmd.argv.slice(1)) {
      if (arg.startsWith("of=")) add(arg.slice(3), false, "write");
      if (arg.startsWith("if=")) add(arg.slice(3), false, "read");
    }
  } else if (inPlaceEdit(cmd)) {
    const scriptGiven = hasFlag(cmd, "ef", ["--expression", "--file"]);
    for (const o of scriptGiven ? ops : ops.slice(1)) add(o.value, o.dynamic, "write");
  } else if (name === "tar" || name === "bsdtar" || name === "gtar") {
    tarTargets(cmd, add);
  } else if (name === "unzip") {
    const dir = optionValues(cmd, "d", [])[0];
    add(dir ?? ".", false, "write");
    if (ops[0]) add(ops[0].value, ops[0].dynamic, "read");
  } else if (name === "zip") {
    if (ops[0]) add(ops[0].value, ops[0].dynamic, "write");
    for (const o of ops.slice(1)) add(o.value, o.dynamic, "read");
  } else if (name === "curl" || name === "wget") {
    const request = httpRequestOf(cmd);
    for (const p of request?.outputs ?? []) add(p, false, "write");
    for (const p of request?.uploads ?? []) add(p, false, "read");
  } else if (METADATA_COMMANDS.has(name) || name === "find") {
    for (const o of ops) if (looksLikePath(o.value)) add(o.value, o.dynamic, "meta");
  } else if (LOCAL_DB_COMMANDS.has(name)) {
    // The database file is both read (it may hold personal data) and written by the SQL.
    const db = ops[0];
    if (db && db.value !== ":memory:") {
      add(db.value, db.dynamic, "read");
      add(db.value, db.dynamic, "write");
    }
  } else {
    const skipFirst =
      /^(?:grep|egrep|fgrep|rg|ag|ack|sed|gsed|awk|gawk|mawk|nawk|jq|yq)$/.test(name) &&
      !hasFlag(cmd, name.startsWith("a") ? "f" : "ef", ["--regexp", "--file", "--expression"]);
    for (const o of skipFirst ? ops.slice(1) : ops)
      if (looksLikePath(o.value)) add(o.value, o.dynamic, "read");
  }
  if (name === "sort") for (const p of optionValues(cmd, "o", ["--output"])) add(p, false, "write");
  if (name === "git" && cmd.argv[1] === "clone") {
    const repoOps = operands(cmd).slice(1);
    add(repoOps[1]?.value ?? ".", repoOps[1]?.dynamic ?? false, "write");
  }
  for (const r of cmd.redirects) {
    const role = redirectRole(r);
    if (role) add(r.target, r.dynamic, role);
  }
  return out;
}

function tarTargets(
  cmd: ShellCommand,
  add: (path: string, dynamic: boolean, role: PathRole) => void,
): void {
  const first = cmd.argv[1] ?? "";
  const bundled = /^[a-zA-Z]+$/.test(first) ? first : "";
  const mode = (letter: string, long: string) =>
    bundled.includes(letter) || hasFlag(cmd, letter, [long]);
  const archive =
    optionValues(cmd, "f", ["--file"])[0] ?? (bundled.includes("f") ? cmd.argv[2] : undefined);
  const dir = optionValues(cmd, "C", ["--directory"])[0];
  const files = operands(cmd).filter(
    (o) => o.value !== archive && o.value !== dir && o.value !== bundled,
  );
  if (mode("x", "--extract") || mode("x", "--get")) {
    add(dir ?? ".", false, "write");
    if (archive) add(archive, false, "read");
  } else if (mode("c", "--create") || mode("r", "--append") || mode("u", "--update")) {
    if (archive && archive !== "-") add(archive, false, "write");
    for (const o of files) add(o.value, o.dynamic, "read");
  } else if (archive) {
    add(archive, false, "read");
  }
}

const DEVICE_SINKS_RE = /^\/dev\/(?:null|zero|stdout|stderr|stdin|tty|fd\/\d+)$/;

export function redirectRole(r: ShellRedirect): "read" | "write" | null {
  if (
    !r.target ||
    r.op === "<<" ||
    r.op === "<<-" ||
    r.op === "<<<" ||
    r.op === ">&" ||
    r.op === "<&"
  )
    return null;
  if (DEVICE_SINKS_RE.test(r.target)) return null;
  return r.op === "<" ? "read" : "write";
}

export function isNetworkDevice(path: string): boolean {
  return /^\/dev\/(?:tcp|udp)\//.test(path);
}

// ── HTTP clients ────────────────────────────────────────────────────────────

export interface HttpRequestInfo {
  client: string;
  urls: string[];
  method: string;
  /** Sends a request body, form fields or a file. */
  sendsData: boolean;
  /** Local files whose contents are sent. */
  uploads: string[];
  /** Local files the response is written to. */
  outputs: string[];
  headers: string[];
  /** Values passed as data/form fields (for secret checks). */
  dataValues: string[];
}

const CURL_LONG_WITH_VALUE: ReadonlySet<string> = new Set([
  "--output",
  "--data",
  "--data-ascii",
  "--data-binary",
  "--data-raw",
  "--data-urlencode",
  "--json",
  "--form",
  "--form-string",
  "--header",
  "--request",
  "--user",
  "--user-agent",
  "--referer",
  "--cookie",
  "--cookie-jar",
  "--upload-file",
  "--config",
  "--proxy",
  "--proxy-user",
  "--max-time",
  "--connect-timeout",
  "--write-out",
  "--dump-header",
  "--range",
  "--cert",
  "--key",
  "--cacert",
  "--capath",
  "--continue-at",
  "--url",
  "--output-dir",
  "--retry",
  "--retry-delay",
  "--retry-max-time",
  "--limit-rate",
  "--max-filesize",
  "--resolve",
  "--connect-to",
  "--interface",
  "--quote",
  "--oauth2-bearer",
  "--aws-sigv4",
  "--variable",
  "--trace",
  "--trace-ascii",
  "--stderr",
  "--time-cond",
  "--speed-limit",
  "--speed-time",
  "--max-redirs",
  "--expect100-timeout",
  "--unix-socket",
]);
const CURL_SHORT_WITH_VALUE = "odFHXuAebcTKxUmwDrECYyztQ";

function curlRequest(cmd: ShellCommand): HttpRequestInfo {
  const info: HttpRequestInfo = {
    client: "curl",
    urls: [],
    method: "GET",
    sendsData: false,
    uploads: [],
    outputs: [],
    headers: [],
    dataValues: [],
  };
  const handle = (option: string, value: string) => {
    switch (option) {
      case "-X":
      case "--request":
        info.method = value.toUpperCase();
        break;
      case "-d":
      case "--data":
      case "--data-ascii":
      case "--data-binary":
      case "--data-urlencode":
      case "--json":
        info.sendsData = true;
        info.dataValues.push(value);
        if (value.startsWith("@") && value.length > 1) info.uploads.push(value.slice(1));
        else if (/^[^=]*=@/.test(value) && option === "--data-urlencode")
          info.uploads.push(value.replace(/^[^=]*=@/, ""));
        break;
      case "--data-raw":
        info.sendsData = true;
        info.dataValues.push(value);
        break;
      case "-F":
      case "--form": {
        info.sendsData = true;
        info.dataValues.push(value);
        const file = /^[^=]*=[@<]([^;]+)/.exec(value)?.[1];
        if (file) info.uploads.push(file);
        break;
      }
      case "--form-string":
        info.sendsData = true;
        info.dataValues.push(value);
        break;
      case "-T":
      case "--upload-file":
        info.sendsData = true;
        info.uploads.push(value);
        break;
      case "-o":
      case "--output":
        if (value !== "-") info.outputs.push(value);
        break;
      case "--output-dir":
      case "-D":
      case "--dump-header":
      case "-c":
      case "--cookie-jar":
        info.outputs.push(value);
        break;
      case "-H":
      case "--header":
        info.headers.push(value);
        break;
      case "-u":
      case "--user":
      case "--oauth2-bearer":
        info.headers.push(`Authorization: ${value}`);
        break;
      case "--url":
        info.urls.push(value);
        break;
    }
  };
  for (let i = 1; i < cmd.argv.length; i++) {
    const arg = cmd.argv[i]!;
    if (arg.startsWith("--")) {
      const eq = arg.indexOf("=");
      const name = eq === -1 ? arg : arg.slice(0, eq);
      if (eq !== -1) handle(name, arg.slice(eq + 1));
      else if (CURL_LONG_WITH_VALUE.has(name)) handle(name, cmd.argv[++i] ?? "");
      else if (name === "--get") info.method = "GET";
      else if (name === "--remote-name" || name === "--remote-name-all") info.outputs.push(".");
      continue;
    }
    if (arg.startsWith("-") && arg.length > 1) {
      for (let k = 1; k < arg.length; k++) {
        const letter = arg[k]!;
        if (letter === "O") info.outputs.push(".");
        if (letter === "G") info.method = "GET";
        if (CURL_SHORT_WITH_VALUE.includes(letter)) {
          const attached = arg.slice(k + 1);
          handle(`-${letter}`, attached || (cmd.argv[++i] ?? ""));
          break;
        }
      }
      continue;
    }
    info.urls.push(arg);
  }
  if (info.sendsData && info.method === "GET" && !hasFlag(cmd, "G", ["--get"]))
    info.method = "POST";
  if (info.uploads.length > 0 && info.method === "GET") info.method = "PUT";
  return info;
}

function wgetRequest(cmd: ShellCommand): HttpRequestInfo {
  const info: HttpRequestInfo = {
    client: "wget",
    urls: [],
    method: "GET",
    sendsData: false,
    uploads: [],
    outputs: [],
    headers: [],
    dataValues: [],
  };
  const withValue = new Set([
    "-O",
    "-o",
    "-a",
    "-P",
    "-i",
    "-U",
    "-e",
    "-t",
    "-T",
    "-w",
    "-Q",
    "-l",
    "-A",
    "-R",
    "-D",
    "-B",
  ]);
  let explicitOutput = false;
  for (let i = 1; i < cmd.argv.length; i++) {
    const arg = cmd.argv[i]!;
    const [name, inline] =
      arg.startsWith("--") && arg.includes("=")
        ? [arg.slice(0, arg.indexOf("=")), arg.slice(arg.indexOf("=") + 1)]
        : [arg, undefined];
    const value = () => inline ?? cmd.argv[++i] ?? "";
    switch (name) {
      case "--post-data":
      case "--body-data":
        info.sendsData = true;
        info.dataValues.push(value());
        if (info.method === "GET") info.method = "POST";
        continue;
      case "--post-file":
      case "--body-file": {
        info.sendsData = true;
        info.uploads.push(value());
        if (info.method === "GET") info.method = "POST";
        continue;
      }
      case "--method":
        info.method = value().toUpperCase();
        continue;
      case "-O":
      case "--output-document": {
        const v = value();
        explicitOutput = true;
        if (v !== "-") info.outputs.push(v);
        continue;
      }
      case "-P":
      case "--directory-prefix":
        explicitOutput = true;
        info.outputs.push(value());
        continue;
      case "-o":
      case "--output-file":
      case "-a":
      case "--append-output":
        info.outputs.push(value());
        continue;
      case "--header":
        info.headers.push(value());
        continue;
      case "--password":
      case "--http-password":
        info.headers.push(`password ${value()}`);
        continue;
    }
    if (/^-O./.test(arg)) {
      explicitOutput = true;
      if (arg.slice(2) !== "-") info.outputs.push(arg.slice(2));
      continue;
    }
    if (arg.startsWith("-")) {
      if (withValue.has(arg)) i++;
      continue;
    }
    info.urls.push(arg);
  }
  if (!explicitOutput) info.outputs.push(".");
  return info;
}

const HTTPIE_METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]);

function httpieRequest(cmd: ShellCommand): HttpRequestInfo {
  const info: HttpRequestInfo = {
    client: cmd.name,
    urls: [],
    method: "GET",
    sendsData: false,
    uploads: [],
    outputs: [],
    headers: [],
    dataValues: [],
  };
  const args = operands(cmd, {
    short: "aov",
    long: [
      "--auth",
      "--output",
      "--session",
      "--verify",
      "--cert",
      "--cert-key",
      "--proxy",
      "--timeout",
      "--print",
      "--pretty",
      "--style",
      "--format-options",
    ],
  });
  let k = 0;
  if (args[0] && HTTPIE_METHODS.has(args[0].value.toUpperCase()) && args.length > 1) {
    info.method = args[0].value.toUpperCase();
    k = 1;
  }
  const url = args[k];
  if (url) info.urls.push(url.value);
  for (const item of args.slice(k + 1)) {
    const v = item.value;
    const separator = /^[^=:@]+(==|:=@|:=|=@|=|@|:)/.exec(v)?.[1];
    if (!separator || separator === "==") continue;
    if (separator === ":") {
      info.headers.push(v);
      continue;
    }
    info.sendsData = true;
    info.dataValues.push(v);
    if (separator.endsWith("@"))
      info.uploads.push(v.slice(v.indexOf(separator) + separator.length));
  }
  if (info.sendsData && info.method === "GET" && k === 0) info.method = "POST";
  info.outputs.push(...optionValues(cmd, "o", ["--output"]));
  return info;
}

function ghApiRequest(cmd: ShellCommand): HttpRequestInfo | undefined {
  if (cmd.argv[1] !== "api") return undefined;
  const info: HttpRequestInfo = {
    client: "gh api",
    urls: [],
    method: "GET",
    sendsData: false,
    uploads: [],
    outputs: [],
    headers: [],
    dataValues: [],
  };
  const method = optionValues(cmd, "X", ["--method"])[0];
  const fields = [
    ...optionValues(cmd, "f", ["--raw-field"]),
    ...optionValues(cmd, "F", ["--field"]),
  ];
  const input = optionValues(cmd, null, ["--input"])[0];
  if (fields.length > 0 || input) {
    info.sendsData = true;
    info.dataValues.push(...fields);
    info.method = "POST";
  }
  if (input && input !== "-") info.uploads.push(input);
  if (method) info.method = method.toUpperCase();
  const endpoint = operands(cmd, {
    short: "XfFHpqt",
    long: [
      "--method",
      "--raw-field",
      "--field",
      "--header",
      "--input",
      "--jq",
      "--template",
      "--hostname",
      "--preview",
      "--cache",
    ],
  })[1];
  if (endpoint)
    info.urls.push(
      endpoint.value.startsWith("http")
        ? endpoint.value
        : `https://api.github.com/${endpoint.value.replace(/^\//, "")}`,
    );
  return info;
}

export function httpRequestOf(cmd: ShellCommand): HttpRequestInfo | undefined {
  switch (cmd.name) {
    case "curl":
      return curlRequest(cmd);
    case "wget":
      return wgetRequest(cmd);
    case "http":
    case "https":
    case "xh":
    case "xhs":
      return httpieRequest(cmd);
    case "gh":
      return ghApiRequest(cmd);
    default:
      return undefined;
  }
}

/** Adds a scheme to scheme-less URLs (`curl example.com/x`) so they can be parsed. */
export function withScheme(url: string): string {
  return /^[a-z][a-z0-9+.-]*:/i.test(url) ? url : `http://${url}`;
}

// ── Interpreters ────────────────────────────────────────────────────────────

export interface InterpreterCall {
  family: string;
  /** Code passed inline (`-c`, `-e`) or through a heredoc / here-string. */
  inlineCode?: string;
  /** Script file it runs. */
  script?: string;
  /** `python -m <module>`. */
  module?: string;
}

const INLINE_FLAGS: ReadonlyMap<string, readonly string[]> = new Map([
  ["python", ["-c"]],
  ["node", ["-e", "--eval", "-p", "--print"]],
  ["bun", ["-e", "--eval", "-p", "--print"]],
  ["deno", ["eval"]],
  ["ruby", ["-e"]],
  ["perl", ["-e", "-E"]],
  ["php", ["-r"]],
  ["lua", ["-e"]],
  ["osascript", ["-e"]],
  ["rscript", ["-e"]],
  ["powershell", ["-c", "-command", "-Command"]],
]);

function interpreterFamily(name: string): string | undefined {
  if (/^python(?:\d+(?:\.\d+)*)?$|^py$|^pypy3?$/.test(name)) return "python";
  if (name === "nodejs") return "node";
  if (name === "pwsh") return "powershell";
  if (name === "luajit") return "lua";
  return INLINE_FLAGS.has(name) ? name : undefined;
}

export function interpreterCall(cmd: ShellCommand): InterpreterCall | undefined {
  const family = interpreterFamily(cmd.name);
  if (!family) return undefined;
  const flags = INLINE_FLAGS.get(family) ?? [];
  const code: string[] = [];
  let script: string | undefined;
  let module: string | undefined;
  for (let i = 1; i < cmd.argv.length; i++) {
    const arg = cmd.argv[i]!;
    if (flags.includes(arg)) {
      if (i + 1 < cmd.argv.length) code.push(cmd.argv[++i]!);
      continue;
    }
    const glued = flags.find(
      (f) => f.length === 2 && arg.startsWith(f) && arg.length > 2 && !arg.startsWith("--"),
    );
    if (glued && family !== "deno") {
      code.push(arg.slice(2));
      continue;
    }
    if (family === "python" && arg === "-m") {
      module = cmd.argv[i + 1];
      break;
    }
    if (arg.startsWith("-")) continue;
    if (code.length === 0) script = arg;
    break;
  }
  if (
    code.length === 0 &&
    script === undefined &&
    module === undefined &&
    cmd.stdinText !== undefined
  ) {
    code.push(cmd.stdinText);
  }
  return {
    family,
    ...(code.length > 0 ? { inlineCode: code.join("\n") } : {}),
    ...(script === undefined || script === "-" ? {} : { script }),
    ...(module === undefined ? {} : { module }),
  };
}

// ── Classification of benign commands ───────────────────────────────────────

export type CommandKind =
  | "noop"
  | "read"
  | "compute"
  | "network"
  | "workspace-write"
  | "script"
  | "unknown";

export interface CommandClass {
  kind: CommandKind;
  note?: string;
}

const NOOP_COMMANDS: ReadonlySet<string> = new Set([
  "cd",
  "pushd",
  "popd",
  "export",
  "unset",
  "true",
  "false",
  ":",
  "sleep",
  "wait",
  "read",
  "shift",
  "exit",
  "return",
  "local",
  "declare",
  "typeset",
  "readonly",
  "alias",
  "unalias",
  "hash",
  "type",
  "command",
  "echo",
  "printf",
  "test",
  "[",
  "[[",
  "trap",
  "umask",
  "clear",
  "tput",
  "jobs",
  "set",
  "say",
  "afplay",
  "history",
]);

const READ_COMMANDS: ReadonlySet<string> = new Set([
  "ls",
  "ll",
  "la",
  "dir",
  "cat",
  "bat",
  "head",
  "tail",
  "less",
  "more",
  "wc",
  "sort",
  "uniq",
  "cut",
  "grep",
  "egrep",
  "fgrep",
  "rg",
  "ag",
  "ack",
  "fd",
  "tree",
  "stat",
  "file",
  "du",
  "df",
  "pwd",
  "date",
  "cal",
  "whoami",
  "id",
  "groups",
  "hostname",
  "uname",
  "sw_vers",
  "which",
  "whereis",
  "basename",
  "dirname",
  "realpath",
  "readlink",
  "jq",
  "yq",
  "gojq",
  "column",
  "paste",
  "join",
  "comm",
  "diff",
  "colordiff",
  "cmp",
  "md5",
  "md5sum",
  "shasum",
  "sha1sum",
  "sha256sum",
  "sha512sum",
  "b2sum",
  "cksum",
  "xxd",
  "od",
  "hexdump",
  "strings",
  "nl",
  "fold",
  "fmt",
  "rev",
  "tac",
  "tr",
  "expand",
  "unexpand",
  "getconf",
  "locale",
  "uptime",
  "ps",
  "pgrep",
  "lsof",
  "vm_stat",
  "iostat",
  "netstat",
  "man",
  "info",
  "apropos",
  "whatis",
  "tldr",
  "help",
  "mdfind",
  "mdls",
  "system_profiler",
  "ioreg",
  "printenv",
  "env",
  "sips",
  "exiftool",
  "mediainfo",
  "ffprobe",
  "identify",
  "pdfinfo",
  "xmllint",
  "iconv",
  "base64",
  "base32",
  "zcat",
  "gzcat",
  "bzcat",
  "xzcat",
  "otool",
  "nm",
  "codesign",
  "seq",
  "bc",
  "dc",
  "expr",
  "factor",
  "numfmt",
  "awk",
  "gawk",
  "mawk",
  "nawk",
  "sed",
  "gsed",
  "find",
  "look",
  "cksum",
  "csvlook",
  "csvstat",
  "csvcut",
  "yes",
]);

const NETWORK_READ_COMMANDS: ReadonlySet<string> = new Set([
  "curl",
  "wget",
  "http",
  "https",
  "xh",
  "xhs",
  "dig",
  "nslookup",
  "host",
  "whois",
  "ping",
  "traceroute",
  "mtr",
]);

const WORKSPACE_WRITE_COMMANDS: ReadonlySet<string> = new Set([
  "mkdir",
  "touch",
  "cp",
  "mv",
  "ln",
  "tee",
  "truncate",
  "install",
  "ditto",
  "dd",
  "rm",
  "rmdir",
  "unlink",
  "shred",
  "trash",
  "tar",
  "bsdtar",
  "gtar",
  "unzip",
  "zip",
  "gzip",
  "gunzip",
  "bzip2",
  "bunzip2",
  "xz",
  "unxz",
  "7z",
  "chmod",
  "mkfifo",
  "split",
  "csplit",
  "patch",
  "rsync",
  "pdftotext",
  "convert",
  "magick",
  "ffmpeg",
  "pandoc",
  "tsc",
  "eslint",
  "prettier",
  "biome",
  "black",
  "ruff",
  "flake8",
  "mypy",
  "pyright",
  "shellcheck",
  "gofmt",
  "rustfmt",
  "clang-format",
  "stylelint",
  "markdownlint",
]);

const SCRIPT_RUNNERS: ReadonlySet<string> = new Set([
  "make",
  "cmake",
  "ninja",
  "cargo",
  "go",
  "mvn",
  "gradle",
  "gradlew",
  "xcodebuild",
  "swift",
  "pytest",
  "vitest",
  "jest",
  "mocha",
  "rake",
  "bundle",
  "tox",
  "nox",
  "just",
  "task",
]);

const GIT_READ: ReadonlySet<string> = new Set([
  "status",
  "log",
  "diff",
  "show",
  "blame",
  "describe",
  "shortlog",
  "grep",
  "rev-parse",
  "ls-files",
  "ls-tree",
  "cat-file",
  "reflog",
  "whatchanged",
  "count-objects",
  "fsck",
  "help",
  "version",
  "--version",
  "name-rev",
  "merge-base",
  "cherry",
  "rev-list",
  "for-each-ref",
  "show-ref",
  "check-ignore",
  "var",
]);
const GIT_NETWORK: ReadonlySet<string> = new Set(["fetch", "ls-remote"]);
const GIT_WRITE: ReadonlySet<string> = new Set([
  "clone",
  "pull",
  "add",
  "commit",
  "init",
  "checkout",
  "switch",
  "restore",
  "merge",
  "rebase",
  "cherry-pick",
  "revert",
  "stash",
  "tag",
  "branch",
  "mv",
  "rm",
  "apply",
  "am",
  "notes",
  "worktree",
  "submodule",
  "gc",
  "prune",
  "clean",
  "config",
  "remote",
  "reset",
  "bisect",
  "format-patch",
  "archive",
  "sparse-checkout",
  "lfs",
]);

const PACKAGE_READ =
  /^(?:ls|list|view|info|outdated|why|audit|search|show|freeze|check|help|--version|-v|version|config|doctor|deps|leaves|uses|home|explain|licenses|root|bin|prefix|pack)$/;

function subcommand(cmd: ShellCommand): string {
  return (
    operands(cmd, {
      short: "C",
      long: ["-C", "--prefix", "--cwd", "--dir", "--filter", "--workspace", "-w"],
    })[0]?.value ?? ""
  );
}

const CODE_NETWORK_WRITE_RE =
  /\b(?:requests|httpx|axios)\.(?:post|put|patch|delete)\b|\bmethod\s*[:=]\s*['"](?:POST|PUT|PATCH|DELETE)['"]|\burlopen\([^)]*data\s*=|\bsmtplib\b|\.sendmail\(|\bnet\/smtp\b/i;
const CODE_RISKY_RE =
  /\b(?:os\.(?:system|popen|exec\w*|spawn\w*|remove|unlink|rmdir|removedirs|rename|replace|chmod|chown|kill|environ)|subprocess|pty\.spawn|child_process|execSync|spawnSync|execFile|shell_exec|passthru|proc_open|popen|Kernel\.exec|IO\.popen|__import__|importlib|ctypes|shutil\.(?:rmtree|move)|rmSync|rmdirSync|unlinkSync|fs\.(?:rm|rmdir|unlink|rename|chmod|promises)|FileUtils\.rm|urllib|http\.client|ftplib|socket|paramiko|telnetlib|webbrowser|keyring|process\.env|getenv|expanduser|Path\.home|homedir|fetch|axios|XMLHttpRequest|net\.connect|https?\.request|do shell script|tell application)\b|\bsystem\s*\(|\beval\s*\(|\bexec\s*\(/;

/** Why inline code needs a closer look, or undefined when it only computes. */
export function riskyCodeReason(
  code: string,
): { reason: string; networkWrite: boolean } | undefined {
  const network = CODE_NETWORK_WRITE_RE.exec(code);
  if (network) return { reason: `inline code sends data (${network[0]})`, networkWrite: true };
  const risky = CODE_RISKY_RE.exec(code);
  return risky ? { reason: `inline code uses ${risky[0].trim()}`, networkWrite: false } : undefined;
}

function classifyGit(cmd: ShellCommand): CommandClass {
  const sub = subcommand(cmd);
  if (GIT_READ.has(sub) || sub === "") return { kind: "read" };
  if (
    sub === "branch" ||
    sub === "tag" ||
    sub === "remote" ||
    sub === "stash" ||
    sub === "config" ||
    sub === "worktree"
  ) {
    const rest = operands(cmd).slice(1);
    const listing =
      rest.length === 0 || (rest.length === 1 && /^(?:list|show)$/.test(rest[0]!.value));
    const flags = cmd.argv.slice(2).filter((a) => a.startsWith("-"));
    const readFlags = flags.every((a) =>
      /^-(?:[varl]+|-list|-verbose|-all|-get(?:-all)?|-show-origin)$/.test(a),
    );
    if (listing && readFlags) return { kind: "read" };
  }
  if (GIT_NETWORK.has(sub)) return { kind: "network" };
  if (GIT_WRITE.has(sub)) return { kind: "workspace-write" };
  return { kind: "unknown", note: `git ${sub}` };
}

function classifyInterpreter(cmd: ShellCommand, call: InterpreterCall): CommandClass {
  if (call.inlineCode !== undefined) {
    const risky = riskyCodeReason(call.inlineCode);
    return risky ? { kind: "unknown", note: risky.reason } : { kind: "compute" };
  }
  if (call.module) {
    if (
      /^(?:json\.tool|this|calendar|base64|uuid|timeit|py_compile|compileall|tokenize|ast|dis)$/.test(
        call.module,
      )
    ) {
      return { kind: "compute" };
    }
    if (call.module === "venv" || call.module === "virtualenv") return { kind: "workspace-write" };
    return { kind: "script", note: `runs the Python module ${call.module}` };
  }
  if (call.script) return { kind: "script", note: `runs ${call.script}` };
  if (cmd.position > 0) return { kind: "unknown", note: `${cmd.name} runs code piped into it` };
  return { kind: "unknown", note: `${cmd.name} without a script` };
}

function classifyPackageManager(cmd: ShellCommand): CommandClass {
  const sub = subcommand(cmd);
  if (PACKAGE_READ.test(sub)) return { kind: "read" };
  if (/^(?:test|t|run|run-script|start|build|lint|dev|exec|x|tsc)$/.test(sub)) {
    return { kind: "script", note: `${cmd.name} ${sub} runs project scripts` };
  }
  return { kind: "unknown", note: `${cmd.name} ${sub}`.trim() };
}

export function classifyCommand(cmd: ShellCommand): CommandClass {
  const { name } = cmd;
  if (name === "") return { kind: "noop" };
  if (cmd.dynamicArgs[0])
    return { kind: "unknown", note: "the command name is computed at runtime" };
  if (name === "printenv" || name === "env" || name === "set") return { kind: "read" };
  if (NOOP_COMMANDS.has(name)) return { kind: "noop" };
  if (name === "sed" || name === "gsed")
    return inPlaceEdit(cmd) ? { kind: "workspace-write" } : { kind: "read" };
  if (/^(?:g|m|n)?awk$/.test(name)) {
    const program = operands(cmd)[0]?.value ?? "";
    return /\bsystem\s*\(|\|\s*"|"\s*\|\s*getline|>\s*"/.test(program)
      ? { kind: "unknown", note: "awk program runs commands or writes files" }
      : { kind: "read" };
  }
  if (name === "find") {
    return cmd.argv.some((a) =>
      /^-(?:f(?:print0?|printf|ls)|delete|exec(?:dir)?|ok(?:dir)?)$/.test(a),
    )
      ? { kind: "workspace-write" }
      : { kind: "read" };
  }
  if (name === "wget" || (name === "curl" && (httpRequestOf(cmd)?.outputs.length ?? 0) > 0))
    return { kind: "workspace-write" };
  if (LOCAL_DB_COMMANDS.has(name)) return { kind: "workspace-write" };
  if (READ_COMMANDS.has(name)) return { kind: "read" };
  if (NETWORK_READ_COMMANDS.has(name)) return { kind: "network" };
  if (WORKSPACE_WRITE_COMMANDS.has(name)) return { kind: "workspace-write" };
  if (name === "git") return classifyGit(cmd);
  if (SHELL_NAMES.has(name)) {
    if (shellPayload(cmd.argv) !== undefined) return { kind: "noop" };
    const script = shellScriptOperand(cmd.argv);
    if (script) return { kind: "script", note: `runs ${script}` };
    if (cmd.stdinText !== undefined) return { kind: "noop" };
    return { kind: "unknown", note: `${name} runs commands piped into it` };
  }
  if (name === "eval")
    return cmd.dynamicArgs.slice(1).some(Boolean)
      ? { kind: "unknown", note: "eval of computed text" }
      : { kind: "noop" };
  if (name === "source" || name === ".") {
    return /(?:^|\/)bin\/activate(?:\.\w+)?$/.test(cmd.argv[1] ?? "")
      ? { kind: "noop" }
      : { kind: "script", note: `sources ${cmd.argv[1] ?? "a file"}` };
  }
  const call = interpreterCall(cmd);
  if (call) return classifyInterpreter(cmd, call);
  if (/^(?:npm|pnpm|yarn|bun|pip|pip3|pipx|uv|brew|gem|cargo|poetry|conda|mamba)$/.test(name)) {
    if (SCRIPT_RUNNERS.has(name)) return { kind: "script", note: `${name} runs project code` };
    return classifyPackageManager(cmd);
  }
  if (SCRIPT_RUNNERS.has(name)) return { kind: "script", note: `${name} runs project code` };
  if (cmd.argv[0]?.includes("/")) return { kind: "script", note: `runs ${cmd.argv[0]}` };
  return { kind: "unknown", note: `unrecognized command \`${name}\`` };
}
