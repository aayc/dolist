import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { API_ROUTES, silentLogger } from "@ddl/core";
import { fc, test } from "@fast-check/vitest";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig } from "../config";
import { type RunningDaemon, startDaemon } from "../server";
import { createTestApp, tempDir, testToken } from "../test-helpers";
import { createTokenVerifier, parseBearer } from "../token";
import {
  httpRequest,
  type MemoryLiveApp,
  rawRequest,
  startLiveApp,
  upgradeOutcome,
  WS_UPGRADE_HEADERS,
} from "./harness";

const hexToken = fc
  .uint8Array({ minLength: 32, maxLength: 32 })
  .map((bytes) => Buffer.from(bytes).toString("hex"));

/** A same-length token that differs from `token` in exactly one position. */
const flippedToken = (token: string, index: number): string => {
  const at = index % token.length;
  const replacement = token[at] === "0" ? "1" : "0";
  return `${token.slice(0, at)}${replacement}${token.slice(at + 1)}`;
};

const lives: MemoryLiveApp[] = [];
afterEach(async () => {
  for (const live of lives.splice(0)) await live.close();
});

async function live(): Promise<MemoryLiveApp> {
  const app = await startLiveApp();
  lives.push(app);
  return app;
}

describe("token verifier", () => {
  test.prop([hexToken, fc.string({ unit: "binary", maxLength: 700 })])(
    "accepts exactly the token, for any candidate string",
    (token, candidate) => {
      const verify = createTokenVerifier(token);
      expect(verify(candidate)).toBe(candidate === token);
      expect(verify(token)).toBe(true);
    },
  );

  test.prop([hexToken, fc.nat()])(
    "rejects every same-length token off by one character",
    (token, i) => {
      expect(createTokenVerifier(token)(flippedToken(token, i))).toBe(false);
    },
  );

  test.prop([hexToken, fc.string({ minLength: 1, maxLength: 64 })])(
    "rejects the token with anything appended or prepended (length never short-circuits into a throw)",
    (token, extra) => {
      const verify = createTokenVerifier(token);
      expect(verify(`${token}${extra}`)).toBe(false);
      expect(verify(`${extra}${token}`)).toBe(false);
      expect(verify(token.slice(0, token.length - 1))).toBe(false);
    },
  );

  test.prop([hexToken, fc.anything()])(
    "never throws on values that are not strings",
    (token, value) => {
      expect(createTokenVerifier(token)(value as string)).toBe(false);
    },
  );

  it("rejects empty, missing and oversized candidates, even a huge repetition of the token", () => {
    const token = testToken();
    const verify = createTokenVerifier(token);
    for (const candidate of ["", null, undefined, token.repeat(9), "x".repeat(100_000)]) {
      expect(verify(candidate)).toBe(false);
    }
  });
});

describe("parseBearer", () => {
  const scheme = fc.mixedCase(fc.constant("bearer"));
  const gap = fc.stringMatching(/^[ \t]{1,6}$/);
  const trailing = fc.stringMatching(/^[ \t]{0,6}$/);
  const credentials = fc.stringMatching(/^[\x21-\x7e]{1,100}$/);

  test.prop([scheme, gap, credentials, trailing])(
    "extracts the credentials for any casing of the scheme and any spacing",
    (s, g, token, t) => {
      expect(parseBearer(`${s}${g}${token}${t}`)).toBe(token);
    },
  );

  test.prop([fc.string({ maxLength: 200 })])(
    "never throws and never returns whitespace",
    (header) => {
      const parsed = parseBearer(header);
      if (parsed !== undefined) expect(parsed).toMatch(/^\S+$/);
    },
  );

  it.each([
    ["other scheme", "Basic abc"],
    ["token scheme", "Token abc"],
    ["scheme glued to the token", "Bearerabc"],
    ["scheme only", "Bearer"],
    ["scheme and spaces only", "Bearer    "],
    ["two credentials", "Bearer abc def"],
    ["comma-joined duplicates", "Bearer abc, Bearer abc"],
    ["leading garbage", "x Bearer abc"],
  ])("rejects %s", (_name, header) => {
    expect(parseBearer(header)).toBeUndefined();
  });

  it("stays linear on adversarial header-sized input", () => {
    const started = performance.now();
    const cases: Array<[string, string | undefined]> = [
      [`Bearer ${" ".repeat(16_000)}x`, "x"],
      [`Bearer x${" ".repeat(16_000)}y`, undefined],
      [`Bearer ${"\t ".repeat(8_000)}`, undefined],
      [`${"Bearer ".repeat(2_000)}x`, undefined],
      [`Bearer ${"x".repeat(16_000)} `, "x".repeat(16_000)],
    ];
    for (const [header, expected] of cases) expect(parseBearer(header)).toBe(expected);
    expect(performance.now() - started).toBeLessThan(100);
  });
});

