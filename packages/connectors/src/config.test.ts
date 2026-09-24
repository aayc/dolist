import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  DEFAULT_CONNECT_TIMEOUT_MS,
  DEFAULT_REQUEST_TIMEOUT_MS,
  EMPTY_CONNECTORS_CONFIG,
  launchFingerprint,
  loadConnectorsConfig,
  normalizeConnectorsConfig,
  type ParsedServerConfig,
  parseServerConfig,
  type ServerSpec,
} from "./config";
import { ConnectorConfigError } from "./errors";

function specOf(parsed: ParsedServerConfig): ServerSpec {
  if (!parsed.ok) throw new Error(`expected a valid config, got: ${parsed.error}`);
  return parsed.spec;
}

function errorOf(parsed: ParsedServerConfig): string {
  if (parsed.ok) throw new Error("expected an invalid config");
  return parsed.error;
}

describe("normalizeConnectorsConfig", () => {
  it("accepts the Claude Desktop / Cursor shape and infers types", () => {
    const config = normalizeConnectorsConfig({
      mcpServers: {
        files: { command: "npx", args: ["-y", "server-filesystem"] },
        remote: { url: "https://mcp.example.com/mcp" },
      },
      globalShortcut: "Cmd+Space",
    });
    expect(config.mcpServers.files).toMatchObject({ type: "stdio", command: "npx" });
    expect(config.mcpServers.remote).toMatchObject({
      type: "http",
      url: "https://mcp.example.com/mcp",
    });
  });

  it("accepts OpenClaw's mcp.servers shape and its aliases", () => {
    const config = normalizeConnectorsConfig({
      mcp: {
        servers: {
          a: {
            url: "https://a.example.com/mcp",
            transport: "streamable-http",
            connectionTimeoutMs: 5,
          },
          b: { url: "https://b.example.com/sse", transport: "sse" },
          c: { command: "srv", transport: "stdio" },
          d: { type: "streamableHttp", url: "https://d.example.com/mcp", disabled: true },
        },
      },
    });
    expect(config.mcpServers.a).toMatchObject({ type: "http", connectTimeoutMs: 5 });
    expect(config.mcpServers.a).not.toHaveProperty("transport");
    expect(config.mcpServers.b).toMatchObject({ type: "sse" });
    expect(config.mcpServers.c).toMatchObject({ type: "stdio" });
    expect(config.mcpServers.d).toMatchObject({ type: "http", enabled: false });
  });

  it("merges both shapes, with mcpServers winning on duplicate names", () => {
    const config = normalizeConnectorsConfig({
      mcp: { servers: { shared: { command: "old" }, onlyNested: { command: "nested" } } },
      mcpServers: { shared: { command: "new" } },
    });
    expect(Object.keys(config.mcpServers).sort()).toEqual(["onlyNested", "shared"]);
    expect(config.mcpServers.shared).toMatchObject({ command: "new" });
  });

  it("rejects files that are not objects or whose server maps are not objects", () => {
    expect(() => normalizeConnectorsConfig([])).toThrow(ConnectorConfigError);
    expect(() => normalizeConnectorsConfig({ mcpServers: [] })).toThrow(
      /"mcpServers" must be an object/,
    );
    expect(() => normalizeConnectorsConfig({ mcp: { servers: "x" } })).toThrow(/"mcp.servers"/);
  });

  it("keeps odd server names as plain own properties", () => {
    const config = normalizeConnectorsConfig(
      JSON.parse('{"mcpServers":{"__proto__":{"command":"x"}}}'),
    );
    expect(Object.keys(config.mcpServers)).toEqual(["__proto__"]);
    expect(Object.getPrototypeOf(config.mcpServers)).toBe(Object.prototype);
  });
});

