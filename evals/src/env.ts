import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseEnvFile } from "@ddl/core";

/**
 * Loads KEY=VALUE pairs from `$DDL_HOME/.env` (default `~/.daily-do-list/.env`) and `./.env.local`
 * into process.env without overriding variables that are already set.
 */
export function loadEnvFiles(): void {
  const home = process.env.DDL_HOME ?? join(homedir(), ".daily-do-list");
  for (const file of [join(home, ".env"), join(process.cwd(), ".env.local")]) {
    if (!existsSync(file)) continue;
    for (const [key, value] of parseEnvFile(readFileSync(file, "utf8"))) {
      process.env[key] ??= value;
    }
  }
}
