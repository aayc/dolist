/**
 * Adapted from Hermes Agent (MIT) — see NOTICE.md (protected roots for `catastrophicTarget`).
 *
 * Path reasoning for the safety rules: where a path points relative to the task workspace and
 * whether it names something sensitive (keys, credential stores, startup files, app state).
 * Pure string logic: the evaluator never touches the file system, so symlinks are handled by the
 * rules (creating links that point outside the workspace needs approval).
 */

export type Cwd = { readonly kind: "known"; readonly path: string } | { readonly kind: "unknown" };

/** `temp` is the system temp area: scratch space that is as safe as the workspace (except its root). */
export type PathLocation = "workspace" | "temp" | "outside" | "unknown";

export interface ResolvedPath {
  location: PathLocation;
  /** Normalized absolute path, `~/…` when the home directory is unknown, or the raw text. */
  path: string;
  /**
   * The path spelled under the default `~/.daily-do-list` when it is inside the configured
   * `$DDL_HOME`, so rules about the app's own files also cover a home somewhere else.
   */
  appPath?: string;
}

/** Where `$DDL_HOME` is by default; rules about the app's own files are written against it. */
export const DEFAULT_APP_HOME = "~/.daily-do-list";

const HOME_PREFIX_RE = /^(?:\/Users\/[^/]+|\/home\/[^/]+|\/root|\/var\/root)(?=\/|$)/;
const TEMP_ROOTS_RE =
  /^(?:\/private)?(?:\/tmp|\/var\/tmp|\/var\/folders\/[^/]+\/[^/]+\/[TC])(?=\/|$)/;
const UNICODE_SPACES_RE = /[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g;

export function initialCwd(workspaceDir?: string): Cwd {
  return workspaceDir?.startsWith("/")
    ? { kind: "known", path: normalizeAbsolute(workspaceDir) }
    : { kind: "unknown" };
}

/** The user's home directory, when the workspace path reveals it (`/Users/<name>/…`). */
export function inferHome(workspaceDir?: string): string | undefined {
  return workspaceDir ? HOME_PREFIX_RE.exec(workspaceDir)?.[0] : undefined;
}

/** Undoes the path spellings file tools accept: `@path`, `file://` URLs and exotic spaces. */
export function cleanPathInput(raw: string): string {
  let p = raw.replace(UNICODE_SPACES_RE, " ").trim();
  if (p.startsWith("@")) p = p.slice(1);
  if (/^file:\/\//i.test(p)) {
    try {
      p = decodeURIComponent(new URL(p).pathname);
    } catch {
      p = p.replace(/^file:\/\/[^/]*/i, "");
    }
  }
  return p;
}

export function normalizeAbsolute(path: string): string {
  const out: string[] = [];
  for (const segment of path.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") out.pop();
    else out.push(segment);
  }
  return `/${out.join("/")}`;
}

/** Normalizes `~/…`; climbing above the (unknown) home directory yields `~/..`. */
function normalizeTilde(path: string): string {
  const out: string[] = [];
  for (const segment of path.slice(1).split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      if (out.length === 0) return "~/..";
      out.pop();
    } else out.push(segment);
  }
  return out.length === 0 ? "~" : `~/${out.join("/")}`;
}

function locate(path: string, workspaceDir?: string): PathLocation {
  if (workspaceDir?.startsWith("/")) {
    const ws = normalizeAbsolute(workspaceDir);
    if (path === ws || path.startsWith(`${ws}/`)) return "workspace";
  }
  const temp = TEMP_ROOTS_RE.exec(path);
  const rest = temp ? path.slice(temp[0].length) : "";
  // The temp root itself (and a glob over all of it) is shared with other programs.
  if (temp && rest !== "" && rest !== "/" && !/^\/[*?]+$/.test(rest)) return "temp";
  return "outside";
}

