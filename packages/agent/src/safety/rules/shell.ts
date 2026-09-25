/**
 * Adapted from Hermes Agent (MIT) — see NOTICE.md for the adapted patterns and license.
 *
 * Rules for shell commands. Each rule inspects one simple command produced by `parseShell` (with
 * the whole analysis available for pipeline/substitution flows).
 */
import {
  catastrophicTarget,
  expandBraces,
  isUserDataPath,
  type ResolvedPath,
  type SensitiveKind,
  sensitiveKinds,
} from "../paths";
import { findSecrets } from "../sensitive";
import { SHELL_NAMES, type ShellCommand, shellPayload, shellScriptOperand } from "../shell";
import {
  hasFlag,
  httpRequestOf,
  interpreterCall,
  isNetworkDevice,
  looksLikePath,
  operands,
  optionValues,
  type PathRole,
  pathTargets,
  readsFolderTrees,
  riskyCodeReason,
  searchesRecursively,
  withScheme,
} from "../shell-commands";
import { DESTRUCTIVE_SQL_RULE, destructiveSqlInText, executedTextHits } from "./content";
import { SECRET_SEARCH, SECRET_WORDS_RE } from "./files";
import { appStateHits, readPathHits, writePathHits } from "./path-rules";
import {
  info,
  type Match,
  type RuleHit,
  type SafetyRuleInfo,
  type ShellEnv,
  type ShellRule,
} from "./types";
import { parseUrl, URL_RULES } from "./web";

function code(text: string, max = 80): string {
  const clean = text.replace(/\s+/g, " ").trim();
  return `\`${clean.length > max ? `${clean.slice(0, max - 1)}…` : clean}\``;
}

function display(cmd: ShellCommand, max = 80): string {
  const redirects = cmd.redirects.filter((r) => r.target).map((r) => `${r.op} ${r.target}`);
  return code([...(cmd.sudo ? ["sudo"] : []), ...cmd.argv, ...redirects].join(" "), max);
}

interface Target {
  raw: string;
  resolved: ResolvedPath;
  role: PathRole;
}

const targetCache = new WeakMap<ShellCommand, Target[]>();

function targets(cmd: ShellCommand, env: ShellEnv): Target[] {
  const cached = targetCache.get(cmd);
  if (cached) return cached;
  const out: Target[] = [];
  for (const t of pathTargets(cmd)) {
    for (const raw of expandBraces(t.path)) {
      out.push({
        raw,
        role: t.role,
        resolved: t.dynamic ? { location: "unknown", path: raw } : env.resolve(raw, cmd),
      });
    }
  }
  targetCache.set(cmd, out);
  return out;
}

function sub(cmd: ShellCommand, index = 0): string {
  return (
    operands(cmd, {
      short: "C",
      long: ["--prefix", "--cwd", "--dir", "--filter", "--workspace", "--location"],
    })[index]?.value ?? ""
  );
}

/** True when `cmd`'s output ends up in `ancestor`'s arguments (`$(…)`, `<(…)`), however deeply nested. */
function feedsArguments(cmd: ShellCommand, ancestor: ShellCommand): boolean {
  for (let c: ShellCommand | undefined = cmd; c?.parent; c = c.parent) {
    if (c.via !== "substitution" && c.via !== "process-substitution") return false;
    if (c.parent === ancestor) return true;
  }
  return false;
}

/** Commands whose output feeds `cmd`: earlier members of its pipeline and substitutions in its arguments. */
function feeders(cmd: ShellCommand, env: ShellEnv): ShellCommand[] {
  return env.analysis.commands.filter(
    (other) =>
      other !== cmd &&
      ((other.pipeline === cmd.pipeline && other.position < cmd.position) ||
        feedsArguments(other, cmd)),
  );
}

function rule(meta: SafetyRuleInfo, match: (cmd: ShellCommand, env: ShellEnv) => Match): ShellRule {
  return { ...meta, match };
}

// ── Shared predicates ───────────────────────────────────────────────────────

const DELETE_NAMES: ReadonlySet<string> = new Set([
  "rm",
  "srm",
  "unlink",
  "shred",
  "trash",
  "rmdir",
]);
const SECRET_KINDS: ReadonlySet<SensitiveKind> = new Set([
  "ssh-private-key",
  "credential-store",
  "app-secret",
  "env-file",
  "key-material",
  "credential-config",
  "history",
]);
const SECRET_VAR_RE =
  /(?:^|_)(?:KEY|APIKEY|TOKEN|SECRET|SECRETS|PASSWORD|PASSWD|PASS|PWD_HASH|CREDENTIALS?|AUTH|COOKIE|SESSION|PRIVATE)(?:_|$)|^(?:AWS_|GH_|GITHUB_|OPENAI|OPENROUTER|ANTHROPIC|STRIPE|SLACK|TWILIO|SENDGRID|DATABASE_URL|PGPASSWORD|MYSQL_PWD|NPM_TOKEN)/i;
const NETWORK_SINKS: ReadonlySet<string> = new Set([
  "curl",
  "wget",
  "nc",
  "ncat",
  "netcat",
  "socat",
  "telnet",
  "ssh",
  "scp",
  "sftp",
  "ftp",
  "rsync",
  "mail",
  "mailx",
  "sendmail",
  "mutt",
  "msmtp",
  "http",
  "https",
  "xh",
  "xhs",
  "aws",
  "gsutil",
  "rclone",
  "gh",
  "s3cmd",
  "az",
  "gcloud",
]);
const DOWNLOADERS: ReadonlySet<string> = new Set([
  "curl",
  "wget",
  "fetch",
  "http",
  "https",
  "xh",
  "xhs",
  "aria2c",
]);

function isEnvDump(cmd: ShellCommand): boolean {
  if (cmd.name === "env" || cmd.name === "printenv") {
    const names = operands(cmd).map((o) => o.value);
    return names.length === 0 || names.some((n) => SECRET_VAR_RE.test(n));
  }
  if (cmd.name === "set") return cmd.argv.length === 1;
  if (cmd.name === "export" || cmd.name === "declare" || cmd.name === "typeset") {
    return cmd.argv.length === 1 || cmd.argv.slice(1).every((a) => /^-[a-z]*[px][a-z]*$/.test(a));
  }
  return false;
}

function secretVars(cmd: ShellCommand): string[] {
  return cmd.vars.filter((v) => SECRET_VAR_RE.test(v));
}

function keychainPasswordRead(cmd: ShellCommand): boolean {
  if (cmd.name !== "security") return false;
  const verb = cmd.argv[1] ?? "";
  if (/^find-(?:generic|internet)-password$/.test(verb))
    return cmd.argv.some((a) => /^-[a-zA-Z]*[wg]/.test(a) && !a.startsWith("--"));
  if (verb === "dump-keychain") return true;
  if (verb === "export") return cmd.argv.some((a) => /^(?:identities|privKeys|all)$/.test(a));
  return false;
}

/** What secret `cmd` produces or reads, if any. */
function secretSource(cmd: ShellCommand, env: ShellEnv): string | undefined {
  for (const t of targets(cmd, env)) {
    if (
      (t.role === "read" || t.role === "link-target") &&
      [...sensitiveKinds(t.resolved.path)].some((k) => SECRET_KINDS.has(k))
    ) {
      return t.raw;
    }
  }
  if (isEnvDump(cmd)) return "environment variables";
  if (keychainPasswordRead(cmd)) return "keychain passwords";
  if (/^gpg2?$/.test(cmd.name) && cmd.argv.some((a) => /^--export-secret-(?:sub)?keys$/.test(a)))
    return "GPG secret keys";
  if (/^(?:echo|printf|print|cat)$/.test(cmd.name)) {
    const vars = secretVars(cmd);
    if (vars.length > 0) return `$${vars[0]}`;
  }
  return undefined;
}

function hasRemoteOperand(cmd: ShellCommand): boolean {
  return operands(cmd).some(
    (o) =>
      /^(?:[\w.-]+@)?[\w.-]+:(?!\/\/)/.test(o.value) ||
      /^(?:rsync|sftp|ftp|scp):\/\//.test(o.value),
  );
}

function isNetworkSink(cmd: ShellCommand): boolean {
  if (cmd.redirects.some((r) => isNetworkDevice(r.target))) return true;
  if (!NETWORK_SINKS.has(cmd.name)) return false;
  if (cmd.name === "rsync") return hasRemoteOperand(cmd);
  return true;
}

function readsStdinAsCode(cmd: ShellCommand): boolean {
  if (SHELL_NAMES.has(cmd.name))
    return (
      shellPayload(cmd.argv) === undefined &&
      !shellScriptOperand(cmd.argv) &&
      cmd.stdinText === undefined
    );
  const call = interpreterCall(cmd);
  return (
    call !== undefined &&
    call.family !== "osascript" &&
    call.inlineCode === undefined &&
    call.script === undefined &&
    call.module === undefined
  );
}

