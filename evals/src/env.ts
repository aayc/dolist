import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Loads KEY=VALUE pairs from `$DDL_HOME/.env` (default `~/.daily-do-list/.env`) and `./.env.local`
 * into process.env without overriding variables that are already set.
 */
export function loadEnvFiles(): void {
  const home = process.env.DDL_HOME ?? join(homedir(), ".daily-do-list");
  for (const file of [join(home, ".env"), join(process.cwd(), ".env.local")]) {
    if (!existsSync(file)) continue;
    for (const raw of readFileSync(file, "utf8").split("\n")) {
      const line = raw.trim();
      if (!line || line.startsWith("#")) continue;
      const eq = line.indexOf("=");
      if (eq === -1) continue;
      const key = line.slice(0, eq).trim();
      const value = line
        .slice(eq + 1)
        .trim()
        .replace(/^["']|["']$/g, "");
      if (key && process.env[key] === undefined) process.env[key] = value;
    }
  }
}
