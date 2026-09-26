import { chmodSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { fc, test } from "@fast-check/vitest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ConfigError, loadConfig, summarizeConfig } from "../config";
import { loadEnvFiles, parseEnvFile } from "../env-file";
import { displayPath, resolveUserPath } from "../home-paths";
import { tempDir } from "../test-helpers";

const KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;
const envKey = fc.stringMatching(KEY).filter((k) => k.length <= 30 && k !== "export");

describe("parseEnvFile corpus", () => {
  const corpus: Array<[string, Record<string, string>]> = [
    ["KEY=value", { KEY: "value" }],
    ["export KEY=value", { KEY: "value" }],
    ["export\tKEY=value", { KEY: "value" }],
    ["  KEY = value  ", { KEY: "value" }],
    ["KEY=", { KEY: "" }],
    ['KEY=""', { KEY: "" }],
    ["KEY=''", { KEY: "" }],
    ["KEY=a=b=c", { KEY: "a=b=c" }],
    ["KEY==x", { KEY: "=x" }],
    ['KEY="a=b=c"', { KEY: "a=b=c" }],
    ["KEY='single # not a comment'", { KEY: "single # not a comment" }],
    ['KEY="double # not a comment"', { KEY: "double # not a comment" }],
    ["KEY=value # comment", { KEY: "value" }],
    ["KEY=value\t# comment", { KEY: "value" }],
    ["KEY=value#not-a-comment", { KEY: "value#not-a-comment" }],
    ["OPENROUTER_API_KEY=sk-or-v1-abc # my key", { OPENROUTER_API_KEY: "sk-or-v1-abc" }],
    ["# KEY=commented", {}],
    ["   # indented comment", {}],
    ["KEY", {}],
    ["export KEY", {}],
    ["=value", {}],
    ["1KEY=x", {}],
    ["KEY-NAME=x", {}],
    ["KEY.NAME=x", {}],
    ["ÄKEY=x", {}],
    ["exportKEY=x", { exportKEY: "x" }],
    ["KEY=日本語", { KEY: "日本語" }],
    ["KEY=😀 ok", { KEY: "😀 ok" }],
    ["\uFEFFKEY=bom", { KEY: "bom" }],
    ["A=1\r\nB=2\r\n", { A: "1", B: "2" }],
    ["A=1\rB=2\r", { A: "1", B: "2" }],
    ["A=1\n\n\n\nB=2", { A: "1", B: "2" }],
    ['A="x\u2028y"\nB=p\u2029q', { A: "x\u2028y", B: "p\u2029q" }],
    ['KEY="line1\\nline2"', { KEY: "line1\nline2" }],
    ['KEY="tab\\there\\r"', { KEY: "tab\there\r" }],
    ['KEY="quote \\" inside"', { KEY: 'quote " inside' }],
    ['KEY="backslash \\\\ end"', { KEY: "backslash \\ end" }],
    ['KEY="unknown \\q escape"', { KEY: "unknown q escape" }],
    ["KEY='no \\n escapes'", { KEY: "no \\n escapes" }],
    ['KEY="unterminated', {}],
    ["KEY='unterminated", {}],
    ['KEY="a" trailing junk', { KEY: "a" }],
    ['KEY="multi\nline"', {}],
    ["KEY=first\nKEY=second", { KEY: "second" }],
    ["KEY=  spaced value  ", { KEY: "spaced value" }],
    ["KEY=\t\ttabbed", { KEY: "tabbed" }],
    ["KEY=$HOME", { KEY: "$HOME" }],
    // biome-ignore lint/suspicious/noTemplateCurlyInString: the parser must not interpolate this.
    ["KEY=${OTHER}", { KEY: "${OTHER}" }],
    ['KEY="$(rm -rf ~)"', { KEY: "$(rm -rf ~)" }],
    ["KEY=`id`", { KEY: "`id`" }],
    ["__proto__=polluted", Object.fromEntries([["__proto__", "polluted"]])],
    ["constructor=x", { constructor: "x" }],
  ];

  it.each(corpus)("parses %j", (source, expected) => {
    const parsed = parseEnvFile(source);
    expect(parsed).toBeInstanceOf(Map);
    expect([...parsed]).toEqual(Object.entries(expected));
  });

  it("keeps prototype-like keys as plain entries without polluting objects", () => {
    const env: Record<string, string | undefined> = {};
    const dir = tempDir("ddl-env-proto-");
    try {
      writeFileSync(join(dir.path, ".env"), "__proto__=polluted\nconstructor=x\n");
      loadEnvFiles([join(dir.path, ".env")], env);
    } finally {
      dir.cleanup();
    }
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(Object.getPrototypeOf(env)).toBe(Object.prototype);
  });
});

describe("parseEnvFile properties", () => {
  test.prop([fc.string({ unit: "binary", maxLength: 500 })])(
    "never throws and only yields valid names",
    (source) => {
      for (const key of parseEnvFile(source).keys()) expect(key).toMatch(KEY);
    },
  );

  const lineEnding = fc.constantFrom("\n", "\r\n", "\r");
  const filler = fc.constantFrom("", "# a comment", "   ", "not an assignment", "# X=1");
  const pad = fc.constantFrom("", " ", "\t", "  ");
  const serialize = (entries: Array<[string, string]>, render: (value: string) => string) =>
    fc
      .tuple(
        fc.array(fc.tuple(fc.boolean(), pad, pad, filler, lineEnding), {
          minLength: entries.length,
          maxLength: entries.length,
        }),
        fc.boolean(),
      )
      .map(
        ([decorations, bom]) =>
          (bom ? "\uFEFF" : "") +
          entries
            .map(([key, value], i) => {
              const [exported, before, after, extra, eol] = decorations[i]!;
              return `${extra}${eol}${exported ? "export " : ""}${key}${before}=${after}${render(value)}${eol}`;
            })
            .join(""),
      );

  const escapeDouble = (value: string) =>
    `"${value.replace(/[\\"\n\r\t]/g, (ch) => ({ "\\": "\\\\", '"': '\\"', "\n": "\\n", "\r": "\\r", "\t": "\\t" })[ch]!)}"`;

  test.prop([
    fc
      .dictionary(envKey, fc.string({ unit: "binary", maxLength: 40 }), { maxKeys: 8 })
      .chain((dict) => {
        const entries = Object.entries(dict);
        return serialize(entries, escapeDouble).map((source) => ({ entries, source }));
      }),
  ])("round-trips any value through double quotes", ({ entries, source }) => {
    expect(Object.fromEntries(parseEnvFile(source))).toEqual(Object.fromEntries(entries));
  });

  test.prop([
    fc
      .dictionary(
        envKey,
        fc.string({ maxLength: 40 }).filter((v) => !/['\r\n]/.test(v)),
        { maxKeys: 8 },
      )
      .chain((dict) => {
        const entries = Object.entries(dict);
        return serialize(entries, (v) => `'${v}'`).map((source) => ({ entries, source }));
      }),
  ])(
    "round-trips values without quotes or line breaks through single quotes",
    ({ entries, source }) => {
      expect(Object.fromEntries(parseEnvFile(source))).toEqual(Object.fromEntries(entries));
    },
  );

  test.prop([
    fc
      .dictionary(
        envKey,
        fc
          .stringMatching(/^[A-Za-z0-9_\-./:@+=,~$%^&*()[\]{}]{0,40}$/)
          .filter((v) => !/^["']/.test(v)),
        { maxKeys: 8 },
      )
      .chain((dict) => {
        const entries = Object.entries(dict);
        return serialize(entries, (v) => v).map((source) => ({ entries, source }));
      }),
  ])("round-trips plain values unquoted", ({ entries, source }) => {
    expect(Object.fromEntries(parseEnvFile(source))).toEqual(Object.fromEntries(entries));
  });
});

describe("loadEnvFiles", () => {
  let dir: { path: string; cleanup: () => void };
  beforeAll(() => {
    dir = tempDir("ddl-env-");
  });
  afterAll(() => dir.cleanup());

  const value = fc.option(fc.constantFrom("", "shell", "a", "b"), { nil: undefined });
  const keys = ["K1", "K2", "K3", "K4"];

  test.prop([
    fc.tuple(value, value, value, value),
    fc.tuple(value, value, value, value),
    fc.tuple(value, value, value, value),
  ])(
    "never overrides a set variable; the first file with a non-empty value wins",
    (envValues, first, second) => {
      const env: Record<string, string | undefined> = {};
      keys.forEach((k, i) => {
        if (envValues[i] !== undefined) env[k] = envValues[i];
      });
      const write = (name: string, values: Array<string | undefined>) => {
        const path = join(dir.path, name);
        writeFileSync(
          path,
          keys.map((k, i) => (values[i] === undefined ? "" : `${k}=${values[i]}`)).join("\n"),
        );
        return path;
      };
      const paths = [
        write("first.env", first),
        join(dir.path, "missing.env"),
        write("second.env", second),
      ];
      expect(loadEnvFiles(paths, env)).toEqual([paths[0], paths[2]]);
      keys.forEach((k, i) => {
        const original = envValues[i];
        const expected = original ? original : first[i] || second[i] || original;
        expect(env[k], k).toBe(expected);
      });
    },
  );
});

describe("config.json errors", () => {
  let root: { path: string; cleanup: () => void };
  let home: string;
  beforeAll(() => {
    root = tempDir("ddl-config-errors-");
    home = join(root.path, "state");
    mkdirSync(home);
  });
  afterAll(() => root.cleanup());

  const load = () =>
    loadConfig({ env: { DDL_HOME: home }, cwd: root.path, homedir: root.path, platform: "linux" });
  const withConfig = (source: string) => {
    writeFileSync(join(home, "config.json"), source);
    return () => load();
  };

  it.each([
    ["not JSON", "{ nope", /config\.json is not valid JSON/],
    ["empty", "", /not valid JSON/],
    ["a byte order mark", `\uFEFF{"port":1}`, /not valid JSON/],
    ["an array", "[]", /expected object/],
    ["null", "null", /expected object/],
    ["a string", '"x"', /expected object/],
    ["an unknown key", '{"vaultpath":"~/typo"}', /vaultpath/],
    [
      "an unknown nested key",
      '{"execution":{"kind":"local","browser":{"headles":true}}}',
      /headles/,
    ],
    ["a string port", '{"port":"7331"}', /port/],
    ["a fractional port", '{"port":7331.5}', /port/],
    ["a negative port", '{"port":-1}', /port/],
    ["a port above 65535", '{"port":65536}', /port/],
    ["an unknown agent mode", '{"agentMode":"turbo"}', /agentMode/],
    ["an unknown log level", '{"logLevel":"verbose"}', /logLevel/],
    ["a blank vault path", '{"vaultPath":"   "}', /vaultPath/],
    ["a blank model", '{"model":""}', /model/],
    ["origins as a string", '{"allowedOrigins":"http://localhost:5174"}', /allowedOrigins/],
    ["a null origin", '{"allowedOrigins":["null"]}', /allowedOrigins/],
    ["a wildcard origin", '{"allowedOrigins":["*"]}', /allowedOrigins/],
    ["an origin with a path", '{"allowedOrigins":["http://localhost:5174/app"]}', /allowedOrigins/],
    ["an origin without a scheme", '{"allowedOrigins":["localhost:5174"]}', /allowedOrigins/],
    ["an unknown sync kind", '{"sync":{"kind":"ftp"}}', /sync/],
    ["local sync without a root", '{"sync":{"kind":"local"}}', /root/],
    [
      "an unknown browser channel",
      '{"execution":{"kind":"local","browser":{"channel":"firefox"}}}',
      /channel/,
    ],
  ])("reports %s clearly", (_name, source, message) => {
    const run = withConfig(source);
    expect(run).toThrow(ConfigError);
    expect(run).toThrow(message);
    expect(run).toThrow(/~\/state\/config\.json/);
  });

  it("reports an unreadable config file as unreadable, not as invalid JSON", () => {
    const configPath = join(home, "config.json");
    writeFileSync(configPath, "{}");
    chmodSync(configPath, 0o000);
    try {
      if (process.getuid?.() !== 0) expect(load).toThrow(/Could not read ~\/state\/config\.json/);
    } finally {
      chmodSync(configPath, 0o600);
    }
    const dirHome = join(root.path, "dir-home");
    mkdirSync(join(dirHome, "config.json"), { recursive: true });
    expect(() =>
      loadConfig({
        env: { DDL_HOME: dirHome },
        cwd: root.path,
        homedir: root.path,
        platform: "linux",
      }),
    ).toThrow(/Could not read ~\/dir-home\/config\.json/);
  });

  test.prop([
    fc.dictionary(fc.string({ minLength: 1, maxLength: 12 }), fc.jsonValue(), {
      minKeys: 1,
      maxKeys: 4,
    }),
  ])("rejects any unknown top-level key by name", (extra) => {
    const known = [
      "vaultPath",
      "port",
      "agentMode",
      "model",
      "sync",
      "execution",
      "allowedOrigins",
      "webDist",
      "logLevel",
    ];
    const unknown = Object.keys(extra).filter((k) => !known.includes(k));
    fc.pre(unknown.length > 0);
    const run = withConfig(JSON.stringify(extra));
    expect(run).toThrow(ConfigError);
    try {
      run();
    } catch (error) {
      expect(
        unknown.some(
          (k) =>
            (error as Error).message.includes(JSON.stringify(k)) ||
            (error as Error).message.includes(k),
        ),
      ).toBe(true);
    }
  });
});

describe("environment overrides", () => {
  let root: { path: string; cleanup: () => void };
  beforeAll(() => {
    root = tempDir("ddl-config-env-");
  });
  afterAll(() => root.cleanup());

  const load = (env: Record<string, string>) =>
    loadConfig({
      env: { DDL_HOME: join(root.path, "state"), ...env },
      cwd: root.path,
      homedir: root.path,
      platform: "linux",
    });

  it.each([
    ["0", 0],
    ["65535", 65535],
    ["  8080 ", 8080],
    ["080", 80],
    ["", 7331],
    ["   ", 7331],
  ])("accepts DDL_PORT=%j", (raw, port) => {
    expect(load({ DDL_PORT: raw }).port).toBe(port);
  });

  test.prop([fc.string({ maxLength: 8 })])(
    "rejects every other DDL_PORT, naming the variable",
    (raw) => {
      const trimmed = raw.trim();
      fc.pre(trimmed !== "" && !(/^\d+$/.test(trimmed) && Number(trimmed) <= 65535));
      expect(() => load({ DDL_PORT: raw })).toThrow(
        /DDL_PORT must be an integer between 0 and 65535/,
      );
    },
  );

  it("matches agent mode and log level case-insensitively, and names the variable otherwise", () => {
    expect(load({ DDL_AGENT_MODE: " Mock " }).agentMode).toBe("mock");
    expect(load({ DDL_LOG_LEVEL: "WARN" }).logLevel).toBe("warn");
    expect(() => load({ DDL_AGENT_MODE: "on" })).toThrow(
      /DDL_AGENT_MODE must be one of live, mock, off/,
    );
    expect(() => load({ DDL_LOG_LEVEL: "trace" })).toThrow(/DDL_LOG_LEVEL/);
  });

  test.prop([fc.string({ minLength: 8, maxLength: 60 }).filter((s) => s.trim().length >= 8)])(
    "keeps the API key out of the loggable config summary",
    (key) => {
      const config = load({ OPENROUTER_API_KEY: key });
      expect(JSON.stringify(summarizeConfig(config, root.path))).not.toContain(key);
    },
  );
});

describe("DDL_HOME", () => {
  let root: { path: string; cleanup: () => void };
  beforeAll(() => {
    root = tempDir("ddl-home-");
  });
  afterAll(() => root.cleanup());

  it("creates missing parents and DDL_HOME itself owner-only", () => {
    const home = join(root.path, "a", "b", "state");
    loadConfig({ env: { DDL_HOME: home }, cwd: root.path, homedir: root.path, platform: "linux" });
    expect(statSync(home).mode & 0o777).toBe(0o700);
  });

  it("leaves the permissions of an existing DDL_HOME as they are", () => {
    const home = join(root.path, "existing");
    mkdirSync(home, { mode: 0o755 });
    chmodSync(home, 0o755);
    loadConfig({ env: { DDL_HOME: home }, cwd: root.path, homedir: root.path, platform: "linux" });
    expect(statSync(home).mode & 0o777).toBe(0o755);
  });

  it("reports a DDL_HOME that is a file, or an env file that cannot be read", () => {
    const file = join(root.path, "a-file");
    writeFileSync(file, "");
    expect(() =>
      loadConfig({
        env: { DDL_HOME: file },
        cwd: root.path,
        homedir: root.path,
        platform: "linux",
      }),
    ).toThrow(/Could not create ~\/a-file/);
    const home = join(root.path, "env-dir");
    mkdirSync(join(home, ".env"), { recursive: true });
    expect(() =>
      loadConfig({
        env: { DDL_HOME: home },
        cwd: root.path,
        homedir: root.path,
        platform: "linux",
      }),
    ).toThrow(/Could not read an env file/);
  });
});

describe("user paths", () => {
  const home = fc.constantFrom("/Users/user", "/home/me", "/srv/sub dir/", "/h");
  const base = fc.constantFrom("/work", "/Users/user/project", "/");
  // Config paths are trimmed, so names with outer spaces are out of scope here.
  const relative = fc
    .array(
      fc
        .stringMatching(/^[A-Za-z0-9._-]([A-Za-z0-9 ._-]{0,8}[A-Za-z0-9._-])?$/)
        .filter((s) => s !== "." && s !== ".."),
      { minLength: 1, maxLength: 4 },
    )
    .map((s) => s.join("/"));

  test.prop([
    home,
    base,
    fc.oneof(
      relative,
      relative.map((r) => `~/${r}`),
      fc.constant("~"),
      relative.map((r) => `/${r}`),
      relative.map((r) => `~user/${r}`),
    ),
  ])(
    "always resolve to an absolute path, expanding only a leading ~ or ~/",
    (homedir, cwd, input) => {
      const out = resolveUserPath(`  ${input}\t`, { homedir, base: cwd });
      expect(isAbsolute(out)).toBe(true);
      if (input === "~") expect(out).toBe(resolve(homedir));
      else if (input.startsWith("~/")) expect(out).toBe(resolve(homedir, input.slice(2)));
      else expect(out).toBe(resolve(cwd, input));
    },
  );

  test.prop([home, relative])(
    "abbreviate the home directory and resolve back to the same path",
    (homedir, rel) => {
      const path = resolve(homedir, rel);
      const shown = displayPath(path, homedir.replace(/\/+$/, ""));
      expect(shown.startsWith("~/") || shown === "~").toBe(true);
      expect(
        resolveUserPath(shown, { homedir: homedir.replace(/\/+$/, ""), base: "/elsewhere" }),
      ).toBe(path);
    },
  );

  it("never abbreviates a sibling that merely shares the home directory's prefix", () => {
    expect(displayPath("/srv/alice/notes", "/srv/al")).toBe("/srv/alice/notes");
    expect(displayPath("/srv/al", "/srv/al")).toBe("~");
    expect(displayPath("/srv/al/x", "/srv/al/")).toBe("~/x");
  });
});