function isCodeExecutor(cmd: ShellCommand): boolean {
  return (
    SHELL_NAMES.has(cmd.name) ||
    interpreterCall(cmd) !== undefined ||
    cmd.name === "eval" ||
    cmd.name === "source" ||
    cmd.name === "."
  );
}

function isDecoder(cmd: ShellCommand): boolean {
  switch (cmd.name) {
    case "base64":
    case "base32":
    case "gbase64":
      return hasFlag(cmd, "dD", ["--decode"]);
    case "xxd":
      return hasFlag(cmd, "r", ["-revert"]);
    case "openssl":
      return /^(?:enc|base64)$/.test(cmd.argv[1] ?? "") && cmd.argv.includes("-d");
    case "tr":
    case "rev":
    case "uudecode":
    case "gunzip":
    case "zcat":
    case "gzcat":
      return true;
    case "printf":
    case "echo":
      return cmd.argv.some((a) => /\\x[0-9a-f]{2}|\\[0-7]{3}/i.test(a));
    default:
      return false;
  }
}

// ── Hardline (never allowed) ────────────────────────────────────────────────

const RM_ROOT = info(
  "shell.hardline.rm-root",
  "destructive",
  "deny",
  "critical",
  "Deletes the root filesystem",
);
const RM_SYSTEM = info(
  "shell.hardline.rm-system-dir",
  "destructive",
  "deny",
  "critical",
  "Deletes a system directory",
);
const RM_HOME = info(
  "shell.hardline.rm-home",
  "destructive",
  "deny",
  "critical",
  "Deletes your home directory",
);

const FIND_FILTERS_RE =
  /^-(?:i?name|i?path|i?wholename|i?regex|newer\w*|[amc](?:time|min)|size|user|group|perm|empty|links|inum|samefile|uid|gid)$/;

/** A filter that limits what `find` matches; name patterns that match everything (`-name '*'`) don't. */
function narrowsFind(cmd: ShellCommand): boolean {
  return cmd.argv.some((arg, i) => {
    if (!FIND_FILTERS_RE.test(arg)) return false;
    const value = cmd.argv[i + 1] ?? "";
    if (/^-i?(?:name|path|wholename)$/.test(arg)) return !/^\*+$/.test(value);
    if (/^-i?regex$/.test(arg)) return !/^\^?(?:\.\*)+\$?$/.test(value);
    return true;
  });
}

/**
 * What a deletion removes wholesale: rm operands, the roots of an unfiltered `find -delete` /
 * `find -exec rm`, or the roots of an unfiltered `find` piped into `xargs rm`.
 */
function deletionRoots(cmd: ShellCommand, env: ShellEnv): Target[] {
  if (DELETE_NAMES.has(cmd.name) && cmd.name !== "rmdir") {
    const direct = targets(cmd, env).filter((t) => t.role === "delete");
    if (!cmd.wrappers.includes("xargs")) return direct;
    const find = feeders(cmd, env).find((f) => f.name === "find");
    return find && !narrowsFind(find) ? [...direct, ...findRoots(find, env)] : direct;
  }
  const deletes =
    cmd.name === "find" &&
    (cmd.argv.includes("-delete") ||
      env.analysis.commands.some(
        (c) => c.parent === cmd && c.via === "find-exec" && DELETE_NAMES.has(c.name),
      ));
  if (deletes && !narrowsFind(cmd)) return findRoots(cmd, env);
  return [];
}

function findRoots(cmd: ShellCommand, env: ShellEnv, role: PathRole = "delete"): Target[] {
  const roots: Target[] = [];
  for (let i = 1; i < cmd.argv.length; i++) {
    const arg = cmd.argv[i]!;
    if (arg.startsWith("-") || arg === "(" || arg === "!") break;
    roots.push({
      raw: arg,
      role,
      resolved: cmd.dynamicArgs[i] ? { location: "unknown", path: arg } : env.resolve(arg, cmd),
    });
  }
  if (roots.length === 0) roots.push({ raw: ".", role, resolved: env.resolve(".", cmd) });
  return roots;
}

/** Commands that emit or copy the contents of the files they are given (not counts or hashes). */
const CONTENT_READERS: ReadonlySet<string> = new Set([
  "cat",
  "bat",
  "head",
  "tail",
  "less",
  "more",
  "nl",
  "tac",
  "rev",
  "strings",
  "od",
  "xxd",
  "hexdump",
  "base64",
  "base32",
  "grep",
  "egrep",
  "fgrep",
  "rg",
  "ag",
  "ack",
  "awk",
  "gawk",
  "mawk",
  "nawk",
  "cut",
  "sort",
  "uniq",
  "cp",
  "rsync",
  "tar",
  "zip",
]);

/** True when `cmd`'s output becomes `ancestor`'s arguments through `$(…)` (not `<(…)`, which is a file of names). */
function substitutedInto(cmd: ShellCommand, ancestor: ShellCommand): boolean {
  for (let c: ShellCommand | undefined = cmd; c?.parent; c = c.parent) {
    if (c.via !== "substitution") return false;
    if (c.parent === ancestor) return true;
  }
  return false;
}

/**
 * The paths a command prints for another to open: `find`/`fd` roots (standing for everything under
 * them), the whole disk for `locate`/`mdfind`, or the paths `echo` and `printf` are given. (`ls`
 * prints names relative to the folder it lists, so its operands aren't what gets opened.)
 */
function listedPaths(cmd: ShellCommand, env: ShellEnv): Target[] {
  const read = (raw: string, dynamic = false): Target => ({
    raw,
    role: "read",
    resolved: dynamic ? { location: "unknown", path: raw } : env.resolve(raw, cmd),
  });
  const pathOperands = (skip: number) =>
    operands(cmd)
      .slice(skip)
      .filter((o) => looksLikePath(o.value))
      .map((o) => read(o.value, o.dynamic));
  switch (cmd.name) {
    case "find":
      return findRoots(cmd, env, "read");
    case "fd":
    case "fdfind": {
      const roots = operands(cmd).slice(1);
      return roots.length > 0 ? roots.map((o) => read(o.value, o.dynamic)) : [read(".")];
    }
    case "mdfind": {
      const dirs = optionValues(cmd, null, ["-onlyin"]);
      return (dirs.length > 0 ? dirs : ["/"]).map((dir) => read(dir));
    }
    case "locate":
    case "plocate":
      return [read("/")];
    case "echo":
      return pathOperands(0);
    case "printf":
      return pathOperands(1);
    default:
      return [];
  }
}

/**
 * The paths a reader gets as arguments from another command, whose files it then reads:
 * `find … -exec cat {} +`, `find … | xargs grep`, `cat $(find …)`, `echo ~/.* | xargs cat`, also
 * inside `sh -c`. A reader that only gets a listing on stdin reads names, not files.
 */
function fedReadTargets(
  cmd: ShellCommand,
  env: ShellEnv,
): Array<{ target: Target; evidence: string }> {
  if (!CONTENT_READERS.has(cmd.name)) return [];
  const sources = new Set<ShellCommand>();
  const out: Array<{ target: Target; evidence: string }> = [];
  for (let c: ShellCommand | undefined = cmd; c; c = c.parent) {
    if (c.via === "find-exec" && c.parent?.name === "find") sources.add(c.parent);
    const xargs = c.wrappers.includes("xargs");
    for (const other of env.analysis.commands) {
      if (other === c) continue;
      const piped = xargs && other.pipeline === c.pipeline && other.position < c.position;
      if (piped || substitutedInto(other, c)) sources.add(other);
    }
    if (xargs && c.stdinText !== undefined) {
      for (const word of c.stdinText.split(/\s+/).filter(looksLikePath)) {
        const target: Target = { raw: word, role: "read", resolved: env.resolve(word, c) };
        out.push({ target, evidence: `${code(word)} → ${cmd.name}` });
      }
    }
    if (c.via !== "shell-c" && c.via !== "eval") break;
  }
  for (const source of sources) {
    for (const target of listedPaths(source, env))
      out.push({ target, evidence: `${display(source)} → ${cmd.name}` });
  }
  return out;
}

