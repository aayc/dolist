import { decodeVaultPath, extname, InvalidPathError, isHiddenPath, normalizePath } from "@ddl/core";
import { ApiError } from "./errors";

/** Text formats the notes API reads and writes (the storage layer stores UTF-8 text). */
export const TEXT_NOTE_EXTENSIONS: ReadonlySet<string> = new Set([
  ".md",
  ".markdown",
  ".txt",
  ".canvas",
  ".base",
  ".json",
  ".csv",
  ".tsv",
  ".yaml",
  ".yml",
]);

const MAX_PATH_LENGTH = 1024;
/** `["", "api", "notes"]` precede the note path in `/api/notes/<path>`. */
const NOTE_ROUTE_SEGMENTS = 3;

export function isTextNotePath(path: string): boolean {
  return TEXT_NOTE_EXTENSIONS.has(extname(path).toLowerCase());
}

/**
 * Canonical vault path for user input, rejecting escapes, control characters and hidden paths
 * (dot-files, `.obsidian`, the agent sidecar).
 */
export function resolveVaultPath(input: string): string {
  let path: string;
  try {
    path = normalizePath(input);
  } catch (error) {
    if (error instanceof InvalidPathError) throw new ApiError(400, "invalid_path", error.message);
    throw error;
  }
  if (path === "") throw new ApiError(400, "invalid_path", "Path is empty");
  if (path.length > MAX_PATH_LENGTH) throw new ApiError(400, "invalid_path", "Path is too long");
  if (hasControlCharacters(path)) {
    throw new ApiError(400, "invalid_path", "Path contains control characters");
  }
  if (isHiddenPath(path)) {
    throw new ApiError(400, "invalid_path", "Hidden files and folders are not accessible");
  }
  return path;
}

export function resolveNotePath(input: string): string {
  const path = resolveVaultPath(input);
  if (!isTextNotePath(path)) {
    throw new ApiError(400, "invalid_path", `Not a text note: "${extname(path) || path}"`);
  }
  return path;
}

/**
 * The note path of an `/api/notes/<encoded path>` URL, decoded per segment from the raw pathname
 * (Hono's `c.req.path` is already partially decoded, which would double-decode `%25`).
 */
export function notePathFromUrl(url: string): string {
  const encoded = new URL(url).pathname.split("/").slice(NOTE_ROUTE_SEGMENTS).join("/");
  let decoded: string;
  try {
    decoded = decodeVaultPath(encoded);
  } catch {
    throw new ApiError(400, "invalid_path", "Malformed percent-encoding in path");
  }
  return resolveNotePath(decoded);
}

function hasControlCharacters(path: string): boolean {
  for (let i = 0; i < path.length; i++) {
    const code = path.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}