describe("parseServerConfig", () => {
  it("applies defaults", () => {
    expect(specOf(parseServerConfig("files", { command: " npx " }))).toEqual({
      name: "files",
      enabled: true,
      type: "stdio",
      command: "npx",
      args: [],
      env: {},
      cwd: undefined,
      connectTimeoutMs: DEFAULT_CONNECT_TIMEOUT_MS,
      requestTimeoutMs: DEFAULT_REQUEST_TIMEOUT_MS,
      toolFilter: undefined,
      approval: "auto",
      description: undefined,
    });
  });

  it("parses a full http entry", () => {
    const spec = specOf(
      parseServerConfig("gh", {
        type: "http",
        url: "https://mcp.example.com/mcp",
        headers: { Authorization: "Bearer $TOKEN" },
        connectTimeoutMs: 1_500.7,
        requestTimeoutMs: 10_000,
        toolFilter: { include: ["read_*"], exclude: ["read_secrets"] },
        approval: "writes",
        description: "  GitHub  ",
      }),
    );
    expect(spec).toMatchObject({
      type: "http",
      headers: { Authorization: "Bearer $TOKEN" },
      connectTimeoutMs: 1_500,
      requestTimeoutMs: 10_000,
      toolFilter: { include: ["read_*"], exclude: ["read_secrets"] },
      approval: "writes",
      description: "GitHub",
    });
  });

  it("reports every problem of an entry in one message, without echoing values", () => {
    const error = errorOf(
      parseServerConfig("bad", {
        command: "srv",
        args: ["ok", 3],
        env: { SECRET_NUMBER: 12345, "BAD=NAME": "x" },
        approval: "sometimes",
        connectTimeoutMs: -5,
        requestTimeoutMs: "fast",
        toolFilter: { include: [""], exlude: ["delete_*"] },
        enabled: "yes",
      }),
    );
    expect(error).toContain('"args[1]" must be a string (got number)');
    expect(error).toContain('"env.SECRET_NUMBER" must be a string (got number)');
    expect(error).toContain('"env" has an invalid variable name "BAD=NAME"');
    expect(error).toContain('"approval" must be "auto", "always" or "writes"');
    expect(error).toContain('"connectTimeoutMs" must be a positive number of milliseconds');
    expect(error).toContain('"requestTimeoutMs" must be a positive number of milliseconds');
    expect(error).toContain('"toolFilter.include[0]" must be a non-empty string');
    expect(error).toContain('"toolFilter.exlude" is not supported');
    expect(error).toContain('"enabled" must be true or false');
    expect(error).not.toContain("12345");
  });

  it("rejects contradictory or unknown transports", () => {
    expect(errorOf(parseServerConfig("x", { command: "a", url: "https://x.example" }))).toContain(
      'has both "command" (stdio) and "url"',
    );
    expect(errorOf(parseServerConfig("x", {}))).toContain(
      'needs "command" (stdio server) or "url"',
    );
    expect(errorOf(parseServerConfig("x", { type: "stdio", command: "a", url: "u" }))).toContain(
      '"url" is not valid for stdio servers',
    );
    expect(
      errorOf(parseServerConfig("x", { type: "sse", url: "https://x.example", cwd: "/" })),
    ).toContain('"cwd" is not valid for sse servers');
    expect(errorOf(parseServerConfig("x", { type: "pigeon", command: "a" }))).toContain(
      '"type" must be "stdio", "http" or "sse" (got "pigeon")',
    );
    expect(
      errorOf(parseServerConfig("x", { type: "http", transport: "sse", url: "https://x.example" })),
    ).toContain('"transport" conflicts with "type"');
    expect(
      errorOf(parseServerConfig("x", { command: "a", enabled: true, disabled: true })),
    ).toContain('"disabled" conflicts with "enabled"');
    expect(errorOf(parseServerConfig("x", "npx server"))).toBe(
      "Server config must be an object (got string)",
    );
    expect(errorOf(parseServerConfig(" ", { command: "a" }))).toContain(
      "server name must not be empty",
    );
  });

  it("accepts aliases that agree with the canonical keys", () => {
    const spec = specOf(
      parseServerConfig("x", {
        type: "http",
        transport: "streamable-http",
        url: "https://x.example/mcp",
        connectTimeoutMs: 100,
        connectionTimeoutMs: 100,
        enabled: false,
        disabled: true,
      }),
    );
    expect(spec).toMatchObject({ type: "http", connectTimeoutMs: 100, enabled: false });
  });

  it("errors on unknown options but only warns for keys other clients write", () => {
    expect(errorOf(parseServerConfig("x", { command: "a", aproval: "always" }))).toContain(
      'unknown option "aproval"',
    );
    const parsed = parseServerConfig("x", { command: "a", autoApprove: ["read"], timeout: 60 });
    expect(parsed.ok).toBe(true);
    expect(parsed.ok && parsed.warnings).toEqual([
      'option "autoApprove" is not supported and is ignored',
      'option "timeout" is not supported and is ignored',
    ]);
  });

  it("validates URLs eagerly unless they contain placeholders", () => {
    expect(errorOf(parseServerConfig("x", { url: "ftp://files.example" }))).toContain(
      '"url" must start with http:// or https://',
    );
    expect(errorOf(parseServerConfig("x", { url: "not a url" }))).toContain(
      '"url" is not a valid URL',
    );
    expect(parseServerConfig("x", { url: "https://$HOST/mcp" }).ok).toBe(true);
    expect(
      errorOf(parseServerConfig("x", { url: "https://x.example", headers: { "Bad Header": "v" } })),
    ).toContain('"headers" has an invalid header name "Bad Header"');
  });

  it("keeps the enabled flag of invalid entries so disabled ones are not reported as errors", () => {
    const parsed = parseServerConfig("later", { enabled: false, command: 5 });
    expect(parsed).toMatchObject({ ok: false, enabled: false, transport: "stdio" });
    expect(parseServerConfig("remote", { url: 5 })).toMatchObject({ ok: false, transport: "http" });
  });
});

