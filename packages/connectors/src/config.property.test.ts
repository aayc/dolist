// biome-ignore-all lint/suspicious/noTemplateCurlyInString: connector config placeholders under test, not template literals.
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fc, test } from "@fast-check/vitest";
import { afterAll, describe, expect, it } from "vitest";
import {
  DEFAULT_CONNECT_TIMEOUT_MS,
  loadConnectorsConfig,
  normalizeConnectorsConfig,
  parseServerConfig,
} from "./config";
import { ConnectorConfigError, type MissingEnvVar, MissingEnvVarError } from "./errors";
import { interpolate, resolveLaunch } from "./launch";

const runs = (factor: number) =>
  Math.max(1, Math.round((fc.readConfigureGlobal().numRuns ?? 100) * factor));

const KNOWN = [
  "type",
  "enabled",
  "connectTimeoutMs",
  "requestTimeoutMs",
  "toolFilter",
  "approval",
  "description",
  "command",
  "args",
  "env",
  "cwd",
  "url",
  "headers",
];
const FOREIGN = ["autoApprove", "alwaysAllow", "disabledTools", "timeout", "$comment"];
const ALIASES = ["transport", "connectionTimeoutMs", "disabled"];

const value = fc.oneof(
  fc.string({ maxLength: 20 }),
  fc.integer(),
  fc.double(),
  fc.boolean(),
  fc.constant(null),
  fc.array(fc.string({ maxLength: 8 }), { maxLength: 3 }),
  fc.dictionary(fc.string({ maxLength: 8 }), fc.string({ maxLength: 8 }), { maxKeys: 3 }),
);

/** Server entries built from real keys with random (often wrong) values, plus unknown keys. */
const serverEntry = fc.oneof(
  fc.record(
    {
      type: fc.oneof(
        fc.constantFrom("stdio", "http", "sse", "STDIO ", "streamable-http", "websocket"),
        value,
      ),
      command: fc.oneof(fc.constantFrom("npx", "~/bin/srv", "${TOOL}", " "), value),
      args: fc.oneof(fc.array(fc.string({ maxLength: 10 }), { maxLength: 4 }), value),
      env: fc.oneof(fc.dictionary(fc.string({ maxLength: 8 }), fc.string({ maxLength: 8 })), value),
      url: fc.oneof(
        fc.constantFrom(
          "https://mcp.example.com/mcp",
          "http://127.0.0.1:3000",
          "${URL}",
          "ftp://x",
          "javascript:alert(1)",
          "nope",
        ),
        value,
      ),
      headers: fc.oneof(
        fc.dictionary(
          fc.oneof(fc.stringMatching(/^[A-Za-z-]{1,10}$/), fc.string({ maxLength: 6 })),
          fc.string({ maxLength: 12 }),
        ),
        value,
      ),
      enabled: value,
      disabled: value,
      approval: fc.oneof(fc.constantFrom("auto", "writes", "always", "never", "WRITES"), value),
      connectTimeoutMs: fc.oneof(fc.integer({ min: -5, max: 3_000_000_000 }), fc.double(), value),
      toolFilter: fc.oneof(
        fc.record(
          {
            include: fc.array(fc.string({ maxLength: 6 })),
            exclude: fc.array(fc.string({ maxLength: 6 })),
          },
          { requiredKeys: [] },
        ),
        fc.record({ inlcude: fc.array(fc.string()) }),
        value,
      ),
      description: value,
      autoApprove: value,
      aproval: value,
      __proto__: value,
    },
    { requiredKeys: [] },
  ),
  fc.anything(),
);