export const SHELL_HARDLINE_RULES: readonly ShellRule[] = [
  ...(
    [
      ["root", RM_ROOT],
      ["system", RM_SYSTEM],
      ["home", RM_HOME],
    ] as const
  ).map(([kind, meta]) =>
    rule(meta, (cmd, env) => {
      const t = deletionRoots(cmd, env).find(
        (d) =>
          d.resolved.location !== "unknown" &&
          catastrophicTarget(d.resolved.path, env.home) === kind,
      );
      return t ? display(cmd) : null;
    }),
  ),
  rule(
    info(
      "shell.hardline.format-disk",
      "destructive",
      "deny",
      "critical",
      "Formats or erases a disk",
    ),
    (cmd) => {
      if (/^(?:mkfs(?:\.\w+)?|newfs(?:_\w+)?|wipefs)$/.test(cmd.name)) return display(cmd);
      if (
        cmd.name === "diskutil" &&
        /^(?:erasedisk|erasevolume|reformat|zerodisk|randomdisk|secureerase|partitiondisk)$/i.test(
          cmd.argv[1] ?? "",
        )
      )
        return display(cmd);
      if (
        cmd.name === "diskutil" &&
        cmd.argv[1] === "apfs" &&
        /^(?:deletecontainer|erasevolume)$/i.test(cmd.argv[2] ?? "")
      )
        return display(cmd);
      if (cmd.name === "sgdisk" && hasFlag(cmd, "Z", ["--zap-all"])) return display(cmd);
      return null;
    },
  ),
  rule(
    info(
      "shell.hardline.raw-device-write",
      "destructive",
      "deny",
      "critical",
      "Writes directly to a raw disk device",
    ),
    (cmd, env) => {
      const device = /^\/dev\/(?:sd|nvme|hd|mmcblk|vd|xvd|disk|rdisk)[a-z0-9]*$/i;
      return targets(cmd, env).some((t) => t.role === "write" && device.test(t.resolved.path))
        ? display(cmd)
        : null;
    },
  ),
  rule(
    info(
      "shell.hardline.kill-all",
      "system",
      "deny",
      "critical",
      "Kills every process on the machine",
    ),
    (cmd) => {
      if (cmd.name !== "kill") return null;
      const target = cmd.argv.at(-1);
      return cmd.argv.length > 1 && (target === "-1" || target === "1") ? display(cmd) : null;
    },
  ),
  rule(
    info(
      "shell.hardline.shutdown",
      "system",
      "deny",
      "critical",
      "Shuts down or reboots the machine",
    ),
    (cmd) => {
      if (/^(?:shutdown|reboot|halt|poweroff)$/.test(cmd.name)) return display(cmd);
      if (/^(?:init|telinit)$/.test(cmd.name) && /^[06]$/.test(cmd.argv[1] ?? ""))
        return display(cmd);
      if (cmd.name === "systemctl" && /^(?:poweroff|reboot|halt|kexec)$/.test(cmd.argv[1] ?? ""))
        return display(cmd);
      if (cmd.name === "launchctl" && cmd.argv[1] === "reboot") return display(cmd);
      if (cmd.name === "osascript" && /\b(?:shut down|restart)\b/i.test(cmd.argv.join(" ")))
        return display(cmd);
      return null;
    },
  ),
  rule(
    info(
      "shell.hardline.sudo-stdin",
      "credentials",
      "deny",
      "critical",
      "Pipes a password into sudo",
    ),
    (cmd) => (cmd.sudoStdin ? display(cmd) : null),
  ),
];

// ── Secrets ─────────────────────────────────────────────────────────────────

const KEYCHAIN_DUMP = info(
  "secrets.keychain-dump",
  "credentials",
  "deny",
  "critical",
  "Dumps passwords from the macOS keychain",
);
const EXFILTRATION = info(
  "secrets.exfiltration",
  "credentials",
  "deny",
  "critical",
  "Sends secrets (keys, .env files, credentials, environment variables) over the network",
);

export const SHELL_SECRET_RULES: readonly ShellRule[] = [
  rule(KEYCHAIN_DUMP, (cmd) => (keychainPasswordRead(cmd) ? display(cmd) : null)),
  rule(
    info("secrets.gpg-export", "credentials", "deny", "critical", "Exports GPG secret keys"),
    (cmd) =>
      /^gpg2?$/.test(cmd.name) && cmd.argv.some((a) => /^--export-secret-(?:sub)?keys$/.test(a))
        ? display(cmd)
        : null,
  ),
  rule(EXFILTRATION, (cmd, env) => {
    if (!isNetworkSink(cmd)) return null;
    const direct = secretSource(cmd, env);
    if (direct) return `${direct} → ${cmd.name}`;
    for (const feeder of feeders(cmd, env)) {
      const source = secretSource(feeder, env);
      if (source) return `${source} → ${cmd.name}`;
    }
    return null;
  }),
  rule(
    info(
      "credentials.secret-and-network",
      "credentials",
      "require_approval",
      "critical",
      "Reads secrets and uses the network in the same command",
    ),
    (cmd, env) => {
      if (!isNetworkSink(cmd)) return null;
      const source = env.analysis.commands.map((c) => secretSource(c, env)).find(Boolean);
      return source ? `${source} and ${cmd.name}` : null;
    },
  ),
];

// ── Everything that needs approval ──────────────────────────────────────────

function deleteRisk(t: Target, recursive: boolean): "medium" | "high" | "critical" {
  if (isUserDataPath(t.resolved.path)) return "critical";
  return recursive || /[*?]/.test(t.raw) ? "high" : "medium";
}

/** Targets of an rm run by `find -exec` / `xargs`: the find roots feeding it, when known. */
function indirectDeleteTargets(cmd: ShellCommand, env: ShellEnv): Target[] | undefined {
  if (cmd.via === "find-exec" && cmd.parent?.name === "find") return findRoots(cmd.parent, env);
  if (cmd.wrappers.includes("xargs")) {
    const find = feeders(cmd, env).find((f) => f.name === "find");
    return find
      ? findRoots(find, env)
      : [
          {
            raw: "(arguments from stdin)",
            role: "delete",
            resolved: { location: "unknown", path: "stdin" },
          },
        ];
  }
  return undefined;
}

const INSTALL_SUBCOMMANDS: ReadonlyMap<string, RegExp> = new Map([
  ["brew", /^(?:install|reinstall|upgrade|tap|bundle|link|cask|services|update)$/],
  [
    "npm",
    /^(?:install|i|in|ins|inst|insta|instal|isnt|isnta|isntal|add|ci|update|up|upgrade|udpate|rebuild|link|exec|x|create|init)$/,
  ],
  ["pnpm", /^(?:install|i|add|update|up|upgrade|dlx|create|import|link|rebuild)$/],
  ["yarn", /^(?:add|install|upgrade|up|global|dlx|create|import)$|^$/],
  ["bun", /^(?:install|i|add|update|x|create)$/],
  ["pip", /^(?:install|download|wheel)$/],
  ["pip3", /^(?:install|download|wheel)$/],
  ["pipx", /^(?:install|run|inject|upgrade|reinstall)$/],
  ["uv", /^(?:pip|tool|add|sync|run)$/],
  ["poetry", /^(?:add|install|update)$/],
  ["conda", /^(?:install|create|update)$/],
  ["mamba", /^(?:install|create|update)$/],
  ["gem", /^(?:install|update)$/],
  ["cargo", /^(?:install)$/],
  ["go", /^(?:install|get)$/],
  ["apt", /^(?:install|upgrade|full-upgrade|dist-upgrade|update)$/],
  ["apt-get", /^(?:install|upgrade|dist-upgrade|update)$/],
  ["yum", /^(?:install|update|upgrade)$/],
  ["dnf", /^(?:install|update|upgrade)$/],
  ["pacman", /^-S/],
  ["zypper", /^(?:install|in|update|up)$/],
  ["apk", /^(?:add|upgrade)$/],
  ["port", /^(?:install|upgrade|selfupdate)$/],
  ["snap", /^(?:install|refresh)$/],
  ["flatpak", /^(?:install|update)$/],
  ["mas", /^(?:install|upgrade|purchase)$/],
  ["composer", /^(?:require|install|update|global|create-project)$/],
  ["rustup", /^(?:install|toolchain|component|target|update)$/],
  ["nvm", /^(?:install)$/],
  ["asdf", /^(?:install|plugin)$/],
  ["deno", /^(?:install)$/],
  ["dotnet", /^(?:tool|add)$/],
  ["luarocks", /^(?:install)$/],
  ["code", /^--install-extension$/],
]);
const ALWAYS_INSTALL: ReadonlySet<string> = new Set([
  "npx",
  "pnpx",
  "bunx",
  "uvx",
  "cpanm",
  "cpan",
  "installer",
]);

