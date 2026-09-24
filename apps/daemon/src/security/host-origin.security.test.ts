import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { API_ROUTES } from "@ddl/core";
import { fc, test } from "@fast-check/vitest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createSecurityPolicy, DEV_SERVER_PORT } from "../security";
import { createTestApp, TEST_PORT, tempDir, testToken } from "../test-helpers";
import {
  httpRequest,
  type MemoryLiveApp,
  type RawResponse,
  rawRequest,
  startLiveApp,
  upgradeOutcome,
  WS_UPGRADE_HEADERS,
} from "./harness";

const port = fc.integer({ min: 1, max: 65535 });
const hostname = fc.domain();

describe("Host allowlist", () => {
  test.prop([port])("is exactly the loopback names on the daemon and Vite ports", (p) => {
    const policy = createSecurityPolicy({ port: p, token: testToken() });
    const expected = new Set(
      [p, DEV_SERVER_PORT].flatMap((q) => [`127.0.0.1:${q}`, `localhost:${q}`]),
    );
    if (p === 80) for (const name of ["127.0.0.1", "localhost"]) expected.add(name);
    expect(new Set(policy.allowedHosts)).toEqual(expected);
    for (const host of expected) {
      expect(policy.isHostAllowed(host)).toBe(true);
      expect(policy.isHostAllowed(`  ${host.toUpperCase()}\t`)).toBe(true);
    }
  });

  test.prop([port, fc.string({ unit: "binary", maxLength: 40 })])(
    "accepts a string only if it trims and lowercases to an allowed host",
    (p, candidate) => {
      const policy = createSecurityPolicy({ port: p, token: testToken() });
      expect(policy.isHostAllowed(candidate)).toBe(
        policy.allowedHosts.has(candidate.trim().toLowerCase()),
      );
    },
  );

  test.prop([port, fc.constantFrom("127.0.0.1", "localhost"), fc.string({ minLength: 1 })])(
    "rejects any allowed host with something glued on either side",
    (p, name, extra) => {
      fc.pre(extra.trim() !== "");
      const policy = createSecurityPolicy({ port: p, token: testToken() });
      const host = `${name}:${p}`;
      expect(policy.isHostAllowed(`${host}${extra.trim()}`)).toBe(false);
      expect(policy.isHostAllowed(`${extra.trim()}${host}`)).toBe(false);
    },
  );

  test.prop([port, hostname, fc.option(port)])(
    "rejects every other DNS name, with or without a port",
    (p, name, q) => {
      fc.pre(name !== "localhost");
      const policy = createSecurityPolicy({ port: p, token: testToken() });
      expect(policy.isHostAllowed(q === null ? name : `${name}:${q}`)).toBe(false);
    },
  );

  it("rejects look-alikes of the loopback names", () => {
    const policy = createSecurityPolicy({ port: TEST_PORT, token: testToken() });
    for (const host of [
      `[::1]:${TEST_PORT}`,
      `localhost.:${TEST_PORT}`,
      `127.0.0.1.:${TEST_PORT}`,
      `localhost.evil.com:${TEST_PORT}`,
      `127.0.0.1.nip.io:${TEST_PORT}`,
      `127.1:${TEST_PORT}`,
      `2130706433:${TEST_PORT}`,
      `0x7f.0.0.1:${TEST_PORT}`,
      `127.0.0.1:0${TEST_PORT}`,
      `127.0.0.2:${TEST_PORT}`,
      `0.0.0.0:${TEST_PORT}`,
      `localhost:${TEST_PORT}.`,
      `localhost:${TEST_PORT + 1}`,
      "localhost",
      "127.0.0.1",
      "",
    ]) {
      expect(policy.isHostAllowed(host), host).toBe(false);
    }
    expect(policy.isHostAllowed(undefined)).toBe(false);
    expect(policy.isHostAllowed(null)).toBe(false);
  });

  it("adds the host of extra http(s) origins only", () => {
    const policy = createSecurityPolicy({
      port: TEST_PORT,
      token: testToken(),
      extraOrigins: ["https://app.example:8443", "tauri://localhost", "http://localhost:5174/"],
    });
    expect(policy.isHostAllowed("app.example:8443")).toBe(true);
    expect(policy.isHostAllowed("localhost:5174")).toBe(true);
    expect(policy.isHostAllowed("localhost")).toBe(false);
    expect(policy.isHostAllowed("app.example")).toBe(false);
  });
});

