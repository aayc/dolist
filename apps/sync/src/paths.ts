import { decodeVaultPath, normalizePath, SYNC_LIMITS } from "@ddl/core";
import { SyncApiError } from "./errors";

/**
 * True for a canonical vault path: what `normalizePath` returns for it, non-empty and not too long.
 * That rules out `..`, `.`, empty segments, a leading `/`, backslashes and NUL. Clients normalize
 * before sending, so anything else is refused rather than silently reinterpreted.
 */
export function isCanonicalPath(path: string): boolean {
  if (path.length === 0 || path.length > SYNC_LIMITS.pathLength) return false;
  try {
    return normalizePath(path) === path;
  } catch {
    return false;
  }
}

export function requirePath(path: string): string {
  if (!isCanonicalPath(path)) {
    throw new SyncApiError(400, "invalid_path", "Not a canonical vault path");
  }
  return path;
}

/** `prefix` query values: empty (everything) or a canonical path. */
export function requirePrefix(prefix: string | undefined): string {
  return prefix ? requirePath(prefix) : "";
}

/** `["", "v1", "vaults", "<vault>", "files"]` precede the file path in the URL. */
const FILE_ROUTE_SEGMENTS = 5;

/**
 * The file path of a `/v1/vaults/<vault>/files/<encoded path>` URL, decoded segment by segment
 * from the raw pathname (Hono's decoded path would decode `%25` twice).
 */
export function filePathFromUrl(url: string): string {
  const encoded = new URL(url).pathname.split("/").slice(FILE_ROUTE_SEGMENTS).join("/");
  let decoded: string;
  try {
    decoded = decodeVaultPath(encoded);
  } catch {
    throw new SyncApiError(400, "invalid_path", "Malformed percent-encoding in path");
  }
  return requirePath(decoded);
}
