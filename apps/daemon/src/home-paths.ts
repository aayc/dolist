import { isAbsolute, join, resolve, sep } from "node:path";

/** Expands a leading `~` and resolves relative paths against `base`. `~user` is not supported. */
export function resolveUserPath(input: string, options: { homedir: string; base: string }): string {
  const trimmed = input.trim();
  let expanded = trimmed;
  if (trimmed === "~") expanded = options.homedir;
  else if (trimmed.startsWith("~/")) expanded = join(options.homedir, trimmed.slice(2));
  return isAbsolute(expanded) ? resolve(expanded) : resolve(options.base, expanded);
}

/** `~`-abbreviates paths under the home directory so logs never contain the username. */
export function displayPath(path: string, homedir: string): string {
  if (path === homedir) return "~";
  const prefix = homedir.endsWith(sep) ? homedir : `${homedir}${sep}`;
  return path.startsWith(prefix) ? `~/${path.slice(prefix.length)}` : path;
}
