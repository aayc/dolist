/**
 * Loads OPENROUTER_API_KEY for smoke scripts from the environment or `~/.daily-do-list/.env`.
 * The key is returned to the caller only; never print or log it.
 */
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseEnvFile } from "@ddl/core";

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
  const value = parseEnvFile(content).get("OPENROUTER_API_KEY");
  if (!value) throw new Error("OPENROUTER_API_KEY not found in ~/.daily-do-list/.env");
  return value;
}
