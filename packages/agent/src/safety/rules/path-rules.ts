/**
 * Rules about paths, shared by the file tools, MCP file tools and shell commands: reading private
 * keys and credential stores, reading other sensitive files, and writing outside the workspace
 * (with stricter outcomes for app state, startup files, credentials and system paths).
 */
import { homeReadRisk, type ResolvedPath, sensitiveKinds } from "../paths";
import { info, type RuleHit } from "./types";

export const SSH_KEY_READ = info(
  "secrets.ssh-private-key",
  "credentials",
  "deny",
  "critical",
  "Reads a private SSH key",
);
export const CREDENTIAL_STORE_READ = info(
  "secrets.credential-store",
  "credentials",
  "deny",
  "critical",
  "Reads saved logins: a password store, keychain, browser credential database, cloud, cluster, Docker or Cursor credentials, or the app's API keys and tokens",
);
export const HOME_FOLDER_READ = info(
  "secrets.home-folder",
  "credentials",
  "deny",
  "critical",
  "Reads your whole home folder, including SSH keys and cloud credentials",
);
export const CREDENTIAL_FOLDER_READ = info(
  "secrets.credential-folder",
  "credentials",
  "deny",
  "critical",
  "Reads a whole folder that holds saved logins and private data (~/Library, ~/.config, …)",
);
export const SHELL_HISTORY_READ = info(
  "secrets.shell-history",
  "credentials",
  "deny",
  "critical",
  "Reads your shell history (commands you typed, often with passwords and tokens in them)",
);
export const ENV_FILE_READ = info(
  "secrets.env-file",
  "credentials",
  "deny",
  "critical",
  "Reads a .env file outside the task workspace (it holds API keys and passwords)",
);
export const PERSONAL_FOLDER_READ = info(
  "privacy.personal-folder",
  "privacy",
  "require_approval",
  "medium",
  "Reads a whole folder of your personal files (Documents, Desktop, Downloads, …)",
);
export const SENSITIVE_FILE_READ = info(
  "credentials.sensitive-file",
  "credentials",
  "require_approval",
  "high",
  "Reads a file that usually holds secrets (.env, keys, credential configs, shell history)",
);
export const PERSONAL_DATA_READ = info(
  "privacy.personal-data",
  "privacy",
  "require_approval",
  "high",
  "Reads your messages, mail, photos or browsing data",
);

export const APP_CONFIG_WRITE = info(
  "secrets.app-config-write",
  "system",
  "deny",
  "critical",
  "Changes the app's own settings, keys, connector config or approval state (an agent could change its approval policy or grant itself permissions)",
);
export const PERSISTENCE_WRITE = info(
  "system.persistence-write",
  "system",
  "require_approval",
  "high",
  "Changes shell startup files, login items, scheduled jobs or SSH access",
);
export const CREDENTIAL_FILE_WRITE = info(
  "credentials.credential-file-write",
  "credentials",
  "require_approval",
  "high",
  "Overwrites keys or credential files",
);
export const SYSTEM_PATH_WRITE = info(
  "system.system-path-write",
  "system",
  "require_approval",
  "high",
  "Writes to a system location",
);
export const NOTE_WRITE = info(
  "file_write.note-edit",
  "file_write",
  "require_approval",
  "medium",
  "Edits a note or vault file outside the task workspace",
);
export const OUTSIDE_WRITE = info(
  "file_write.outside-workspace",
  "file_write",
  "require_approval",
  "medium",
  "Writes files outside the task workspace",
);

/**
 * The app's own files: the vault's `.daily-do-list/` sidecar (settings, approvals, threads) and
 * `$DDL_HOME` (config, keys, tokens, harness config), except the agents' workspaces.
 */
const APP_STATE_RE = /(?:^|\/)\.daily-do-list(?:\/?$|\/(?!workspaces(?:\/|$)))/i;
const APP_DIR_RE = /(?:^|\/)\.daily-do-list(?:\/|$)/i;
const PARENT_SEGMENT_RE = /(?:^|\/)\.\.(?:\/|$)/;

/** Whether `target` is the app's own state (a `..` after the app folder counts: it may climb out of the workspaces). */
export function isAppState(target: ResolvedPath): boolean {
  return [target.path, target.appPath].some(
    (p) =>
      p !== undefined &&
      (APP_STATE_RE.test(p) || (APP_DIR_RE.test(p) && PARENT_SEGMENT_RE.test(p))),
  );
}

function kindsOf(target: ResolvedPath) {
  const kinds = sensitiveKinds(target.path);
  if (target.appPath) for (const kind of sensitiveKinds(target.appPath)) kinds.add(kind);
  return kinds;
}