describe("parseServerConfig", () => {
  test.prop([fc.string({ maxLength: 20 }), serverEntry], { numRuns: runs(3) })(
    "never throws: a valid spec or a per-server error",
    (name, raw) => {
      const parsed = parseServerConfig(name, raw);
      if (!parsed.ok) {
        expect(parsed.error).toMatch(/^(?:Invalid config: |Server config must be an object)/);
        expect(parsed.name).toBe(name);
        expect(["stdio", "http", "sse"]).toContain(parsed.transport);
        return;
      }
      const { spec } = parsed;
      expect(name.trim()).not.toBe("");
      expect(["stdio", "http", "sse"]).toContain(spec.type);
      expect(["auto", "writes", "always"]).toContain(spec.approval);
      for (const ms of [spec.connectTimeoutMs, spec.requestTimeoutMs]) {
        expect(Number.isInteger(ms) && ms >= 1 && ms <= 2_147_483_647).toBe(true);
      }
      if (spec.type === "stdio") {
        expect(spec.command.trim()).not.toBe("");
        for (const arg of spec.args) expect(typeof arg).toBe("string");
        for (const v of Object.values(spec.env)) expect(typeof v).toBe("string");
      } else {
        for (const v of Object.values(spec.headers)) expect(typeof v).toBe("string");
      }
      // Strict: nothing unknown survived validation.
      const entry = raw as Record<string, unknown>;
      for (const key of Object.keys(entry))
        expect([...KNOWN, ...FOREIGN, ...ALIASES], key).toContain(key);
    },
  );

  test.prop([
    fc
      .stringMatching(/^[a-z][a-zA-Z]{2,12}$/)
      .filter((k) => ![...KNOWN, ...FOREIGN, ...ALIASES].includes(k)),
  ])("rejects any unknown option (a typo must never weaken a server)", (key) => {
    const parsed = parseServerConfig("srv", { command: "npx", approval: "always", [key]: true });
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.error).toContain(`unknown option "${key}"`);
  });

  test.prop([fc.constantFrom(...FOREIGN), value])(
    "accepts other clients' keys with a warning and never lets them relax approval",
    (key, v) => {
      const parsed = parseServerConfig("srv", { command: "npx", approval: "always", [key]: v });
      expect(parsed).toMatchObject({ ok: true, spec: { approval: "always" } });
      if (parsed.ok)
        expect(parsed.warnings).toEqual([`option "${key}" is not supported and is ignored`]);
    },
  );

  it("applies defaults and aliases", () => {
    expect(
      parseServerConfig("a", {
        transport: "streamable-http",
        url: "https://x.example.com",
        disabled: true,
      }),
    ).toMatchObject({
      ok: true,
      spec: { type: "http", enabled: false, connectTimeoutMs: DEFAULT_CONNECT_TIMEOUT_MS },
    });
  });
});

describe("normalizeConnectorsConfig", () => {
  const servers = fc.dictionary(
    fc.oneof(fc.string({ maxLength: 10 }), fc.constantFrom("__proto__", "constructor")),
    serverEntry,
    { maxKeys: 5 },
  );

  test.prop([
    fc.record(
      {
        mcpServers: fc.oneof(servers, value),
        mcp: fc.oneof(fc.record({ servers: fc.oneof(servers, value) }), value),
      },
      { requiredKeys: [] },
    ),
  ])("throws only ConnectorConfigError, and mcpServers wins on duplicate names", (config) => {
    let normalized: ReturnType<typeof normalizeConnectorsConfig>;
    try {
      normalized = normalizeConnectorsConfig(JSON.parse(JSON.stringify(config)));
    } catch (error) {
      expect(error).toBeInstanceOf(ConnectorConfigError);
      return;
    }
    expect(Object.getPrototypeOf(normalized.mcpServers)).toBe(Object.prototype);
    const top = config.mcpServers;
    if (top && typeof top === "object" && !Array.isArray(top))
      for (const name of Object.keys(JSON.parse(JSON.stringify(top))))
        expect(Object.hasOwn(normalized.mcpServers, name)).toBe(true);
    for (const [name, raw] of Object.entries(normalized.mcpServers))
      expect(() => parseServerConfig(name, raw)).not.toThrow();
  });

  test.prop([fc.anything()])("rejects non-object roots with ConnectorConfigError", (config) => {
    try {
      normalizeConnectorsConfig(config);
    } catch (error) {
      expect(error).toBeInstanceOf(ConnectorConfigError);
    }
  });
});

