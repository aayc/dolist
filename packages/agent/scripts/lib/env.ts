/**
 * Loads OPENROUTER_API_KEY for smoke scripts from the environment or `~/.daily-do-list/.env`.
 * The key is returned to the caller only; never print or log it.
 */
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

const ENV_FILE = join(homedir(), ".daily-do-list", ".env");

export async function loadOpenRouterKey(): Promise<string> {
  const fromEnv = process.env.OPENROUTER_API_KEY?.trim();
  if (fromEnv) return fromEnv;
  let content: string;
  try {
    content = await readFile(ENV_FILE, "utf8");
  } catch {
    throw new Error("OPENROUTER_API_KEY is not set and ~/.daily-do-list/.env is missing");
  }
  const value = parseEnvFile(content).OPENROUTER_API_KEY;
  if (!value) throw new Error("OPENROUTER_API_KEY not found in ~/.daily-do-list/.env");
  return value;
}

export function parseEnvFile(content: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!match?.[1]) continue;
    let value = (match[2] ?? "").trim();
    const quote = value[0];
    if ((quote === '"' || quote === "'") && value.endsWith(quote) && value.length >= 2) {
      value = value.slice(1, -1);
    } else {
      value = value.replace(/\s+#.*$/, "");
    }
    out[match[1]] = value;
  }
  return out;
}