/**
 * `path` under `~/.daily-do-list` when it is inside `appHome` (`$DDL_HOME`). A home that is the
 * user's home directory, a temp root or `/` would make everything app state, so it is ignored.
 */
function appHomePath(path: string, appHome?: string): string | undefined {
  if (!appHome?.startsWith("/")) return undefined;
  const home = normalizeAbsolute(appHome);
  if (
    home === "/" ||
    HOME_PREFIX_RE.exec(home)?.[0] === home ||
    TEMP_ROOTS_RE.exec(home)?.[0] === home
  )
    return undefined;
  if (path === home) return DEFAULT_APP_HOME;
  return path.startsWith(`${home}/`) ? `${DEFAULT_APP_HOME}${path.slice(home.length)}` : undefined;
}

/**
 * Resolves a path argument against the current directory. Relative paths are only placed when the
 * current directory is known; everything else is `unknown`, which the rules treat as outside.
 * `appHome` is the configured `$DDL_HOME`, when known (see `ResolvedPath.appPath`).
 */
export function resolvePath(
  raw: string,
  cwd: Cwd,
  workspaceDir?: string,
  appHome?: string,
): ResolvedPath {
  const cleaned = cleanPathInput(raw);
  if (!cleaned) return { location: "unknown", path: raw };
  const home = inferHome(workspaceDir);
  let resolved: string;
  if (cleaned === "~" || cleaned.startsWith("~/")) {
    resolved = home ? normalizeAbsolute(`${home}/${cleaned.slice(1)}`) : normalizeTilde(cleaned);
  } else if (cleaned.startsWith("~")) {
    return { location: "outside", path: cleaned };
  } else if (cleaned.startsWith("/")) {
    resolved = normalizeAbsolute(cleaned);
  } else if (cwd.kind === "known") {
    const joined = `${cwd.path}/${cleaned}`;
    resolved = cwd.path.startsWith("~") ? normalizeTilde(joined) : normalizeAbsolute(joined);
  } else {
    return { location: "unknown", path: cleaned };
  }
  const appPath = appHomePath(resolved, appHome);
  return {
    location: resolved.startsWith("~") ? "outside" : locate(resolved, workspaceDir),
    path: resolved,
    ...(appPath ? { appPath } : {}),
  };
}

/** `/Users/<name>/x` → `~/x`, so patterns can be written once for every home directory. */
export function toHomeRelative(path: string): string {
  return path.replace(HOME_PREFIX_RE, "~");
}

export type SensitiveKind =
  | "ssh-private-key"
  | "credential-store"
  | "app-secret"
  | "app-state"
  | "env-file"
  | "key-material"
  | "credential-config"
  | "history"
  | "personal-data"
  | "shell-startup"
  | "persistence"
  | "system";