function installMatch(cmd: ShellCommand): Match {
  if (ALWAYS_INSTALL.has(cmd.name)) return { evidence: display(cmd), risk: "high" };
  if (cmd.name === "softwareupdate" && hasFlag(cmd, "ia", ["--install", "--all"]))
    return { evidence: display(cmd), risk: "high" };
  if (cmd.name === "xcode-select" && cmd.argv.includes("--install"))
    return { evidence: display(cmd), risk: "medium" };
  const call = interpreterCall(cmd);
  if (call?.family === "python" && call.module === "pip" && cmd.argv.includes("install"))
    return { evidence: display(cmd), risk: "high" };
  const pattern = INSTALL_SUBCOMMANDS.get(cmd.name);
  if (!pattern) return null;
  const verb =
    cmd.name === "code" ? (cmd.argv.find((a) => a === "--install-extension") ?? "") : sub(cmd);
  if (!pattern.test(verb)) return null;
  if (cmd.name === "uv" && verb === "run") return null;
  const global =
    hasFlag(cmd, "g", ["--global", "--system", "--user"]) ||
    cmd.argv.includes("--location=global") ||
    cmd.sudo;
  const system =
    /^(?:brew|apt|apt-get|yum|dnf|pacman|zypper|apk|port|snap|flatpak|mas|gem|cargo|go|pipx|rustup|nvm|asdf)$/.test(
      cmd.name,
    );
  return {
    evidence: display(cmd),
    risk:
      global || system || /^(?:pip3?)$/.test(cmd.name) || /^(?:dlx|x|exec|create|init)$/.test(verb)
        ? "high"
        : "medium",
  };
}

/** World-writable or setuid/setgid modes (`777`, `o+w`, `4755`, `u+s`). */
function looseMode(mode: string): boolean {
  if (/^[0-7]{3,4}$/.test(mode)) {
    const digits = mode.padStart(4, "0");
    return (Number(digits[3]) & 2) !== 0 || (Number(digits[0]) & 6) !== 0;
  }
  return mode.split(",").some((clause) => {
    const m = /^([ugoa]*)[+=]([rwxXst]*)$/.exec(clause);
    if (!m) return false;
    const who = m[1] || "a";
    return (/[oa]/.test(who) && m[2]!.includes("w")) || m[2]!.includes("s");
  });
}

function gitVerb(cmd: ShellCommand): string {
  return sub(cmd);
}

function gitDiscard(cmd: ShellCommand): boolean {
  if (cmd.name !== "git") return false;
  const verb = gitVerb(cmd);
  const args = cmd.argv.slice(cmd.argv.indexOf(verb) + 1);
  switch (verb) {
    case "reset":
      return args.some(
        (a) => /^--h(?:a(?:r(?:d)?)?)?$/.test(a) || a === "--merge" || a === "--keep",
      );
    case "clean":
      return (
        args.some((a) => /^-[a-zA-Z]*f/.test(a) || a === "--force") &&
        !args.some((a) => /^-[a-zA-Z]*n/.test(a) || a === "--dry-run")
      );
    case "checkout":
      return (
        args.includes("--") || args.includes(".") || args.includes("-f") || args.includes("--force")
      );
    case "restore":
      return !args.some((a) => a === "--staged" || a === "-S");
    case "stash":
      return /^(?:drop|clear)$/.test(args[0] ?? "");
    case "branch":
      return (
        args.some((a) => a === "-D") ||
        (args.some((a) => a === "-d" || a === "--delete") &&
          args.some((a) => a === "-f" || a === "--force"))
      );
    case "reflog":
      return /^(?:expire|delete)$/.test(args[0] ?? "");
    case "filter-branch":
    case "filter-repo":
      return true;
    case "update-ref":
      return args.includes("-d");
    default:
      return false;
  }
}

function gitForcePush(cmd: ShellCommand): boolean {
  if (cmd.name !== "git" || gitVerb(cmd) !== "push") return false;
  const args = cmd.argv.slice(cmd.argv.indexOf("push") + 1);
  return args.some(
    (a) =>
      /^--force(?:-with-lease|-if-includes)?(?:=|$)/.test(a) ||
      /^-[a-zA-Z]*f/.test(a) ||
      a === "--mirror" ||
      a === "--delete" ||
      a === "-d" ||
      /^\+/.test(a) ||
      /^:[^/]/.test(a),
  );
}

const DB_CLIENTS =
  /^(?:psql|mysql|mariadb|sqlite3|sqlcmd|mongo|mongosh|redis-cli|clickhouse(?:-client)?|duckdb|cockroach|snowsql|bq|cqlsh|influx|pgcli|mycli|litecli)$/;

function httpCategoryHosts(cmd: ShellCommand, hosts: RegExp): string | undefined {
  const request = httpRequestOf(cmd);
  if (!request || (!request.sendsData && /^(?:GET|HEAD|OPTIONS)$/.test(request.method)))
    return undefined;
  for (const raw of request.urls) {
    const host = parseUrl(withScheme(raw))?.host;
    if (host && hosts.test(host)) return host;
  }
  return undefined;
}

const MESSAGING_HOSTS =
  /(?:^|\.)(?:hooks\.slack\.com|slack\.com|discord(?:app)?\.com|api\.twilio\.com|api\.sendgrid\.com|api\.mailgun\.net|api\.postmarkapp\.com|api\.resend\.com|graph\.microsoft\.com|gmail\.googleapis\.com|api\.telegram\.org|graph\.facebook\.com|api\.pushover\.net|ntfy\.sh)$/;
const PAYMENT_HOSTS =
  /(?:^|\.)(?:api\.stripe\.com|api(?:-m)?\.paypal\.com|connect\.squareup\.com|api\.wise\.com|api\.coinbase\.com|api\.braintreegateway\.com|checkout\.stripe\.com)$/;
const SOCIAL_HOSTS =
  /(?:^|\.)(?:api\.twitter\.com|api\.x\.com|api\.linkedin\.com|bsky\.social|oauth\.reddit\.com|api\.reddit\.com|graph\.instagram\.com|api\.medium\.com|api\.github\.com)$/;

