/**
 * Where an import reads and writes. The source is an existing, readable folder that neither is
 * nor holds nor sits inside `$DDL_HOME` or the current vault. The destination is a new or empty
 * folder in a writable parent, never inside the source, `$DDL_HOME` or the current vault. Both are
 * compared by real path, so a symlink can't smuggle one inside another.
 */
import { constants } from "node:fs";
import { access, lstat, readdir, realpath, stat } from "node:fs/promises";
import { basename, dirname, isAbsolute, join } from "node:path";
import { ApiError } from "../errors";
import { resolveUserPath } from "../home-paths";
import { isInside } from "./walk";

export interface ImportPlaces {
  /** `$DDL_HOME` (null: none, e.g. tests without one). */
  home: string | null;
  /** The vault this daemon serves (null: none). */
  vault: string | null;
  homedir: string;
}

/** Files a folder may hold and still count as empty (Finder adds one to any folder it shows). */
const IGNORABLE = new Set([".DS_Store"]);
const DESTINATION_LABEL = "Daily Do List";

export async function resolveSource(input: string, places: ImportPlaces): Promise<string> {
  const expanded = expandUserPath(input, places, "source");
  let source: string;
  try {
    source = await realpath(expanded);
  } catch {
    throw invalid(`There's no folder at ${input.trim()}`);
  }
  const info = await stat(source);
  if (!info.isDirectory()) throw invalid(`${input.trim()} is a file, not a vault folder`);
  try {
    await access(source, constants.R_OK | constants.X_OK);
  } catch {
    throw invalid(`${input.trim()} can't be read`);
  }
  const { home, vault } = await realPlaces(places);
  if (home && overlaps(source, home)) {
    throw invalid("The Obsidian vault can't be in or hold Daily Do List's own folder");
  }
  if (vault && overlaps(source, vault)) {
    throw invalid("The Obsidian vault can't be in or hold the current Daily Do List vault");
  }
  return source;
}

/** The folder to create the new vault in (not created yet). */
export async function resolveDestination(
  input: string | undefined,
  source: string,
  places: ImportPlaces,
): Promise<string> {
  if (input === undefined) return defaultDestination(source, places);
  const expanded = expandUserPath(input, places, "destination");
  const problem = await destinationProblem(expanded, source, places);
  if (problem) throw invalid(problem);
  return join(await realpath(dirname(expanded)), basename(expanded));
}

/** A new folder next to the current vault named after the source, never inside the source. */
export async function defaultDestination(source: string, places: ImportPlaces): Promise<string> {
  const { vault } = await realPlaces(places);
  const parent = vault ? dirname(vault) : dirname(source);
  const name = basename(source);
  for (let n = 0; n <= 100; n++) {
    const candidate = join(parent, n === 0 ? name : withLabel(name, DESTINATION_LABEL, n));
    if (!(await destinationProblem(candidate, source, places))) return candidate;
  }
  throw invalid("Choose a destination folder for the new vault");
}

async function destinationProblem(
  path: string,
  source: string,
  places: ImportPlaces,
): Promise<string | null> {
  let parent: string;
  try {
    parent = await realpath(dirname(path));
  } catch {
    return `The folder that would hold ${path} doesn't exist`;
  }
  const destination = join(parent, basename(path));
  if (isInside(destination, source)) return "The new vault can't be inside the Obsidian vault";
  const { home, vault } = await realPlaces(places);
  if (home && isInside(destination, home)) {
    return "The new vault can't be inside Daily Do List's own folder";
  }
  if (vault && isInside(destination, vault)) {
    return "The new vault can't be inside the current vault";
  }
  const existing = await lstat(destination).catch(() => null);
  if (existing) {
    if (!existing.isDirectory()) return `${path} already exists and isn't a folder`;
    const names = await readdir(destination).catch(() => null);
    if (!names) return `${path} can't be read`;
    if (names.some((name) => !IGNORABLE.has(name))) return `${path} isn't empty`;
  }
  try {
    await access(parent, constants.W_OK);
  } catch {
    return `Daily Do List can't create folders in ${dirname(path)}`;
  }
  return null;
}

/**
 * `path` with ` (<label>)` (or ` (<label> <n>)`) before its extension; `.excalidraw.md` counts as
 * one extension so a renamed drawing stays a drawing.
 */
export function withLabel(path: string, label: string, n = 1): string {
  const slash = path.lastIndexOf("/");
  const folder = path.slice(0, slash + 1);
  const name = path.slice(slash + 1);
  const ext = extensionOf(name);
  const stem = name.slice(0, name.length - ext.length);
  return `${folder}${stem} (${n === 1 ? label : `${label} ${n}`})${ext}`;
}

/** The first `withLabel` variant of `path` whose key isn't taken. */
export function freeName(path: string, label: string, taken: (key: string) => boolean): string {
  for (let n = 1; ; n++) {
    const candidate = withLabel(path, label, n);
    if (!taken(pathKey(candidate))) return candidate;
  }
}

/**
 * Compares paths the way macOS's default file system does: case-insensitive, whatever the
 * Unicode normalization, so a carried-over note can't overwrite one that differs only in case.
 */
export function pathKey(path: string): string {
  return path.normalize("NFC").toLowerCase();
}

function extensionOf(name: string): string {
  const compound = ".excalidraw.md";
  if (name.length > compound.length && name.toLowerCase().endsWith(compound)) {
    return name.slice(-compound.length);
  }
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot) : "";
}

function expandUserPath(input: string, places: ImportPlaces, what: string): string {
  const trimmed = input.trim();
  if (!(trimmed === "~" || trimmed.startsWith("~/") || isAbsolute(trimmed))) {
    throw invalid(`The ${what} must be an absolute path (or start with ~/)`);
  }
  return resolveUserPath(trimmed, { homedir: places.homedir, base: places.homedir });
}

async function realPlaces(
  places: ImportPlaces,
): Promise<{ home: string | null; vault: string | null }> {
  const real = async (path: string | null) =>
    path === null ? null : await realpath(path).catch(() => path);
  return { home: await real(places.home), vault: await real(places.vault) };
}

function overlaps(a: string, b: string): boolean {
  return isInside(a, b) || isInside(b, a);
}

function invalid(message: string): ApiError {
  return new ApiError(400, "invalid_request", message);
}
