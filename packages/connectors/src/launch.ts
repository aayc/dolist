/**
 * Connect-time resolution of a validated server spec: environment-variable interpolation and `~`
 * expansion. It runs on every connection attempt, so fixing a variable needs no config reload.
 *
 * Placeholder syntax (in `command`, `args`, `env` values, `cwd`, `url` and `headers` values):
 *   ${NAME}  $NAME  ${env:NAME} (Cursor)  ${NAME:-fallback}  $$ (a literal "$")
 */
import { homedir } from "node:os";
import { join } from "node:path";
import { truncate } from "@ddl/core";
import type { ServerSpec } from "./config";
import { ConnectorConfigError, type MissingEnvVar, MissingEnvVarError } from "./errors";
import { defineOwn } from "./util";

export type EnvSource = Readonly<Record<string, string | undefined>>;

export interface StdioLaunch {
  readonly type: "stdio";
  readonly command: string;
  readonly args: string[];
  /** Only the configured variables; the transport adds the SDK's safe default environment. */
  readonly env: Record<string, string>;
  readonly cwd: string | undefined;
}

export interface HttpLaunch {
  readonly type: "http" | "sse";
  readonly url: URL;
  readonly headers: Record<string, string>;
}

export type ServerLaunch = StdioLaunch | HttpLaunch;

const PLACEHOLDER_RE = /\$\$|\$\{([^}]*)\}|\$\{|\$([A-Za-z_][A-Za-z0-9_]*)/g;
const BRACED_RE = /^(?:env:)?([A-Za-z_][A-Za-z0-9_]*)(?::-([\s\S]*))?$/;

/**
 * Substitutes placeholders in one config value. Unset variables are appended to `missing` (and
 * become ""), so every missing variable of a server is reported at once.
 */
export function interpolate(
  value: string,
  env: EnvSource,
  field: string,
  missing: MissingEnvVar[],
  serverName: string,
): string {
  const lookup = (variable: string, fallback: string | undefined): string => {
    const found = env[variable];
    if (fallback !== undefined) return found === undefined || found === "" ? fallback : found;
    if (found === undefined) missing.push({ variable, field });
    return found ?? "";
  };
  return value.replace(
    PLACEHOLDER_RE,
    (match, braced: string | undefined, bare: string | undefined) => {
      if (match === "$$") return "$";
      if (bare !== undefined) return lookup(bare, undefined);
      if (braced === undefined) {
        throw new ConnectorConfigError(`Unterminated "\${" in ${field}`, serverName);
      }
      const parsed = BRACED_RE.exec(braced.trim());
      if (!parsed?.[1]) {
        throw new ConnectorConfigError(
          `Unsupported placeholder "\${${truncate(braced, 40)}}" in ${field}; use \${NAME} or $NAME ` +
            `for an environment variable ($$ for a literal "$")`,
          serverName,
        );
      }
      // `${A:-${B}}` would otherwise end at the first `}` and leave a stray one in the value.
      if (parsed[2]?.includes("${")) {
        throw new ConnectorConfigError(
          `Nested placeholders are not supported (default of ${parsed[1]} in ${field})`,
          serverName,
        );
      }
      return lookup(parsed[1], parsed[2]);
    },
  );
}

/** Resolves placeholders and paths. Throws `ConnectorConfigError` / `MissingEnvVarError`. */
export function resolveLaunch(
  spec: ServerSpec,
  env: EnvSource,
  home: string = homedir(),
): ServerLaunch {
  const missing: MissingEnvVar[] = [];
  const sub = (value: string, field: string) => interpolate(value, env, field, missing, spec.name);
  const subRecord = (record: Readonly<Record<string, string>>, field: string) => {
    const out: Record<string, string> = {};
    for (const [key, value] of Object.entries(record))
      defineOwn(out, key, sub(value, `${field}.${key}`));
    return out;
  };

  if (spec.type === "stdio") {
    const command = expandHome(sub(spec.command, "command"), home);
    const args = spec.args.map((arg, index) => sub(arg, `args[${index}]`));
    const childEnv = subRecord(spec.env, "env");
    const cwd = spec.cwd === undefined ? undefined : expandHome(sub(spec.cwd, "cwd"), home);
    if (missing.length > 0) throw new MissingEnvVarError(spec.name, missing);
    return { type: "stdio", command, args, env: childEnv, cwd };
  }

  const urlText = sub(spec.url, "url");
  const headers = subRecord(spec.headers, "headers");
  if (missing.length > 0) throw new MissingEnvVarError(spec.name, missing);
  let url: URL;
  try {
    url = new URL(urlText);
  } catch {
    throw new ConnectorConfigError('"url" is not a valid URL after substitution', spec.name);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new ConnectorConfigError('"url" must start with http:// or https://', spec.name);
  }
  for (const [name, value] of Object.entries(headers)) {
    // Checked one by one so the error can name the header without echoing its (secret) value.
    try {
      new Headers([[name, value]]);
    } catch {
      throw new ConnectorConfigError(
        `"headers.${name}" is not a valid HTTP header value`,
        spec.name,
      );
    }
  }
  return { type: spec.type, url, headers };
}

function expandHome(value: string, home: string): string {
  if (home === "") return value;
  if (value === "~") return home;
  return value.startsWith("~/") ? join(home, value.slice(2)) : value;
}
