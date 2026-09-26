import { existsSync, readFileSync } from "node:fs";
import { parseEnvFile } from "@ddl/core";

/**
 * Applies env files in order without overriding variables that are already set (so the real
 * environment wins, then earlier files). Empty values never count as set, which lets a later file
 * fill in a key left blank in an earlier one. Returns the files that existed.
 */
export function loadEnvFiles(
  paths: readonly string[],
  env: Record<string, string | undefined>,
): string[] {
  const loaded: string[] = [];
  for (const path of paths) {
    if (!existsSync(path)) continue;
    for (const [key, value] of parseEnvFile(readFileSync(path, "utf8"))) {
      if (value === "" || isSet(env[key])) continue;
      env[key] = value;
    }
    loaded.push(path);
  }
  return loaded;
}

function isSet(value: string | undefined): boolean {
  return value !== undefined && value !== "";
}