function inScratch(target: ResolvedPath): boolean {
  return target.location === "workspace" || target.location === "temp";
}

/**
 * Deleting, moving, re-permissioning or linking to the app's own state: a deleted settings file
 * falls back to defaults, and writing through a link changes the file it points to.
 */
export function appStateHits(target: ResolvedPath, evidence: string): RuleHit[] {
  return isAppState(target) ? [{ rule: APP_CONFIG_WRITE, evidence }] : [];
}

/**
 * Hits for reading `target`'s contents: the file itself, or everything under it for recursive,
 * archiving and copying readers (a folder or a glob stands for all it contains). Links count as
 * reads: what goes through them later looks like a workspace path. `listing` is for tools that
 * only list or describe files (a connector's `list_directory`): a folder's names aren't its files.
 */
export function readPathHits(
  target: ResolvedPath,
  evidence: string,
  { listing = false }: { listing?: boolean } = {},
): RuleHit[] {
  const kinds = kindsOf(target);
  if (kinds.has("ssh-private-key")) return [{ rule: SSH_KEY_READ, evidence }];
  if (kinds.has("credential-store") || kinds.has("app-secret"))
    return [{ rule: CREDENTIAL_STORE_READ, evidence }];
  const outside = !inScratch(target);
  if (outside && kinds.has("history")) return [{ rule: SHELL_HISTORY_READ, evidence }];
  // Only where the path is known: a relative `.env` for a connector may be its own project's.
  if (target.location === "outside" && kinds.has("env-file"))
    return [{ rule: ENV_FILE_READ, evidence }];
  const home = outside && !listing ? homeReadRisk(target.path) : null;
  if (home === "home") return [{ rule: HOME_FOLDER_READ, evidence }];
  if (home === "secrets") return [{ rule: CREDENTIAL_FOLDER_READ, evidence }];
  const hits: RuleHit[] = [];
  if (
    kinds.has("credential-config") ||
    kinds.has("history") ||
    (outside && (kinds.has("env-file") || kinds.has("key-material")))
  ) {
    hits.push({ rule: SENSITIVE_FILE_READ, evidence });
  }
  if (kinds.has("personal-data")) hits.push({ rule: PERSONAL_DATA_READ, evidence });
  if (home === "personal") hits.push({ rule: PERSONAL_FOLDER_READ, evidence });
  return hits;
}

/**
 * Hits for creating or modifying `target`. Writes inside the workspace or temp area are fine, except
 * to the app's own state (a vault or `$DDL_HOME` may live in the temp area).
 */
export function writePathHits(target: ResolvedPath, evidence: string): RuleHit[] {
  if (target.location === "workspace") return [];
  const kinds = kindsOf(target);
  if (isAppState(target) || kinds.has("app-secret")) return [{ rule: APP_CONFIG_WRITE, evidence }];
  if (inScratch(target)) return [];
  if (target.location === "unknown")
    return [{ rule: OUTSIDE_WRITE, evidence: `${evidence} (location unknown)` }];
  const hits: RuleHit[] = [];
  if (kinds.has("shell-startup") || kinds.has("persistence"))
    hits.push({ rule: PERSISTENCE_WRITE, evidence });
  if (
    kinds.has("ssh-private-key") ||
    kinds.has("credential-store") ||
    kinds.has("credential-config") ||
    kinds.has("key-material")
  ) {
    hits.push({ rule: CREDENTIAL_FILE_WRITE, evidence });
  }
  if (kinds.has("system") && hits.length === 0) hits.push({ rule: SYSTEM_PATH_WRITE, evidence });
  if (hits.length === 0) {
    const note = /\.md$/i.test(target.path) || /\/\.obsidian(?:\/|$)/i.test(target.path);
    hits.push({ rule: note ? NOTE_WRITE : OUTSIDE_WRITE, evidence });
  }
  return hits;
}

export const PATH_RULES = [
  SSH_KEY_READ,
  CREDENTIAL_STORE_READ,
  HOME_FOLDER_READ,
  CREDENTIAL_FOLDER_READ,
  SHELL_HISTORY_READ,
  ENV_FILE_READ,
  SENSITIVE_FILE_READ,
  PERSONAL_DATA_READ,
  PERSONAL_FOLDER_READ,
  APP_CONFIG_WRITE,
  PERSISTENCE_WRITE,
  CREDENTIAL_FILE_WRITE,
  SYSTEM_PATH_WRITE,
  NOTE_WRITE,
  OUTSIDE_WRITE,
] as const;