export const SHELL_APPROVAL_RULES: readonly ShellRule[] = [
  rule(
    info(
      "destructive.rm-outside-workspace",
      "destructive",
      "require_approval",
      "high",
      "Deletes files outside the task workspace",
    ),
    (cmd, env) => {
      if (!DELETE_NAMES.has(cmd.name)) return null;
      const recursive = hasFlag(cmd, "rR", ["--recursive"]);
      const direct = targets(cmd, env).filter((t) => t.role === "delete");
      const indirect = indirectDeleteTargets(cmd, env);
      const outside = (indirect ?? direct).find(
        (t) => t.resolved.location === "outside" || t.resolved.location === "unknown",
      );
      if (!outside) return null;
      const catastrophic = catastrophicTarget(outside.resolved.path, env.home) !== null;
      // Direct deletions of these are hard denies; a filtered `find` feeding rm still reaches into them.
      if (catastrophic && indirect === undefined) return null;
      return {
        evidence: display(cmd),
        risk: catastrophic ? "critical" : deleteRisk(outside, recursive),
      };
    },
  ),
  rule(
    info(
      "destructive.unsafe-variable-path",
      "destructive",
      "require_approval",
      "critical",
      "Deletes a path built from a variable that could expand to your home or root folder",
    ),
    (cmd, env) => {
      if (!DELETE_NAMES.has(cmd.name)) return null;
      for (const [i, arg] of cmd.argv.entries()) {
        if (!cmd.dynamicArgs[i]) continue;
        const prefix = arg.split(/\$[{(]?/)[0] ?? "";
        if (prefix === "" || prefix.startsWith("-")) continue;
        const resolved = env.resolve(prefix, cmd);
        if (resolved.location !== "unknown" && catastrophicTarget(resolved.path, env.home))
          return display(cmd);
      }
      return null;
    },
  ),
  rule(
    info(
      "destructive.find-delete",
      "destructive",
      "require_approval",
      "high",
      "Deletes files found outside the task workspace",
    ),
    (cmd, env) => {
      if (cmd.name !== "find" || !cmd.argv.includes("-delete")) return null;
      const root = findRoots(cmd, env).find(
        (t) => t.resolved.location === "outside" || t.resolved.location === "unknown",
      );
      if (!root) return null;
      if (catastrophicTarget(root.resolved.path, env.home) === null) return display(cmd);
      // Unfiltered, this is a hard deny; filtered, it still deletes inside home/root/system dirs.
      return narrowsFind(cmd) ? { evidence: display(cmd), risk: "critical" } : null;
    },
  ),
  rule(
    info(
      "destructive.move-outside",
      "destructive",
      "require_approval",
      "medium",
      "Moves files away from their place outside the task workspace",
    ),
    (cmd, env) => {
      if (cmd.name !== "mv") return null;
      const moved = targets(cmd, env).find(
        (t) =>
          t.role === "delete" &&
          (t.resolved.location === "outside" || t.resolved.location === "unknown"),
      );
      return moved ? display(cmd) : null;
    },
  ),
  rule(
    info(
      "destructive.git-discard",
      "destructive",
      "require_approval",
      "medium",
      "Discards uncommitted work or rewrites git history",
    ),
    (cmd) => (gitDiscard(cmd) ? display(cmd) : null),
  ),
  rule(
    info(
      "destructive.git-force-push",
      "destructive",
      "require_approval",
      "high",
      "Force-pushes or deletes remote git history",
    ),
    (cmd) => (gitForcePush(cmd) ? display(cmd) : null),
  ),
  rule(DESTRUCTIVE_SQL_RULE, (cmd, env) => {
    const isDb = DB_CLIENTS.test(cmd.name);
    const inline = interpreterCall(cmd)?.inlineCode;
    if (!isDb && inline === undefined) return null;
    if (cmd.name === "sqlite3") {
      const db = operands(cmd)[0];
      if (
        db &&
        (db.value === ":memory:" ||
          ["workspace", "temp"].includes(env.resolve(db.value, cmd).location))
      )
        return null;
    }
    const sql = destructiveSqlInText([...cmd.argv.slice(1), cmd.stdinText ?? ""].join("\n"));
    return sql ? `${sql.label} via ${cmd.name}` : null;
  }),
  rule(
    info(
      "destructive.containers",
      "destructive",
      "require_approval",
      "high",
      "Deletes containers, images, volumes or cluster resources",
    ),
    (cmd) => {
      const args = cmd.argv
        .slice(1)
        .filter((a) => !a.startsWith("-"))
        .join(" ");
      if (
        (cmd.name === "docker" || cmd.name === "podman") &&
        /^(?:rm|rmi|kill|(?:system|image|container|volume|network|builder) (?:prune|rm)|compose down)\b/.test(
          args,
        )
      ) {
        if (!/^compose down/.test(args) || hasFlag(cmd, "v", ["--volumes", "--rmi"]))
          return display(cmd);
      }
      if (cmd.name === "kubectl" && /^(?:delete|drain)\b/.test(args)) return display(cmd);
      if (cmd.name === "helm" && /^(?:uninstall|delete)\b/.test(args)) return display(cmd);
      if (/^(?:terraform|tofu|pulumi)$/.test(cmd.name) && /^(?:destroy|state rm)\b/.test(args))
        return display(cmd);
      return null;
    },
  ),
  rule(
    info(
      "destructive.keychain-delete",
      "destructive",
      "require_approval",
      "high",
      "Deletes keychain items",
    ),
    (cmd) => (cmd.name === "security" && /^delete-/.test(cmd.argv[1] ?? "") ? display(cmd) : null),
  ),
  rule(
    info(
      "destructive.package-uninstall",
      "destructive",
      "require_approval",
      "medium",
      "Uninstalls software",
    ),
    (cmd) => {
      const verb = sub(cmd);
      if (
        /^(?:npm|pnpm|yarn|bun)$/.test(cmd.name) &&
        /^(?:uninstall|remove|rm|un|r|unlink)$/.test(verb) &&
        hasFlag(cmd, "g", ["--global"])
      )
        return display(cmd);
      if (cmd.name === "brew" && /^(?:uninstall|remove|rm|untap|autoremove)$/.test(verb))
        return display(cmd);
      if (/^(?:pip|pip3|pipx|gem|cargo|port|mas)$/.test(cmd.name) && /^uninstall$/.test(verb))
        return display(cmd);
      if (
        /^(?:apt|apt-get|yum|dnf|zypper|apk|snap|flatpak)$/.test(cmd.name) &&
        /^(?:remove|purge|autoremove|erase|del|uninstall)$/.test(verb)
      )
        return display(cmd);
      return null;
    },
  ),
  rule(
    info(
      "destructive.crontab-remove",
      "destructive",
      "require_approval",
      "medium",
      "Removes all your scheduled jobs",
    ),
    (cmd) => (cmd.name === "crontab" && hasFlag(cmd, "r") ? display(cmd) : null),
  ),

  rule(
    info(
      "file_write.symlink-outside",
      "file_write",
      "require_approval",
      "medium",
      "Creates a link that points outside the task workspace",
    ),
    (cmd, env) => {
      if (cmd.name !== "ln") return null;
      const target = targets(cmd, env).find(
        (t) => t.role === "link-target" && t.resolved.location !== "workspace",
      );
      return target ? display(cmd) : null;
    },
  ),

  rule(
    info(
      "system.privilege-escalation",
      "system",
      "require_approval",
      "high",
      "Runs with administrator (root) privileges",
    ),
    (cmd) => {
      if (cmd.sudo || /^(?:su|pkexec|runas|dzdo)$/.test(cmd.name)) return display(cmd);
      if (cmd.name === "osascript" && /with administrator privileges/i.test(cmd.argv.join(" ")))
        return display(cmd);
      return null;
    },
  ),
  rule(
    info(
      "system.software-install",
      "system",
      "require_approval",
      "high",
      "Installs or updates software",
    ),
    installMatch,
  ),
  rule(
    info(
      "system.remote-code",
      "system",
      "require_approval",
      "critical",
      "Runs code downloaded from the internet",
    ),
    (cmd, env) => {
      if (!isCodeExecutor(cmd)) return null;
      const downloader = feeders(cmd, env).find((f) => DOWNLOADERS.has(f.name));
      return downloader ? `${downloader.name} → ${cmd.name}` : null;
    },
  ),
  rule(
    info(
      "system.obfuscated-exec",
      "system",
      "require_approval",
      "critical",
      "Runs decoded or obfuscated code",
    ),
    (cmd, env) => {
      if (!isCodeExecutor(cmd)) return null;
      const decoder = feeders(cmd, env).find(isDecoder);
      return decoder ? `${decoder.name} → ${cmd.name}` : null;
    },
  ),
  rule(
    info(
      "system.pipe-to-interpreter",
      "system",
      "require_approval",
      "high",
      "Runs commands piped into a shell or interpreter",
    ),
    (cmd, env) => {
      if (cmd.position === 0 || !readsStdinAsCode(cmd)) return null;
      const feeding = feeders(cmd, env);
      return feeding.some((f) => DOWNLOADERS.has(f.name) || isDecoder(f)) ? null : display(cmd);
    },
  ),
  rule(
    info(
      "system.dynamic-eval",
      "system",
      "require_approval",
      "high",
      "Evaluates code that is computed at runtime or sourced from outside the workspace",
    ),
    (cmd, env) => {
      if (cmd.name === "eval" && cmd.dynamicArgs.slice(1).some(Boolean)) return display(cmd);
      if (cmd.name === "source" || cmd.name === ".") {
        const file = cmd.argv[1];
        if (file === undefined) return null;
        if (
          /(?:^|\/)bin\/activate(?:\.\w+)?$/.test(file) &&
          env.resolve(file, cmd).location === "workspace"
        )
          return null;
        const where = cmd.dynamicArgs[1] ? "unknown" : env.resolve(file, cmd).location;
        return where === "workspace" || where === "temp" ? null : display(cmd);
      }
      return null;
    },
  ),
  rule(
    info(
      "system.persistence",
      "system",
      "require_approval",
      "high",
      "Changes background services, scheduled jobs or system defaults",
    ),
    (cmd) => {
      const verb = cmd.argv[1] ?? "";
      if (
        cmd.name === "launchctl" &&
        !/^(?:list|print|print-disabled|blame|managerpid|manageruid|version|help|getenv|error)$/.test(
          verb,
        )
      )
        return display(cmd);
      if (cmd.name === "crontab" && !hasFlag(cmd, "lr")) return display(cmd);
      if (cmd.name === "defaults" && /^(?:write|delete|import|rename)$/.test(verb))
        return display(cmd);
      if (
        cmd.name === "systemctl" &&
        !/^(?:status|show|list-\w+|is-\w+|cat|help|--version)$/.test(verb)
      )
        return display(cmd);
      if (cmd.name === "service" && /^(?:start|stop|restart|reload)$/.test(cmd.argv[2] ?? ""))
        return display(cmd);
      if (/^(?:at|batch)$/.test(cmd.name) && !hasFlag(cmd, "l")) return display(cmd);
      return null;
    },
  ),
  rule(
    info(
      "system.permissions",
      "system",
      "require_approval",
      "high",
      "Loosens file permissions, changes ownership or disables macOS protections",
    ),
    (cmd, env) => {
      if (/^(?:chmod|chown|chgrp|chflags)$/.test(cmd.name)) {
        if (cmd.name === "chmod" && looseMode(operands(cmd)[0]?.value ?? "")) return display(cmd);
        const outside = targets(cmd, env).find(
          (t) =>
            t.role === "meta" &&
            t.resolved.location !== "workspace" &&
            t.resolved.location !== "temp",
        );
        return outside ? display(cmd) : null;
      }
      if (cmd.name === "xattr" && (cmd.argv.includes("com.apple.quarantine") || hasFlag(cmd, "c")))
        return display(cmd);
      if (
        cmd.name === "spctl" &&
        cmd.argv.some((a) => /^--(?:master-disable|global-disable|add|disable)$/.test(a))
      )
        return display(cmd);
      if (cmd.name === "csrutil" && /^(?:disable|authenticated-root)$/.test(cmd.argv[1] ?? ""))
        return display(cmd);
      return null;
    },
  ),
  rule(
    info(
      "system.process-control",
      "system",
      "require_approval",
      "medium",
      "Stops running programs",
    ),
    (cmd) => (/^(?:kill|pkill|killall|taskkill|xkill)$/.test(cmd.name) ? display(cmd) : null),
  ),
  rule(
    info(
      "system.app-automation",
      "system",
      "require_approval",
      "high",
      "Scripts other apps on your Mac (AppleScript, Shortcuts)",
    ),
    (cmd) =>
      /^(?:osascript|automator|shortcuts)$/.test(cmd.name) &&
      !(cmd.name === "shortcuts" && /^(?:list|view|help)$/.test(cmd.argv[1] ?? ""))
        ? display(cmd)
        : null,
  ),
  rule(
    info(
      "communication.app-automation-message",
      "communication",
      "require_approval",
      "high",
      "Sends a message or email through another app",
    ),
    (cmd) =>
      cmd.name === "osascript" &&
      /\b(?:send|messages|imessage|mail|outgoing message|buddy|chat)\b/i.test(cmd.argv.join(" "))
        ? display(cmd)
        : null,
  ),
  rule(
    info(
      "system.remote-access",
      "system",
      "require_approval",
      "high",
      "Runs commands on another machine or inside a container",
    ),
    (cmd) => {
      if (/^(?:ssh|mosh|rsh|rlogin)$/.test(cmd.name) && operands(cmd).length > 0)
        return display(cmd);
      if (cmd.name === "telnet" && operands(cmd).length > 0) return display(cmd);
      const args = cmd.argv.slice(1).join(" ");
      if (
        (cmd.name === "docker" || cmd.name === "podman" || cmd.name === "kubectl") &&
        /^exec\b/.test(args)
      )
        return display(cmd);
      if (cmd.name === "gcloud" && /\bcompute ssh\b/.test(args)) return display(cmd);
      if (cmd.name === "aws" && /\bssm start-session\b/.test(args)) return display(cmd);
      return null;
    },
  ),
  rule(
    info(
      "system.config-change",
      "system",
      "require_approval",
      "high",
      "Changes system, network or global tool configuration",
    ),
    (cmd) => {
      const args = cmd.argv.slice(1);
      const joined = args.join(" ");
      switch (cmd.name) {
        case "git":
          return args.includes("config") &&
            args.some((a) => a === "--global" || a === "--system") &&
            !args.some((a) => /^--(?:get|get-all|list|get-regexp)$|^-l$/.test(a)) &&
            args.filter((a) => !a.startsWith("-")).length >= 3
            ? display(cmd)
            : null;
        case "npm":
        case "pnpm":
        case "yarn":
        case "pip":
        case "pip3":
          return /^config (?:set|delete|edit)\b/.test(joined) ? display(cmd) : null;
        case "networksetup":
          return args.some((a) => /^-(?:set|add|remove|create|delete|order|switch)/i.test(a))
            ? display(cmd)
            : null;
        case "scutil":
          return args.includes("--set") ? display(cmd) : null;
        case "pmset":
          return args.some((a) => a.startsWith("-g")) ? null : display(cmd);
        case "nvram":
        case "dseditgroup":
        case "sysadminctl":
        case "fdesetup":
        case "pfctl":
        case "kextload":
          return display(cmd);
        case "sysctl":
          return args.some((a) => a === "-w" || /=/.test(a)) ? display(cmd) : null;
        case "dscl":
          return args.some((a) => /^-(?:create|passwd|append|delete|change|merge)$/.test(a))
            ? display(cmd)
            : null;
        case "tmutil":
          return /^(?:delete|disable|removeexclusion|addexclusion|setdestination|removedestination|deletelocalsnapshots)$/.test(
            args[0] ?? "",
          )
            ? display(cmd)
            : null;
        case "ifconfig":
          return args.some((a) =>
            /^(?:up|down|alias|-alias|inet6?|mtu|ether|lladdr|delete)$/.test(a),
          )
            ? display(cmd)
            : null;
        case "route":
          return /^(?:add|delete|change|flush)$/.test(args.find((a) => !a.startsWith("-")) ?? "")
            ? display(cmd)
            : null;
        case "systemsetup":
          return args.some((a) => /^-set/i.test(a)) ? display(cmd) : null;
        case "security":
          return /^(?:add-trusted-cert|add-certificates|authorizationdb|set-keychain-password|set-key-partition-list|import|trust-settings-import)$/.test(
            args[0] ?? "",
          )
            ? display(cmd)
            : null;
        case "profiles":
          return /^(?:install|remove|-I|-R)$/.test(args[0] ?? "") ? display(cmd) : null;
        case "hostname":
          return args.some((a) => !a.startsWith("-")) ? display(cmd) : null;
        default:
          return null;
      }
    },
  ),
  rule(
    info(
      "system.containers",
      "system",
      "require_approval",
      "medium",
      "Starts, stops or changes containers or cloud infrastructure",
    ),
    (cmd) => {
      const args = cmd.argv
        .slice(1)
        .filter((a) => !a.startsWith("-"))
        .join(" ");
      if (
        (cmd.name === "docker" || cmd.name === "podman") &&
        /^(?:run|start|stop|restart|create|build|pull|load|import|cp|commit|login|compose (?:up|down|restart|stop|start|run|build|pull|create)|network create|volume create|buildx)\b/.test(
          args,
        )
      ) {
        return display(cmd);
      }
      if (
        cmd.name === "kubectl" &&
        /^(?:apply|create|edit|patch|replace|scale|rollout|run|expose|label|annotate|set|cp|port-forward|cordon|uncordon|taint|autoscale)\b/.test(
          args,
        )
      )
        return display(cmd);
      if (cmd.name === "helm" && /^(?:install|upgrade|rollback)\b/.test(args)) return display(cmd);
      if (
        /^(?:terraform|tofu)$/.test(cmd.name) &&
        /^(?:apply|import|taint|untaint|state (?:mv|push|replace-provider))\b/.test(args)
      )
        return display(cmd);
      if (cmd.name === "pulumi" && /^(?:up|update|refresh|import)\b/.test(args))
        return display(cmd);
      if (cmd.name === "vagrant" && /^(?:up|destroy|halt|reload|provision)\b/.test(args))
        return display(cmd);
      if (
        /^(?:aws|gcloud|az)$/.test(cmd.name) &&
        !/(?:^| )(?:describe|list|get|show|ls|help|version|configure list|whoami|info|wait|sts get-caller-identity)(?:[- ]|$)/.test(
          args,
        ) &&
        !/^s3 ls\b/.test(args)
      ) {
        return display(cmd);
      }
      return null;
    },
  ),
  rule(
    info(
      "system.open-app",
      "system",
      "require_approval",
      "medium",
      "Opens an app, file or link outside the agent's browser",
    ),
    (cmd) =>
      /^(?:open|xdg-open|start|gio)$/.test(cmd.name) &&
      !(cmd.name === "gio" && cmd.argv[1] !== "open")
        ? display(cmd)
        : null,
  ),
  rule(
    info(
      "system.expose-network",
      "system",
      "require_approval",
      "high",
      "Exposes files or ports on this computer to the network",
    ),
    (cmd) => {
      const joined = cmd.argv.join(" ");
      if (/^(?:ngrok|cloudflared|lt|localtunnel|serveo|bore)$/.test(cmd.name)) return display(cmd);
      if (/^(?:nc|ncat|netcat)$/.test(cmd.name) && hasFlag(cmd, "l", ["--listen"]))
        return display(cmd);
      if (cmd.name === "socat" && /LISTEN/i.test(joined)) return display(cmd);
      if (cmd.name === "ssh" && hasFlag(cmd, "R")) return display(cmd);
      if (
        interpreterCall(cmd)?.module === "http.server" ||
        (cmd.name === "php" && cmd.argv.includes("-S"))
      )
        return { evidence: display(cmd), risk: "medium" };
      return null;
    },
  ),
  rule(
    info("system.disk", "system", "require_approval", "high", "Mounts, unmounts or changes disks"),
    (cmd) => {
      if (cmd.name === "diskutil" && !/^(?:list|info|activity|apfs)$/i.test(cmd.argv[1] ?? ""))
        return display(cmd);
      if (
        cmd.name === "diskutil" &&
        cmd.argv[1] === "apfs" &&
        !/^(?:list|listsnapshots|listcryptousers)$/i.test(cmd.argv[2] ?? "")
      )
        return display(cmd);
      if (
        cmd.name === "hdiutil" &&
        /^(?:attach|detach|create|convert|burn|eject|resize|makehybrid)$/.test(cmd.argv[1] ?? "")
      )
        return display(cmd);
      if (/^(?:mount|umount)$/.test(cmd.name) && cmd.argv.length > 1) return display(cmd);
      return null;
    },
  ),

  rule(
    info(
      "credentials.runtime-folder-read",
      "credentials",
      "require_approval",
      "high",
      "Reads a whole folder chosen when the command runs, which could be your home folder",
    ),
    (cmd, env) => {
      // Files handed over by `find` or `xargs` are checked against where they come from.
      if (cmd.argsFromStdin || !readsFolderTrees(cmd)) return null;
      const runtime = targets(cmd, env).find(
        (t) => t.role === "read" && t.resolved.location === "unknown" && /[$`]/.test(t.raw),
      );
      return runtime ? `${display(cmd)} (${runtime.raw})` : null;
    },
  ),
  rule(
    info(
      "credentials.env-dump",
      "credentials",
      "require_approval",
      "medium",
      "Prints environment variables that may contain API keys",
    ),
    (cmd) => {
      if (isEnvDump(cmd)) return display(cmd);
      if (/^(?:echo|printf|print)$/.test(cmd.name) && secretVars(cmd).length > 0)
        return `$${secretVars(cmd)[0]}`;
      return null;
    },
  ),
  rule(
    info(
      "credentials.secret-in-request",
      "credentials",
      "require_approval",
      "critical",
      "Sends a secret (API key, token, password) in a network request",
    ),
    (cmd) => {
      if (!isNetworkSink(cmd)) return null;
      const vars = secretVars(cmd);
      if (vars.length > 0) return `$${vars[0]} → ${cmd.name}`;
      const literal = findSecrets(cmd.argv.join(" "))[0];
      return literal ? `${literal.label} → ${cmd.name}` : null;
    },
  ),
  rule(
    info(
      "credentials.token-print",
      "credentials",
      "require_approval",
      "high",
      "Prints a stored login token",
    ),
    (cmd) => {
      const joined = cmd.argv.join(" ");
      if (cmd.name === "gh" && /^gh auth (?:token|status .*--show-token)/.test(joined))
        return display(cmd);
      if (
        /^(?:gcloud|az)$/.test(cmd.name) &&
        /\b(?:print-access-token|print-identity-token|get-access-token)\b/.test(joined)
      )
        return display(cmd);
      if (
        cmd.name === "aws" &&
        /\b(?:get-session-token|export-credentials|configure get aws_secret_access_key)\b/.test(
          joined,
        )
      )
        return display(cmd);
      return null;
    },
  ),
  rule(
    info("privacy.clipboard-read", "privacy", "require_approval", "medium", "Reads your clipboard"),
    (cmd) => (cmd.name === "pbpaste" ? display(cmd) : null),
  ),
  rule(
    info(
      "privacy.screen-capture",
      "privacy",
      "require_approval",
      "medium",
      "Captures your screen or camera from the shell",
    ),
    (cmd) => (/^(?:screencapture|imagesnap)$/.test(cmd.name) ? display(cmd) : null),
  ),

  rule(
    info(
      "network.http-write",
      "network",
      "require_approval",
      "medium",
      "Sends data to a web service (POST/PUT/PATCH/DELETE or upload)",
    ),
    (cmd) => {
      const request = httpRequestOf(cmd);
      if (!request) return null;
      if (
        !request.sendsData &&
        request.uploads.length === 0 &&
        /^(?:GET|HEAD|OPTIONS)$/.test(request.method)
      )
        return null;
      return `${request.method} ${request.urls[0] ?? ""} (${request.client})`.trim();
    },
  ),
  rule(
    info(
      "network.code-http-write",
      "network",
      "require_approval",
      "medium",
      "Inline code sends data over the network",
    ),
    (cmd) => {
      const inline = interpreterCall(cmd)?.inlineCode;
      const risky = inline === undefined ? undefined : riskyCodeReason(inline);
      return risky?.networkWrite ? risky.reason : null;
    },
  ),
  rule(
    info(
      "communication.messaging-api",
      "communication",
      "require_approval",
      "high",
      "Posts to a messaging or email service",
    ),
    (cmd) => httpCategoryHosts(cmd, MESSAGING_HOSTS),
  ),
  rule(
    info("payment.payment-api", "payment", "require_approval", "high", "Calls a payment service"),
    (cmd) => httpCategoryHosts(cmd, PAYMENT_HOSTS),
  ),
  rule(
    info(
      "publishing.social-api",
      "publishing",
      "require_approval",
      "high",
      "Posts to a social network or code host",
    ),
    (cmd) => httpCategoryHosts(cmd, SOCIAL_HOSTS),
  ),
  rule(
    info(
      "network.raw-socket",
      "network",
      "require_approval",
      "medium",
      "Opens a raw network connection",
    ),
    (cmd) => {
      if (cmd.redirects.some((r) => isNetworkDevice(r.target))) return display(cmd);
      if (/^(?:nc|ncat|netcat|socat|telnet)$/.test(cmd.name)) return display(cmd);
      if (cmd.name === "openssl" && cmd.argv[1] === "s_client") return display(cmd);
      return null;
    },
  ),
  rule(
    info(
      "network.file-transfer",
      "network",
      "require_approval",
      "high",
      "Copies files to or from another machine or cloud storage",
    ),
    (cmd) => {
      if (/^(?:scp|sftp|ftp|lftp)$/.test(cmd.name) && operands(cmd).length > 0) return display(cmd);
      if (cmd.name === "rsync" && hasRemoteOperand(cmd)) return display(cmd);
      const args = cmd.argv
        .slice(1)
        .filter((a) => !a.startsWith("-"))
        .join(" ");
      if (cmd.name === "aws" && /^s3 (?:cp|sync|mv)\b/.test(args)) return display(cmd);
      if (cmd.name === "gsutil" && /^(?:cp|rsync|mv)\b/.test(args)) return display(cmd);
      if (cmd.name === "rclone" && /^(?:copy|copyto|sync|move|moveto)\b/.test(args))
        return display(cmd);
      if (cmd.name === "s3cmd" && /^(?:put|sync)\b/.test(args)) return display(cmd);
      return null;
    },
  ),
  rule(
    info(
      "communication.shell-message",
      "communication",
      "require_approval",
      "high",
      "Sends email or messages from the shell",
    ),
    (cmd) => {
      if (/^(?:mail|mailx|sendmail|mutt|msmtp|neomutt)$/.test(cmd.name)) return display(cmd);
      const args = cmd.argv.slice(1).join(" ");
      if (cmd.name === "gh" && /^(?:issue|pr) (?:comment|review)\b/.test(args)) return display(cmd);
      if (cmd.name === "twilio" && /messages:create/.test(args)) return display(cmd);
      return null;
    },
  ),
  rule(
    info(
      "publishing.shell-publish",
      "publishing",
      "require_approval",
      "high",
      "Publishes code, packages or deployments",
    ),
    (cmd) => {
      const args = cmd.argv
        .slice(1)
        .filter((a) => !a.startsWith("-"))
        .join(" ");
      if (cmd.name === "git" && gitVerb(cmd) === "push")
        return { evidence: display(cmd), risk: "medium" };
      if (
        /^(?:npm|pnpm|yarn|bun)$/.test(cmd.name) &&
        /^(?:publish|unpublish|deprecate|dist-tag add)\b/.test(args)
      )
        return display(cmd);
      if (cmd.name === "cargo" && /^(?:publish|yank)\b/.test(args)) return display(cmd);
      if (cmd.name === "gem" && /^(?:push|yank)\b/.test(args)) return display(cmd);
      if (
        (cmd.name === "twine" && /^upload\b/.test(args)) ||
        (cmd.name === "poetry" && /^publish\b/.test(args))
      )
        return display(cmd);
      if (
        cmd.name === "gh" &&
        /^(?:(?:pr|issue|release|repo|gist|label) (?:create|merge|close|reopen|edit|delete|upload|fork|rename|archive|transfer)|repo fork|workflow run|secret set|variable set)\b/.test(
          args,
        )
      ) {
        return display(cmd);
      }
      if ((cmd.name === "docker" || cmd.name === "podman") && /^(?:push|image push)\b/.test(args))
        return display(cmd);
      const deployVerb = args.split(" ")[0] ?? "";
      if (
        /^(?:vercel|netlify|firebase|fly|flyctl|wrangler|heroku|surge|railway|render|amplify)$/.test(
          cmd.name,
        ) &&
        !/^(?:login|logout|whoami|list|ls|logs|status|help|dev|init|link)$/.test(deployVerb)
      ) {
        return display(cmd);
      }
      return null;
    },
  ),
];

const DEVICE_RE = /^\/dev\//;

/** A recursive search for passwords, keys or tokens in folders outside the workspace, like the grep tool's. */
function secretSearchOutside(cmd: ShellCommand, env: ShellEnv): string | undefined {
  if (!searchesRecursively(cmd)) return undefined;
  const patterns = [
    ...optionValues(cmd, "e", ["--regexp"]),
    ...(hasFlag(cmd, "ef", ["--regexp", "--file"]) ? [] : [operands(cmd)[0]?.value ?? ""]),
  ];
  const pattern = patterns.find((p) => SECRET_WORDS_RE.test(p));
  if (pattern === undefined) return undefined;
  const outside = targets(cmd, env).find(
    (t) => t.role === "read" && t.resolved.location !== "workspace",
  );
  return outside ? `${code(pattern, 40)} in ${outside.raw}` : undefined;
}

/** Rules that look at paths (read secrets / write outside) reuse the shared path rules. */
function pathHits(cmd: ShellCommand, env: ShellEnv): RuleHit[] {
  const hits: RuleHit[] = [];
  for (const { target, evidence } of fedReadTargets(cmd, env))
    hits.push(...readPathHits(target.resolved, evidence));
  const secretSearch = secretSearchOutside(cmd, env);
  if (secretSearch) hits.push({ rule: SECRET_SEARCH, evidence: secretSearch });
  for (const t of targets(cmd, env)) {
    const evidence = display(cmd);
    if (t.role === "read" || t.role === "link-target")
      hits.push(...readPathHits(t.resolved, evidence));
    if (t.role === "link-target" || t.role === "delete" || t.role === "meta")
      hits.push(...appStateHits(t.resolved, evidence));
    if (t.role === "write" && !DEVICE_RE.test(t.resolved.path))
      hits.push(...writePathHits(t.resolved, evidence));
  }
  if (
    cmd.name === "git" &&
    /^(?:add|commit|init|checkout|switch|restore|merge|rebase|cherry-pick|revert|stash|tag|branch|mv|rm|apply|am|reset|clean|pull|worktree|submodule)$/.test(
      gitVerb(cmd),
    )
  ) {
    const dir = optionValues(cmd, "C", [])[0] ?? ".";
    const repo = env.resolve(dir, cmd);
    hits.push(...writePathHits(repo, `${display(cmd)} (repository at ${repo.path})`));
  }
  return hits;
}

/** `host:port` endpoints of raw sockets (`nc localhost 7331`, `> /dev/tcp/127.0.0.1/7331`) as URLs. */
function socketUrls(cmd: ShellCommand): string[] {
  const out: string[] = [];
  for (const r of cmd.redirects) {
    const m = /^\/dev\/(?:tcp|udp)\/([^/]+)\/(\d+)$/.exec(r.target);
    if (m) out.push(`http://${m[1]}:${m[2]}`);
  }
  if (/^(?:nc|ncat|netcat|telnet)$/.test(cmd.name)) {
    const ops = operands(cmd).map((o) => o.value);
    const port = ops.findLastIndex((o) => /^\d+$/.test(o));
    if (port > 0) out.push(`http://${ops[port - 1]}:${ops[port]}`);
  }
  if (cmd.name === "socat") {
    for (const arg of cmd.argv.slice(1)) {
      const m = /^(?:tcp|udp)[46]?(?:-connect)?:(\[[^\]]+\]|[^:,]+):(\d+)/i.exec(arg);
      if (m) out.push(`http://${m[1]}:${m[2]}`);
    }
  }
  return out;
}

/** URL rules for HTTP clients and raw sockets (scheme-less URLs are http). Local files go through path rules. */
function urlRuleHits(cmd: ShellCommand, env: ShellEnv): RuleHit[] {
  const urls = [...(httpRequestOf(cmd)?.urls ?? []), ...socketUrls(cmd)];
  const hits: RuleHit[] = [];
  for (const raw of urls) {
    const url = parseUrl(withScheme(raw));
    if (!url) continue;
    if (url.scheme === "file") {
      hits.push(...readPathHits(env.resolve(decodeURIComponent(url.path), cmd), display(cmd)));
      continue;
    }
    for (const r of URL_RULES) {
      if (r.id === "browser.dangerous-scheme" || r.id === "system.non-web-link") continue;
      const match = r.match(url);
      if (match)
        hits.push(
          typeof match === "string"
            ? { rule: r, evidence: `${match} (${cmd.name})` }
            : { rule: r, evidence: match.evidence, risk: match.risk },
        );
    }
  }
  return hits;
}

export const SHELL_RULES: readonly ShellRule[] = [
  ...SHELL_HARDLINE_RULES,
  ...SHELL_SECRET_RULES,
  ...SHELL_APPROVAL_RULES,
];

/** Every hit for one command, including shared path, URL and inline-code rules. */
export function commandHits(cmd: ShellCommand, env: ShellEnv): RuleHit[] {
  const hits: RuleHit[] = [];
  for (const r of SHELL_RULES) {
    const match = r.match(cmd, env);
    if (match)
      hits.push(
        typeof match === "string"
          ? { rule: r, evidence: match }
          : { rule: r, evidence: match.evidence, risk: match.risk },
      );
  }
  const inline = interpreterCall(cmd)?.inlineCode;
  if (inline !== undefined) hits.push(...executedTextHits(inline, `${cmd.name} inline code`));
  const awkProgram = /^(?:g|m|n)?awk$/.test(cmd.name) ? operands(cmd)[0]?.value : undefined;
  if (awkProgram) hits.push(...executedTextHits(awkProgram, `${cmd.name} program`));
  hits.push(...pathHits(cmd, env), ...urlRuleHits(cmd, env));
  return hits;
}

/** Allow-rules for command lines whose every command was recognized as benign. */
export const SHELL_BENIGN = {
  read: info(
    "shell.read-only",
    "read",
    "allow",
    "low",
    "Runs read-only shell commands (listing, reading, searching, git status, HTTP GET)",
  ),
  compute: info(
    "shell.compute",
    "compute",
    "allow",
    "low",
    "Runs computations (calculators, text processing, inline code without side effects)",
  ),
  file_write: info(
    "shell.workspace-write",
    "file_write",
    "allow",
    "low",
    "Creates or changes files inside the task workspace",
  ),
} as const;

export const SHELL_TOO_LARGE = info(
  "shell.hardline.too-large",
  "system",
  "deny",
  "critical",
  "Shell command is too large to verify (write files with the write tool instead)",
);
export const SHELL_FORK_BOMB = info(
  "shell.hardline.fork-bomb",
  "system",
  "deny",
  "critical",
  "Runs a fork bomb",
);
export const SHELL_UNPARSEABLE = info(
  "system.unparseable",
  "system",
  "require_approval",
  "medium",
  "Shell command could not be fully analyzed",
);

/** Blanks quoted text so prose inside quotes cannot trip text patterns (payloads of `sh -c`/`eval` are parsed separately). */
function maskQuoted(source: string): string {
  return source.replace(
    /'[^']*'|"(?:[^"\\]|\\.)*"/g,
    (m) => `${m[0]}${" ".repeat(Math.max(0, m.length - 2))}${m[0]}`,
  );
}

/** Hits that concern the command line as a whole rather than one simple command. */
export function analysisHits(env: ShellEnv): RuleHit[] {
  const { analysis } = env;
  const hits: RuleHit[] = [];
  if (analysis.error === "command is too large to analyze") {
    return [{ rule: SHELL_TOO_LARGE, evidence: `${analysis.source.length} characters` }];
  }
  if (analysis.error) {
    hits.push({ rule: SHELL_UNPARSEABLE, evidence: analysis.error });
    // What the parser could not follow (past its limits, broken syntax) may still run.
    hits.push(
      ...executedTextHits(analysis.source, "a command that could not be fully analyzed").filter(
        (h) => !/fork bomb/.test(h.evidence),
      ),
    );
  }
  const carriers = analysis.commands.some((c) => c.via === "shell-c" || c.via === "eval");
  const text = carriers ? analysis.source : maskQuoted(analysis.source);
  const bomb = executedTextHits(text, "command").find((h) => /fork bomb/.test(h.evidence));
  if (bomb) hits.push({ rule: SHELL_FORK_BOMB, evidence: "`:(){ :|:& };:`" });
  return hits;
}