describe("REST authentication", () => {
  it("answers 401 with a Bearer challenge for missing, empty and malformed credentials", async () => {
    const { request, token } = await createTestApp();
    const headers: Array<Record<string, string>> = [
      {},
      { authorization: "" },
      { authorization: "Bearer" },
      { authorization: "Bearer " },
      { authorization: `Basic ${token}` },
      { authorization: `Token ${token}` },
      { authorization: `Bearer "${token}"` },
      { authorization: `Bearer ${token} ${token}` },
      { authorization: `Bearer ${token}, Bearer ${token}` },
      { authorization: `Bearer${token}` },
    ];
    for (const extra of headers) {
      const res = await request(API_ROUTES.health, { token: null, headers: extra });
      expect(res.status, JSON.stringify(extra)).toBe(401);
      expect(res.headers.get("www-authenticate")).toBe("Bearer");
      expect(await res.json()).toEqual({
        error: "unauthorized",
        message: expect.any(String),
      });
    }
  });

  it("rejects wrong tokens of equal and different lengths", async () => {
    const { request, token } = await createTestApp();
    for (const candidate of [
      flippedToken(token, 0),
      flippedToken(token, 63),
      token.slice(0, 32),
      `${token}0`,
      `0${token}`,
      token.toUpperCase(),
      testToken(),
    ]) {
      expect((await request(API_ROUTES.health, { token: candidate })).status).toBe(401);
    }
  });

  it("accepts any casing of the scheme and extra spacing around the token", async () => {
    const { request, token } = await createTestApp();
    for (const authorization of [
      `bearer ${token}`,
      `BEARER ${token}`,
      `bEaReR ${token}`,
      `Bearer    ${token}`,
      `Bearer\t${token}`,
      `Bearer ${token}   `,
    ]) {
      const res = await request(API_ROUTES.health, { token: null, headers: { authorization } });
      expect(res.status, authorization).toBe(200);
    }
  });

  it("never accepts the token from the query string or a cookie", async () => {
    const { request, token } = await createTestApp();
    for (const path of [
      `${API_ROUTES.health}?token=${token}`,
      `${API_ROUTES.health}?access_token=${token}`,
      `${API_ROUTES.tree}?authorization=Bearer%20${token}`,
    ]) {
      expect((await request(path, { token: null })).status, path).toBe(401);
    }
    const cookie = await request(API_ROUTES.health, {
      token: null,
      headers: { cookie: `token=${token}; ddl-token=${token}` },
    });
    expect(cookie.status).toBe(401);
  });

  test.prop(
    [
      fc.constantFrom("GET", "PUT", "POST", "DELETE", "PATCH", "OPTIONS", "HEAD"),
      fc.array(fc.stringMatching(/^[A-Za-z0-9._~%-]{1,12}$/), { maxLength: 4 }),
    ],
    { numRuns: 60 },
  )("guards every method on every /api path, known or not", async (method, segments) => {
    const { request } = await createTestApp();
    const res = await request(`/api/${segments.join("/")}`, { method, token: null });
    // `%` sequences that decode to control characters, or malformed ones, never reach a handler.
    expect([401, 400]).toContain(res.status);
    if (method !== "HEAD") expect(await res.text()).not.toContain('"vaultName"');
  });

  it("guards URL spellings that still route to API handlers", async () => {
    const { request } = await createTestApp();
    for (const path of [
      "/%61pi/health",
      "/api/../api/health",
      "/api/./health",
      "/api/%2e/health",
      "/x/../api/health",
      "/api/health/",
      "/api/health?",
      "/api/health#x",
    ]) {
      const res = await request(path, { token: null });
      expect(res.status, path).toBe(401);
    }
  });

  it("does not expose API data under spellings that miss the API routes", async () => {
    const { request } = await createTestApp();
    for (const path of ["/API/health", "/Api/vault/tree", "/api%2Fhealth", "//api/health"]) {
      const res = await request(path, { token: null });
      expect(res.status, path).not.toBe(200);
      expect(await res.text()).not.toContain('"vaultName"');
    }
  });
});

describe("REST authentication over raw HTTP", () => {
  it("refuses repeated Authorization headers, whatever their order and validity", async () => {
    const app = await live();
    const good = `Bearer ${app.token}`;
    const bad = `Bearer ${testToken()}`;
    for (const pair of [
      [good, good],
      [good, bad],
      [bad, good],
    ]) {
      const res = await rawRequest(
        app.port,
        httpRequest("GET", API_ROUTES.health, [
          ["Host", app.host],
          ["Authorization", pair[0]!],
          ["Authorization", pair[1]!],
          ["Connection", "close"],
        ]),
      );
      expect(res.status, pair.join(" | ")).toBe(401);
    }
  });

  it("accepts optional whitespace and header-name casing that HTTP allows", async () => {
    const app = await live();
    for (const [name, value] of [
      ["authorization", `Bearer ${app.token}`],
      ["AUTHORIZATION", `Bearer ${app.token}`],
      ["Authorization", `\t Bearer ${app.token} \t`],
    ] as const) {
      const res = await rawRequest(
        app.port,
        httpRequest("GET", API_ROUTES.health, [
          ["Host", app.host],
          [name, value],
          ["Connection", "close"],
        ]),
      );
      expect(res.status, `${name}: ${JSON.stringify(value)}`).toBe(200);
    }
  });

  it("rejects obsolete line folding instead of stitching a token together", async () => {
    const app = await live();
    const res = await rawRequest(
      app.port,
      `GET ${API_ROUTES.health} HTTP/1.1\r\nHost: ${app.host}\r\nAuthorization: Bearer\r\n ${app.token}\r\nConnection: close\r\n\r\n`,
    );
    expect(res.status).toBe(400);
  });
});