describe("launchFingerprint", () => {
  const base = { command: "srv", args: ["a"], env: { A: "1", B: "2" } };

  it("ignores key order and policy-only fields", () => {
    const a = specOf(parseServerConfig("s", base));
    const b = specOf(
      parseServerConfig("s", {
        env: { B: "2", A: "1" },
        args: ["a"],
        command: "srv",
        approval: "always",
      }),
    );
    expect(launchFingerprint(a)).toBe(launchFingerprint(b));
  });

  it("changes with anything that needs a new process", () => {
    const a = specOf(parseServerConfig("s", base));
    expect(launchFingerprint(specOf(parseServerConfig("s", { ...base, args: ["b"] })))).not.toBe(
      launchFingerprint(a),
    );
    expect(launchFingerprint(specOf(parseServerConfig("s", { ...base, cwd: "/tmp" })))).not.toBe(
      launchFingerprint(a),
    );
  });
});

describe("loadConnectorsConfig", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "ddl-connectors-config-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("treats a missing or empty file as an empty config", async () => {
    await expect(loadConnectorsConfig(join(dir, "missing.json"))).resolves.toEqual(
      EMPTY_CONNECTORS_CONFIG,
    );
    await writeFile(join(dir, "empty.json"), "  \n");
    await expect(loadConnectorsConfig(join(dir, "empty.json"))).resolves.toEqual({
      mcpServers: {},
    });
  });

  it("throws a helpful error for invalid JSON", async () => {
    const path = join(dir, "broken.json");
    await writeFile(path, '{ "mcpServers": { "a": { "command": "x", } } }');
    await expect(loadConnectorsConfig(path)).rejects.toThrow(ConnectorConfigError);
    await expect(loadConnectorsConfig(path)).rejects.toThrow(/is not valid JSON/);
  });

  it("keeps invalid servers so the manager can report them, and tolerates a BOM", async () => {
    const path = join(dir, "mcp.json");
    await writeFile(
      path,
      `\uFEFF${JSON.stringify({ mcpServers: { good: { command: "srv" }, bad: { command: 42 } } })}`,
    );
    const config = await loadConnectorsConfig(path);
    expect(Object.keys(config.mcpServers)).toEqual(["good", "bad"]);
    expect(parseServerConfig("good", config.mcpServers.good).ok).toBe(true);
    expect(errorOf(parseServerConfig("bad", config.mcpServers.bad))).toContain(
      '"command" must be a string (got number)',
    );
  });
});
