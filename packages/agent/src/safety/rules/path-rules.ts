/**
 * Rules about paths, shared by the file tools, MCP file tools and shell commands: reading private
 * keys and credential stores, reading other sensitive files, and writing outside the workspace
 * (with stricter outcomes for app state, startup files, credentials and system paths).
 */
import { type ResolvedPath, sensitiveKinds } from "../paths";
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
  "Reads a password store, keychain, browser credential database or the app's API keys",
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
  "Changes the app's own keys, connector config or approval state (an agent could grant itself permissions)",
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

const APP_CONFIG_RE = /(?:^|\/)\.daily-do-list\/(?:\.env[^/]*|mcp\.json|state(?:\/|$))/i;

function inScratch(target: ResolvedPath): boolean {
  return target.location === "workspace" || target.location === "temp";
}

/** Hits for reading `target`'s contents. */
export function readPathHits(target: ResolvedPath, evidence: string): RuleHit[] {
  const kinds = sensitiveKinds(target.path);
  if (kinds.has("ssh-private-key")) return [{ rule: SSH_KEY_READ, evidence }];
  if (kinds.has("credential-store") || kinds.has("app-secret"))
    return [{ rule: CREDENTIAL_STORE_READ, evidence }];
  const hits: RuleHit[] = [];
  const outside = !inScratch(target);
  if (
    kinds.has("credential-config") ||
    kinds.has("history") ||
    (outside && (kinds.has("env-file") || kinds.has("key-material")))
  ) {
    hits.push({ rule: SENSITIVE_FILE_READ, evidence });
  }
  if (kinds.has("personal-data")) hits.push({ rule: PERSONAL_DATA_READ, evidence });
  return hits;
}

/** Hits for creating or modifying `target`. Writes inside the workspace or temp area are fine. */
export function writePathHits(target: ResolvedPath, evidence: string): RuleHit[] {
  if (inScratch(target)) return [];
  if (target.location === "unknown")
    return [{ rule: OUTSIDE_WRITE, evidence: `${evidence} (location unknown)` }];
  const kinds = sensitiveKinds(target.path);
  if (APP_CONFIG_RE.test(target.path) || kinds.has("app-secret"))
    return [{ rule: APP_CONFIG_WRITE, evidence }];
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
  SENSITIVE_FILE_READ,
  PERSONAL_DATA_READ,
  APP_CONFIG_WRITE,
  PERSISTENCE_WRITE,
  CREDENTIAL_FILE_WRITE,
  SYSTEM_PATH_WRITE,
  NOTE_WRITE,
  OUTSIDE_WRITE,
] as const;