describe("loadConnectorsConfig", () => {
  const dirs: string[] = [];
  afterAll(async () => {
    await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true })));
  });

  it.each([
    ["", { mcpServers: {} }],
    ["   \n", { mcpServers: {} }],
    [
      '\uFEFF{"mcpServers":{"a":{"command":"x"}}}',
      { mcpServers: { a: { command: "x", type: "stdio" } } },
    ],
    [
      '{"mcp":{"servers":{"b":{"url":"https://x.example.com"}}}}',
      { mcpServers: { b: { url: "https://x.example.com", type: "http" } } },
    ],
  ])("reads %j", async (text, expected) => {
    const dir = await mkdtemp(join(tmpdir(), "ddl-connectors-"));
    dirs.push(dir);
    const path = join(dir, "mcp.json");
    await writeFile(path, text);
    await expect(loadConnectorsConfig(path)).resolves.toEqual(expected);
  });

  it.each(["{not json", "[1,2]", "42", '{"mcpServers": []}', '{"mcp": 5}'])(
    "rejects %j with ConnectorConfigError",
    async (text) => {
      const dir = await mkdtemp(join(tmpdir(), "ddl-connectors-"));
      dirs.push(dir);
      const path = join(dir, "mcp.json");
      await writeFile(path, text);
      await expect(loadConnectorsConfig(path)).rejects.toBeInstanceOf(ConnectorConfigError);
    },
  );

  it("treats a missing file as an empty config", async () => {
    await expect(loadConnectorsConfig(join(tmpdir(), "ddl-missing", "mcp.json"))).resolves.toEqual({
      mcpServers: {},
    });
  });
});

// ── Environment interpolation ────────────────────────────────────────────────

function run(text: string, env: Record<string, string | undefined>) {
  const missing: MissingEnvVar[] = [];
  return { value: interpolate(text, env, "field", missing, "srv"), missing };
}

describe("interpolate", () => {
  it.each<[string, string]>([
    ["$$", "$"],
    ["$$$", "$$"],
    ["$$A", "$A"],
    ["a$", "a$"],
    ["$", "$"],
    ["$1 and $@", "$1 and $@"],
    ["}", "}"],
    ["${A}}", "1}"],
    ["$A$A", "11"],
    ["${ A }", "1"],
    ["${env:A}", "1"],
    ["${E:-fallback}", "fallback"],
    ["${U:-}", ""],
    ["${A:-x}", "1"],
    ["${D}", "$HOME"],
    ["\\$A", "\\1"],
    ["price: $5.00", "price: $5.00"],
  ])("%s → %s", (text, expected) => {
    expect(run(text, { A: "1", E: "", D: "$HOME" }).value).toBe(expected);
  });

  it.each(["${}", "${env:}", "${A-x}", "${A:=x}", "${A${B}}", "${A:-${B}}", "${", "x${y"])(
    "rejects %s with ConnectorConfigError (never a silently wrong value)",
    (text) => {
      expect(() => run(text, { A: "1", B: "2" })).toThrow(ConnectorConfigError);
    },
  );

  test.prop([fc.string({ maxLength: 40 }).filter((s) => !s.includes("$"))])(
    "leaves text without $ unchanged",
    (text) => {
      expect(run(text, {}).value).toBe(text);
    },
  );

  test.prop([
    fc.stringMatching(/^[A-Z_][A-Z0-9_]{0,10}$/),
    fc.oneof(fc.string({ maxLength: 30 }), fc.constantFrom("$$", "${OTHER}", "$HOME", "a$b")),
    fc.constantFrom(
      (n: string) => `\${${n}}`,
      (n: string) => `\${env:${n}}`,
      (n: string) => `\${${n}:-unused}`,
    ),
    fc.string({ maxLength: 10 }).filter((s) => !s.includes("$")),
    fc.string({ maxLength: 10 }).filter((s) => !s.includes("$")),
  ])(
    "substitutes values verbatim, never re-interpolating them",
    (name, v, placeholder, pre, post) => {
      fc.pre(v !== "");
      expect(run(`${pre}${placeholder(name)}${post}`, { [name]: v }).value).toBe(
        `${pre}${v}${post}`,
      );
    },
  );

  test.prop([
    fc.stringMatching(/^[A-Z][A-Z0-9_]{0,10}$/),
    fc.string({ minLength: 8, maxLength: 30 }),
  ])("reports missing variables by name without ever echoing other values", (name, secret) => {
    let caught: unknown;
    try {
      resolveLaunch(
        {
          name: "srv",
          type: "stdio",
          enabled: true,
          connectTimeoutMs: 1,
          requestTimeoutMs: 1,
          toolFilter: undefined,
          approval: "auto",
          description: undefined,
          command: "srv",
          args: [`--token=\${${name}_MISSING}`],
          env: { KEY: "${PRESENT}" },
          cwd: undefined,
        },
        { PRESENT: secret },
        "/tmp",
      );
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(MissingEnvVarError);
    expect((caught as Error).message).toContain(`${name}_MISSING`);
    expect((caught as Error).message).not.toContain(secret);
  });
});