describe("Origin allowlist", () => {
  test.prop([port, fc.string({ unit: "binary", maxLength: 60 })])(
    "accepts a string only if it normalizes to an allowed origin",
    (p, candidate) => {
      const policy = createSecurityPolicy({ port: p, token: testToken() });
      const normalized = candidate.trim().toLowerCase().replace(/\/+$/, "");
      expect(policy.isOriginAllowed(candidate)).toBe(policy.allowedOrigins.has(normalized));
    },
  );

  const webOrigin = fc
    .tuple(
      fc.constantFrom("http", "https"),
      fc.webAuthority({ withIPv4: true, withIPv6: true, withPort: true }),
    )
    .map(([scheme, authority]) => `${scheme}://${authority}`);

  test.prop([webOrigin])("rejects arbitrary web origins", (origin) => {
    fc.pre(!/^https?:\/\/(localhost|127\.0\.0\.1)(:|$)/i.test(origin));
    const policy = createSecurityPolicy({ port: TEST_PORT, token: testToken() });
    expect(policy.isOriginAllowed(origin)).toBe(false);
  });

  it("accepts case and trailing-slash variants of allowed origins, nothing else", () => {
    const policy = createSecurityPolicy({ port: TEST_PORT, token: testToken() });
    for (const origin of [
      `http://127.0.0.1:${TEST_PORT}`,
      `HTTP://LOCALHOST:${TEST_PORT}`,
      `http://localhost:${TEST_PORT}/`,
      `http://localhost:${TEST_PORT}//`,
      ` http://localhost:${DEV_SERVER_PORT} `,
    ]) {
      expect(policy.isOriginAllowed(origin), origin).toBe(true);
    }
    for (const origin of [
      "null",
      "",
      `https://127.0.0.1:${TEST_PORT}`,
      `ws://127.0.0.1:${TEST_PORT}`,
      `http://127.0.0.1:${TEST_PORT + 1}`,
      `http://127.0.0.1`,
      `http://localhost:${TEST_PORT}.evil.com`,
      `http://127.0.0.1:${TEST_PORT}@evil.com`,
      `http://evil.com@127.0.0.1:${TEST_PORT}`,
      `http://127.0.0.1:${TEST_PORT}/path`,
      `http://127.0.0.1:${TEST_PORT}?x`,
      `http://[::1]:${TEST_PORT}`,
      `http://localhost.:${TEST_PORT}`,
      `http://127.0.0.1:0${TEST_PORT}`,
      `http://127.0.0.1:${TEST_PORT}, http://evil.com`,
      "file://",
      "chrome-extension://abcdefghijklmnop",
    ]) {
      expect(policy.isOriginAllowed(origin), origin).toBe(false);
    }
  });

  it("enforces the Origin on every API method, and lets token-bearing requests omit it", async () => {
    const { request } = await createTestApp();
    for (const method of ["GET", "PUT", "POST", "DELETE", "PATCH"]) {
      for (const origin of ["null", "http://evil.example", `http://localhost:${TEST_PORT}.evil`]) {
        const res = await request(API_ROUTES.note("a.md"), {
          method,
          origin,
          ...(method === "GET" ? {} : { json: { content: "x" } }),
        });
        expect(res.status, `${method} ${origin}`).toBe(403);
        expect(await res.json()).toMatchObject({ error: "forbidden_origin" });
      }
    }
    const put = await request(API_ROUTES.note("a.md"), { method: "PUT", json: { content: "x" } });
    expect(put.status).toBe(201);
  });

  it("checks the Origin before the token so foreign pages learn nothing about it", async () => {
    const { request, token } = await createTestApp();
    const withToken = await request(API_ROUTES.health, { origin: "http://evil.example", token });
    const without = await request(API_ROUTES.health, {
      origin: "http://evil.example",
      token: null,
    });
    expect(withToken.status).toBe(403);
    expect(without.status).toBe(403);
    expect(await withToken.text()).toBe(await without.text());
  });

  it("does not consult Sec-Fetch-Site: the Origin (always sent cross-site) decides", async () => {
    const { request } = await createTestApp();
    const cross = await request(API_ROUTES.health, { headers: { "sec-fetch-site": "cross-site" } });
    expect(cross.status).toBe(200);
    const foreign = await request(API_ROUTES.health, {
      origin: "http://evil.example",
      headers: { "sec-fetch-site": "same-origin" },
    });
    expect(foreign.status).toBe(403);
  });

  it("never answers CORS preflights or sends CORS headers", async () => {
    const { request } = await createTestApp();
    for (const origin of [`http://localhost:${DEV_SERVER_PORT}`, "http://evil.example"]) {
      const res = await request(API_ROUTES.note("a.md"), {
        method: "OPTIONS",
        token: null,
        origin,
        headers: {
          "access-control-request-method": "PUT",
          "access-control-request-headers": "authorization,content-type",
        },
      });
      expect(res.status).toBeGreaterThanOrEqual(400);
      for (const name of res.headers.keys()) expect(name).not.toMatch(/^access-control-/);
    }
  });
});

