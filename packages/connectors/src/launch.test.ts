// biome-ignore-all lint/suspicious/noTemplateCurlyInString: these strings are connector config placeholders under test, not template literals.
import { describe, expect, it } from "vitest";
import { parseServerConfig, type ServerSpec } from "./config";
import { ConnectorConfigError, type MissingEnvVar, MissingEnvVarError } from "./errors";
import { interpolate, resolveLaunch } from "./launch";

const HOME = "/tmp/ddl-test-home";

function spec(raw: unknown): ServerSpec {
  const parsed = parseServerConfig("srv", raw);
  if (!parsed.ok) throw new Error(parsed.error);
  return parsed.spec;
}

describe("interpolate", () => {
  const env = { TOKEN: "t0k", EMPTY: "", HOST: "api.example.com" };

  function run(value: string) {
    const missing: MissingEnvVar[] = [];
    return { value: interpolate(value, env, "field", missing, "srv"), missing };
  }

  it("substitutes every supported placeholder form", () => {
    expect(run("Bearer ${TOKEN}").value).toBe("Bearer t0k");
    expect(run("Bearer $TOKEN!").value).toBe("Bearer t0k!");
    expect(run("${env:HOST}/v1").value).toBe("api.example.com/v1");
    expect(run("${ TOKEN }").value).toBe("t0k");
  });

  it("uses fallbacks for unset or empty variables", () => {
    expect(run("${UNSET:-fallback}").value).toBe("fallback");
    expect(run("${EMPTY:-fallback}").value).toBe("fallback");
    expect(run("${TOKEN:-fallback}").value).toBe("t0k");
    expect(run("${UNSET:-}").missing).toEqual([]);
  });

  it("keeps literal dollars", () => {
    expect(run("price $5, a$ and $$HOME").value).toBe("price $5, a$ and $HOME");
    expect(run("trailing $").value).toBe("trailing $");
  });

  it("collects missing variables instead of throwing", () => {
    const result = run("${MISSING_A}-$MISSING_B-${EMPTY}");
    expect(result.value).toBe("--");
    expect(result.missing).toEqual([
      { variable: "MISSING_A", field: "field" },
      { variable: "MISSING_B", field: "field" },
    ]);
  });

  it("rejects malformed placeholders with a helpful message", () => {
    expect(() => run("${TOKEN")).toThrow(/Unterminated "\$\{" in field/);
    expect(() => run("${input:github_token}")).toThrow(ConnectorConfigError);
    expect(() => run("${input:github_token}")).toThrow(/use \$\{NAME\} or \$NAME/);
  });
});

describe("resolveLaunch", () => {
  it("resolves stdio commands, args, env and cwd, expanding ~", () => {
    const launch = resolveLaunch(
      spec({
        command: "~/bin/${TOOL}",
        args: ["--root", "~/notes", "--key=$KEY"],
        env: { API_KEY: "${KEY}", PLAIN: "value" },
        cwd: "~",
      }),
      { TOOL: "server", KEY: "k-123" },
      HOME,
    );
    expect(launch).toEqual({
      type: "stdio",
      command: `${HOME}/bin/server`,
      args: ["--root", "~/notes", "--key=k-123"],
      env: { API_KEY: "k-123", PLAIN: "value" },
      cwd: HOME,
    });
  });

  it("reports all missing variables of a server at once, naming the fields", () => {
    let caught: unknown;
    try {
      resolveLaunch(
        spec({ command: "srv", args: ["$A"], env: { TOKEN: "${B}", OTHER: "${B}" } }),
        {},
        HOME,
      );
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(MissingEnvVarError);
    const error = caught as MissingEnvVarError;
    expect(error.variables).toEqual(["A", "B"]);
    expect(error.serverName).toBe("srv");
    expect(error.message).toBe(
      "Environment variables not set: A (in args[0]), B (in env.TOKEN), B (in env.OTHER)",
    );
  });

  it("resolves http urls and headers", () => {
    const launch = resolveLaunch(
      spec({
        url: "https://${HOST}/mcp?team=$TEAM",
        headers: { Authorization: "Bearer ${TOKEN}" },
      }),
      { HOST: "mcp.example.com", TEAM: "a b", TOKEN: "t" },
      HOME,
    );
    expect(launch.type).toBe("http");
    if (launch.type === "stdio") return;
    expect(launch.url.href).toBe("https://mcp.example.com/mcp?team=a%20b");
    expect(launch.headers).toEqual({ Authorization: "Bearer t" });
  });

  it("validates urls and header values after substitution without echoing them", () => {
    const remote = spec({ url: "${URL}", headers: { Authorization: "${TOKEN}" } });
    expect(() => resolveLaunch(remote, { URL: "not a url", TOKEN: "x" }, HOME)).toThrow(
      '"url" is not a valid URL after substitution',
    );
    expect(() => resolveLaunch(remote, { URL: "file:///etc/passwd", TOKEN: "x" }, HOME)).toThrow(
      '"url" must start with http:// or https://',
    );
    expect(() =>
      resolveLaunch(remote, { URL: "https://x.example", TOKEN: "line1\nline2" }, HOME),
    ).toThrow('"headers.Authorization" is not a valid HTTP header value');
  });
});