describe("WebSocket authentication", () => {
  it("accepts the token from ?token= or the Authorization header", async () => {
    const app = await live();
    expect(await upgradeOutcome(app.wsUrl())).toBe("open");
    expect(
      await upgradeOutcome(app.wsUrl(""), { headers: { authorization: `bearer  ${app.token}` } }),
    ).toBe("open");
  });

  it("lets a present ?token= win over the header, even when it is empty", async () => {
    const app = await live();
    const header = { headers: { authorization: `Bearer ${app.token}` } };
    expect(await upgradeOutcome(app.wsUrl("token="), header)).toBe("HTTP 401");
    expect(await upgradeOutcome(app.wsUrl(`token=${testToken()}`), header)).toBe("HTTP 401");
    expect(
      await upgradeOutcome(app.wsUrl(), { headers: { authorization: `Bearer ${testToken()}` } }),
    ).toBe("open");
    // URLSearchParams reads the first occurrence.
    expect(await upgradeOutcome(app.wsUrl(`token=${app.token}&token=nope`))).toBe("open");
    expect(await upgradeOutcome(app.wsUrl(`token=nope&token=${app.token}`))).toBe("HTTP 401");
  });

  it("rejects wrong, shortened, padded and differently named tokens", async () => {
    const app = await live();
    for (const query of [
      "",
      `token=${flippedToken(app.token, 5)}`,
      `token=${app.token.slice(1)}`,
      `token=${app.token}0`,
      `token=%20${app.token}`,
      `access_token=${app.token}`,
      `Token=${app.token}`,
    ]) {
      expect(await upgradeOutcome(app.wsUrl(query)), query).toBe("HTTP 401");
    }
    expect(app.hub.clientCount).toBe(0);
  });

  it("refuses an upgrade with repeated Authorization headers", async () => {
    const app = await live();
    for (const second of [`Bearer ${app.token}`, "Bearer nope"]) {
      const res = await rawRequest(
        app.port,
        httpRequest("GET", API_ROUTES.ws, [
          ["Host", app.host],
          ["Authorization", `Bearer ${app.token}`],
          ["Authorization", second],
          ...WS_UPGRADE_HEADERS,
        ]),
      );
      expect(res.status).toBe(401);
    }
    expect(app.hub.clientCount).toBe(0);
  });
});

describe("token rotation while running", () => {
  let dir: { path: string; cleanup: () => void } | undefined;
  let daemon: RunningDaemon | undefined;
  afterEach(async () => {
    await daemon?.close();
    daemon = undefined;
    dir?.cleanup();
  });

  it("keeps the token loaded at startup until restart; the rotated file applies next start", async () => {
    dir = tempDir("ddl-rotate-");
    const env = {
      DDL_HOME: join(dir.path, "home"),
      DDL_VAULT: join(dir.path, "vault"),
      DDL_WEB_DIST: join(dir.path, "no-web"),
      DDL_AGENT_MODE: "off",
      DDL_PORT: "0",
    };
    const config = loadConfig({ env, cwd: dir.path, homedir: dir.path, platform: "linux" });
    daemon = await startDaemon({ config, env, logger: silentLogger });
    const original = readFileSync(config.tokenPath, "utf8").trim();
    const rotated = testToken();
    writeFileSync(config.tokenPath, `${rotated}\n`, { mode: 0o600 });

    const status = async (token: string) =>
      (
        await fetch(`${daemon!.url}${API_ROUTES.health}`, {
          headers: { authorization: `Bearer ${token}` },
        })
      ).status;
    const ws = (token: string) =>
      upgradeOutcome(`ws://127.0.0.1:${daemon!.port}${API_ROUTES.ws}?token=${token}`);
    expect(await status(original)).toBe(200);
    expect(await status(rotated)).toBe(401);
    expect(await ws(original)).toBe("open");
    expect(await ws(rotated)).toBe("HTTP 401");

    await daemon.close();
    daemon = await startDaemon({ config, env, logger: silentLogger });
    expect(await status(rotated)).toBe(200);
    expect(await status(original)).toBe(401);
    expect(await ws(rotated)).toBe("open");
  });
});