describe("Host and Origin over raw HTTP", () => {
  let app: MemoryLiveApp;
  let dist: { path: string; cleanup: () => void };

  beforeAll(async () => {
    dist = tempDir("ddl-host-web-");
    mkdirSync(join(dist.path, "assets"));
    writeFileSync(
      join(dist.path, "index.html"),
      "<!doctype html><html><head></head><body></body></html>",
    );
    writeFileSync(join(dist.path, "assets", "app-1234.js"), "console.log('app')");
    app = await startLiveApp({ webDist: dist.path });
  });
  afterAll(async () => {
    await app.close();
    dist.cleanup();
  });

  const get = (target: string, headers: ReadonlyArray<readonly [string, string]>) =>
    rawRequest(app.port, httpRequest("GET", target, [...headers, ["Connection", "close"]]));
  const auth = (): [string, string] => ["Authorization", `Bearer ${app.token}`];
  const upgrade = (target: string, headers: ReadonlyArray<readonly [string, string]>) =>
    rawRequest(app.port, httpRequest("GET", target, [...headers, ...WS_UPGRADE_HEADERS]));

  /** Every surface that must refuse a foreign Host: API, index.html (token!), assets, SPA routes. */
  const surfaces = (): Array<[string, Array<[string, string]>]> => [
    [API_ROUTES.health, [auth()]],
    ["/", []],
    ["/index.html", []],
    ["/assets/app-1234.js", []],
    ["/notes/Daily/2026-09-23.md", []],
  ];

  const expectNoLeak = (res: RawResponse) => {
    expect(res.body).not.toContain(app.token);
    expect(JSON.stringify(res.headers)).not.toContain(app.token);
  };

  it("serves every surface to the allowed Host spellings", async () => {
    for (const host of [
      app.host,
      `localhost:${app.port}`,
      `LOCALHOST:${app.port}`,
      `127.0.0.1:${DEV_SERVER_PORT}`,
      `localhost:${DEV_SERVER_PORT}`,
    ]) {
      for (const [target, extra] of surfaces()) {
        const res = await get(target, [["Host", host], ...extra]);
        expect(res.status, `${host} ${target}`).toBe(200);
      }
    }
  });

  it("refuses foreign and look-alike Hosts on every surface without leaking the token", async () => {
    for (const host of [
      "evil.com",
      `evil.com:${app.port}`,
      `localhost.evil.com:${app.port}`,
      `127.0.0.1.nip.io:${app.port}`,
      `[::1]:${app.port}`,
      `localhost.:${app.port}`,
      `127.1:${app.port}`,
      `127.0.0.1:${app.port + 1}`,
      `127.0.0.1:0${app.port}`,
      "localhost",
    ]) {
      for (const [target, extra] of surfaces()) {
        const res = await get(target, [["Host", host], ...extra]);
        // node-server normalizes some hosts (127.1 → 127.0.0.1) and then refuses them as invalid,
        // depending on the port; either way the request never reaches a handler.
        expect([400, 403], `${host} ${target}`).toContain(res.status);
        expectNoLeak(res);
      }
    }
  });

  it("answers 400 to Host headers that are not a host at all", async () => {
    for (const host of [`127.0.0.1:${app.port}@evil.com`, `127.0.0.1:${app.port}/x`, ""]) {
      for (const [target, extra] of surfaces()) {
        const res = await get(target, [["Host", host], ...extra]);
        expect(res.status, `${JSON.stringify(host)} ${target}`).toBe(400);
        expectNoLeak(res);
      }
    }
    const missing = await rawRequest(app.port, `GET / HTTP/1.1\r\nConnection: close\r\n\r\n`);
    expect(missing.status).toBe(400);
    const http10 = await rawRequest(app.port, `GET / HTTP/1.0\r\n\r\n`);
    expect(http10.status).toBe(400);
    expectNoLeak(http10);
  });

  it("refuses repeated Host headers, even when both are allowed", async () => {
    for (const hosts of [
      [app.host, app.host],
      [app.host, "evil.com"],
      ["evil.com", app.host],
    ]) {
      for (const [target, extra] of surfaces()) {
        const res = await get(target, [["Host", hosts[0]!], ["Host", hosts[1]!], ...extra]);
        expect(res.status, `${hosts.join(",")} ${target}`).toBe(403);
        expectNoLeak(res);
      }
    }
  });

  it("checks the authority of absolute-form request targets as well as the Host header", async () => {
    for (const [target, extra] of surfaces()) {
      const foreign = await get(`http://evil.com${target}`, [["Host", app.host], ...extra]);
      expect(foreign.status, `foreign authority ${target}`).toBe(403);
      expectNoLeak(foreign);
      const both = await get(`http://${app.host}${target}`, [["Host", app.host], ...extra]);
      expect(both.status, `own authority ${target}`).toBe(200);
      const hostEvil = await get(`http://${app.host}${target}`, [["Host", "evil.com"], ...extra]);
      expect(hostEvil.status, `foreign Host ${target}`).toBe(403);
    }
    const http10 = (authority: string) =>
      rawRequest(app.port, `GET http://${authority}/ HTTP/1.0\r\n\r\n`);
    expect((await http10(app.host)).status).toBe(200);
    const evil = await http10("evil.com");
    expect(evil.status).toBe(403);
    expectNoLeak(evil);
  });

  it("applies the same Host rules to the WebSocket upgrade", async () => {
    const token = `?token=${app.token}`;
    const ok = await upgrade(`${API_ROUTES.ws}${token}`, [["Host", `LOCALHOST:${app.port}`]]);
    expect(ok.status).toBe(101);
    const cases: Array<[string, Array<[string, string]>]> = [
      [`${API_ROUTES.ws}${token}`, [["Host", "evil.com"]]],
      [`${API_ROUTES.ws}${token}`, [["Host", `[::1]:${app.port}`]]],
      [`${API_ROUTES.ws}${token}`, [["Host", `localhost.:${app.port}`]]],
      [
        `${API_ROUTES.ws}${token}`,
        [
          ["Host", app.host],
          ["Host", "evil.com"],
        ],
      ],
      [
        `${API_ROUTES.ws}${token}`,
        [
          ["Host", app.host],
          ["Host", app.host],
        ],
      ],
      [`${API_ROUTES.ws}${token}`, []],
      [`http://evil.com${API_ROUTES.ws}${token}`, [["Host", app.host]]],
      [`http://${app.host}${API_ROUTES.ws}${token}`, [["Host", "evil.com"]]],
    ];
    for (const [target, headers] of cases) {
      const res = await upgrade(target, headers);
      expect(res.status, `${target} ${JSON.stringify(headers)}`).toBe(403);
    }
    const own = await upgrade(`http://${app.host}${API_ROUTES.ws}${token}`, [["Host", app.host]]);
    expect(own.status).toBe(101);
    await expect.poll(() => app.hub.clientCount).toBe(0);
  });

  it("only upgrades the exact /ws path", async () => {
    const token = `?token=${app.token}`;
    for (const target of [
      `/ws/${token}`,
      `//ws${token}`,
      `//evil.com/ws${token}`,
      `/%77s${token}`,
      `/WS${token}`,
      `/api/ws${token}`,
      `/ws/..${token}`,
    ]) {
      const res = await upgrade(target, [["Host", app.host]]);
      expect(res.status, target).toBe(404);
    }
    const dotted = await upgrade(`/api/../ws${token}`, [["Host", app.host]]);
    expect(dotted.status).toBe(101);
  });

  it("refuses upgrades from foreign, null and repeated Origins", async () => {
    for (const origins of [
      ["http://evil.example"],
      ["null"],
      [`http://${app.host}.evil.example`],
      [`http://${app.host}`, "http://evil.example"],
    ]) {
      const res = await upgrade(`${API_ROUTES.ws}?token=${app.token}`, [
        ["Host", app.host],
        ...origins.map((origin): [string, string] => ["Origin", origin]),
      ]);
      expect(res.status, origins.join(",")).toBe(403);
    }
    expect(
      await upgradeOutcome(app.wsUrl(), { origin: `http://localhost:${DEV_SERVER_PORT}` }),
    ).toBe("open");
  });
});