const SENSITIVE_PATTERNS: ReadonlyArray<readonly [SensitiveKind, RegExp]> = [
  // The `.ssh` directory itself and globs inside it count: recursive readers pick up the keys.
  [
    "ssh-private-key",
    /(?:^|\/)\.ssh(?:\/?$|\/(?:id_[^/]*|identity|[^/]*_(?:rsa|dsa|ecdsa|ed25519)(?:_sk)?|[^/]*\.pem|[^/]*[*?][^/]*)$)/,
  ],
  [
    "credential-store",
    /^~\/(?:\.aws|\.gnupg|\.password-store|\.config\/gh|\.config\/gcloud|\.config\/op|\.azure)\/?$/,
  ],
  [
    "credential-store",
    /^~\/(?:\.aws\/credentials$|\.aws\/sso\/cache\/|\.git-credentials$|_?\.?netrc$|\.gnupg\/(?:private-keys-v1\.d|secring\.gpg)|\.password-store\/|\.config\/(?:gh\/hosts\.yml$|op\/|gcloud\/(?:credentials\.db|access_tokens\.db|application_default_credentials\.json|legacy_credentials\/))|\.azure\/(?:accesstokens\.json|msal_token_cache)|\.terraform\.d\/credentials\.tfrc\.json$|library\/application support\/(?:1password|bitwarden|lastpass|dashlane|keepassxc))/,
  ],
  ["credential-store", /(?:^|\/)library\/keychains(?:\/|$)|\.keychain(?:-db)?$|\.kdbx$/],
  [
    "credential-store",
    /\/(?:login data|login data for account|web data|cookies|logins\.json|key[34]\.db|cookies\.sqlite|signons\.sqlite)(?:-journal)?$/,
  ],
  [
    "credential-store",
    /^\/(?:private\/)?(?:etc\/(?:shadow|gshadow|master\.passwd)$|var\/db\/dslocal\/nodes\/default\/users\/)/,
  ],
  [
    "app-secret",
    /(?:^|\/)\.daily-do-list\/(?:\.env(?:\.[^/]*)?$|[^/]*(?:token|secret|credential)[^/]*$)/,
  ],
  ["app-state", /(?:^|\/)\.daily-do-list(?:\/|$)/],
  [
    "env-file",
    /(?:^|\/)(?:\.env(?!\.(?:example|sample|template|dist|defaults)$)(?:\.[^/]+)?|\.envrc|\.dev\.vars)$/,
  ],
  [
    "key-material",
    /(?:\.(?:pem|key|p12|pfx|keystore|jks|ppk|p8|asc|gpg|pgp|ovpn)|(?:^|\/)(?:service[-_]?account[^/]*|credentials?|client_secret[^/]*|secrets?)\.(?:json|ya?ml|toml))$/,
  ],
  [
    "credential-config",
    /^~\/(?:\.ssh\/|\.npmrc$|\.pypirc$|\.docker\/config\.json$|\.kube\/config$|\.cargo\/credentials(?:\.toml)?$|\.gem\/credentials$|\.config\/hub$|\.boto$|\.s3cfg$|\.pgpass$|\.my\.cnf$|\.aws\/config$|\.config\/[^/]+\/[^/]*(?:credential|token|secret|auth)[^/]*$)/,
  ],
  [
    "history",
    /(?:^|\/)(?:\.(?:bash|zsh|sh|ksh|python|node_repl|psql|mysql|sqlite|irb|rediscli)_history|\.zsh_sessions\/.*|fish_history)$/,
  ],
  [
    "personal-data",
    /^~\/(?:library\/(?:messages|mail|safari|calendars|photos|application support\/(?:addressbook|calltaskhistory|google\/chrome|bravesoftware|microsoft edge|firefox)|containers\/com\.apple\.(?:mail|notes|messages)|group containers\/group\.com\.apple\.notes)(?:\/|$)|[^/]+\.photoslibrary(?:\/|$))/,
  ],
  [
    "shell-startup",
    /^(?:~\/\.(?:bashrc|bash_profile|bash_login|bash_logout|profile|zshrc|zprofile|zshenv|zlogin|zlogout|cshrc|tcshrc|kshrc|inputrc)|~\/\.config\/fish\/.*|\/(?:private\/)?etc\/(?:profile|zshrc|bashrc|zprofile|zshenv|paths(?:\.d\/.*)?))$/,
  ],
  [
    "persistence",
    /^(?:~\/library\/launchagents|\/library\/(?:launchagents|launchdaemons|startupitems)|\/(?:private\/)?etc\/(?:cron[^/]*|periodic|sudoers(?:\.d)?|hosts|launchd[^/]*)|\/(?:private\/)?var\/at|\/usr\/lib\/cron|~\/\.ssh\/(?:authorized_keys2?|config|rc|environment)|~\/\.config\/(?:autostart|systemd\/user|git)|~\/\.gitconfig|~\/\.local\/bin|~\/library\/application support\/com\.apple\.backgroundtaskmanagementagent)(?:\/|$)/,
  ],
  ["persistence", /(?:^|\/)\.git\/hooks\//],
  [
    "system",
    /^\/(?:etc|private|library|system|usr|bin|sbin|var|opt|applications|boot|dev|lib|lib64|cores|volumes|nix|snap|srv)(?:\/|$)/,
  ],
];

/** Every sensitive kind a path belongs to (a file can be both `credential-config` and `persistence`). */
export function sensitiveKinds(path: string): Set<SensitiveKind> {
  const p = toHomeRelative(path).toLowerCase();
  const kinds = new Set<SensitiveKind>();
  for (const [kind, re] of SENSITIVE_PATTERNS) {
    if (kind === "ssh-private-key" && p.endsWith(".pub")) continue;
    if (re.test(p)) kinds.add(kind);
  }
  return kinds;
}

const USER_DATA_RE =
  /^~\/(?:documents|desktop|downloads|pictures|movies|music|library|dropbox|google drive|onedrive|icloud drive|projects|code|dev|src|work|workspace|repos|git|notes|obsidian)(?:\/|$)/;

/** Folders whose loss would hurt the user most (used to raise risk, e.g. `rm -rf ~/Documents`). */
export function isUserDataPath(path: string): boolean {
  return USER_DATA_RE.test(toHomeRelative(path).toLowerCase());
}

const SYSTEM_DIRS: ReadonlySet<string> = new Set([
  "/home",
  "/root",
  "/etc",
  "/usr",
  "/var",
  "/bin",
  "/sbin",
  "/boot",
  "/lib",
  "/lib64",
  "/opt",
  "/private",
  "/system",
  "/library",
  "/applications",
  "/users",
  "/volumes",
  "/dev",
  "/proc",
  "/sys",
  "/cores",
  "/snap",
  "/srv",
  "/mnt",
  "/nix",
  "/usr/local",
  "/usr/bin",
  "/usr/lib",
  "/usr/sbin",
  "/usr/share",
  "/private/etc",
  "/private/var",
  "/var/root",
  "/var/db",
  "/system/library",
]);

function globToRegExp(glob: string): RegExp {
  let re = "";
  for (const ch of glob) {
    if (ch === "*") re += "[^/]*";
    else if (ch === "?") re += "[^/]";
    else re += ch.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${re}$`, "i");
}

/**
 * Classifies a deletion target whose loss has no recovery path (adapted from Hermes Agent's
 * hardline rm patterns): the filesystem root, a protected system directory, or a home directory.
 */
export function catastrophicTarget(path: string, home?: string): "root" | "system" | "home" | null {
  if (path === "~/..") return "system";
  let p = path.replace(/\/+$/, "") || "/";
  if (p.endsWith("/*") || p.endsWith("/.")) p = p.slice(0, -2) || "/";
  if (p === "/" || p === "" || /^\/\*+$/.test(p)) return "root";
  if (p === "~" || p === "~/*" || (home && p === home) || HOME_PREFIX_RE.exec(p)?.[0] === p) {
    return "home";
  }
  const lower = p.toLowerCase();
  if (SYSTEM_DIRS.has(lower)) return "system";
  if (/[*?]/.test(lower)) {
    const re = globToRegExp(lower);
    for (const dir of SYSTEM_DIRS) if (re.test(dir)) return "system";
    if (/^\/(?:users|home)\/[^/]*[*?][^/]*$/.test(lower)) return "home";
  }
  return null;
}

/** Expands simple, non-nested brace lists: `/{usr,etc}` → [`/usr`, `/etc`] (capped). */
export function expandBraces(word: string, limit = 32): string[] {
  const m = /\{([^{}]*,[^{}]*)\}/.exec(word);
  if (!m) return [word];
  const out: string[] = [];
  for (const option of m[1]!.split(",")) {
    for (const expanded of expandBraces(word.replace(m[0], option), limit)) {
      out.push(expanded);
      if (out.length >= limit) return out;
    }
  }
  return out;
}
