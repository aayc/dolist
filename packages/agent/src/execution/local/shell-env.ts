/**
 * Environment hygiene for agent-run commands. The daemon holds model/provider API keys and its own
 * bearer token; a prompt-injected command must not be able to read them from its environment.
 */

/** Secrets the daemon may hold that agent commands never receive. */
export const SENSITIVE_ENV_DENYLIST: readonly string[] = [
  "OPENROUTER_API_KEY",
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "OPENAI_API_KEY",
  "GEMINI_API_KEY",
  "GOOGLE_API_KEY",
  "DDL_TOKEN",
];

/** Name patterns for the same class of secrets (daemon tokens and any provider API key). */
export const SENSITIVE_ENV_PATTERNS: readonly RegExp[] = [
  /^DDL_.*(?:TOKEN|SECRET|PASSWORD|API_?KEY)/i,
  /_API_KEY$/i,
];

const DENYLIST = new Set(SENSITIVE_ENV_DENYLIST.map((name) => name.toUpperCase()));

export function isSensitiveEnvName(name: string): boolean {
  return DENYLIST.has(name.toUpperCase()) || SENSITIVE_ENV_PATTERNS.some((re) => re.test(name));
}

/** Defaults that keep commands non-interactive and their output free of colors and pagers. */
export const NON_INTERACTIVE_ENV: Readonly<Record<string, string>> = {
  TERM: "dumb",
  NO_COLOR: "1",
  FORCE_COLOR: "0",
  PAGER: "cat",
  GIT_PAGER: "cat",
  GIT_TERMINAL_PROMPT: "0",
};

export interface ChildEnv {
  env: Record<string, string>;
  /** Names removed because they are sensitive (to also unset after the login profile runs). */
  stripped: string[];
}

/**
 * Builds the child environment: `base` + non-interactive defaults + `overrides`, minus sensitive
 * variables. Overrides are filtered too — no caller has a legitimate reason to hand the daemon's
 * secrets to an agent command.
 */
export function buildChildEnv(
  base: NodeJS.ProcessEnv,
  overrides: Record<string, string> = {},
): ChildEnv {
  const env: Record<string, string> = {};
  const stripped = new Set<string>();
  const merged: Record<string, string | undefined> = {
    ...base,
    ...NON_INTERACTIVE_ENV,
    ...overrides,
  };
  for (const [name, value] of Object.entries(merged)) {
    if (value === undefined) continue;
    if (isSensitiveEnvName(name)) stripped.add(name);
    else env[name] = value;
  }
  return { env, stripped: [...stripped].sort() };
}

const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Shell prelude that unsets `names` again: a login shell sources the user's profile, which may
 * re-export the same secrets. Only names that are valid identifiers are emitted (they are inlined
 * into shell source).
 */
export function unsetPrelude(names: readonly string[]): string {
  const safe = names.filter((name) => ENV_NAME_RE.test(name));
  return safe.length > 0 ? `unset ${safe.join(" ")} 2>/dev/null\n` : "";
}
