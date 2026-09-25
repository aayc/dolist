/**
 * The remote access boundary as a matrix: Host (loopback, a configured remote host, an unknown
 * host) × Origin (none, the request's own, another site, `null`) × credential (none, the master
 * token, a paired app's token, a revoked device's token, a paired browser's cookie, that cookie
 * with another allowed Origin, `?token=`) × route (an API route, the WebSocket upgrade,
 * index.html, `POST /api/pair`), every case over real HTTP on a loopback port. Then revocation
 * closing sockets, and the page-only cookie rules browsers rely on.
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { API_ROUTES } from "@ddl/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PairingCodes } from "../pairing";
import { createRemoteHosts } from "../remote-hosts";
import { tempDir } from "../test-helpers";
import {
  httpRequest,
  type MemoryLiveApp,
  rawRequest,
  startLiveApp,
  TestSocket,
  upgradeOutcome,
  WS_UPGRADE_HEADERS,
  waitFor,
} from "./harness";

const REMOTE = "vm-name.tailnet-name.ts.net";
/** A second remote host: its origin is allowed, but it is never another host's own origin. */
const OTHER = "other-vm.tailnet-name.ts.net";
const UNKNOWN = "evil.example";

type HostCase = "loopback" | "remote" | "unknown";
type OriginCase = "none" | "own" | "other" | "null";
type CredentialCase =
  | "none"
  | "master"
  | "device"
  | "revoked"
  | "cookie"
  | "cookie-foreign-origin"
  | "query-token";
type RouteCase = "api" | "ws" | "index" | "pair";

const HOSTS: HostCase[] = ["loopback", "remote", "unknown"];
const ORIGINS: OriginCase[] = ["none", "own", "other", "null"];
const CREDENTIALS: CredentialCase[] = [
  "none",
  "master",
  "device",
  "revoked",
  "cookie",
  "cookie-foreign-origin",
  "query-token",
];
const ROUTES: RouteCase[] = ["api", "ws", "index", "pair"];

type Outcome =
  | { status: 200 | 201; page?: "token" | "cookie" | "pairing" }
  | { status: 401 | 403 }
  | { status: "open" };

let live: MemoryLiveApp;
let dist: { path: string; cleanup: () => void };
let clock = 1_790_000_000_000;
const secrets = { device: "", revoked: "", browser: "" };

beforeAll(async () => {
  dist = tempDir("ddl-remote-matrix-");
  writeFileSync(join(dist.path, "index.html"), "<html><head></head><body>app</body></html>");
  live = await startLiveApp({
    webDist: dist.path,
    remoteHosts: createRemoteHosts([REMOTE, OTHER]),
    pairing: new PairingCodes({ now: () => clock }),
  });
  secrets.device = (await live.devices.add("Phone", "app")).token;
  const revoked = await live.devices.add("Lost phone", "app");
  secrets.revoked = revoked.token;
  await live.devices.revoke(revoked.device.id);
  secrets.browser = (await live.devices.add("Browser", "browser")).token;
});

afterAll(async () => {
  await live.close();
  dist.cleanup();
});

function hostHeader(host: HostCase): string {
  return host === "loopback" ? live.host : host === "remote" ? REMOTE : UNKNOWN;
}

function originHeader(origin: OriginCase, host: HostCase): string | undefined {
  if (origin === "none") return undefined;
  if (origin === "null") return "null";
  if (origin === "other") return "https://evil.example";
  return host === "loopback" ? `http://${live.host}` : `https://${hostHeader(host)}`;
}

interface Request {
  headers: Array<[string, string]>;
  query: string;
  /** The Origin actually sent (the foreign-origin cookie case replaces it). */
  origin: string | undefined;
}

function buildRequest(host: HostCase, origin: OriginCase, credential: CredentialCase): Request {
  let sentOrigin = originHeader(origin, host);
  const headers: Array<[string, string]> = [["Host", hostHeader(host)]];
  let query = "";
  switch (credential) {
    case "master":
      headers.push(["Authorization", `Bearer ${live.token}`]);
      break;
    case "device":
      headers.push(["Authorization", `Bearer ${secrets.device}`]);
      break;
    case "revoked":
      headers.push(["Authorization", `Bearer ${secrets.revoked}`]);
      break;
    case "cookie":
      headers.push(["Cookie", `__Host-ddl-device=${secrets.browser}`]);
      break;
    case "cookie-foreign-origin":
      headers.push(["Cookie", `__Host-ddl-device=${secrets.browser}`]);
      sentOrigin = `https://${OTHER}`;
      break;
    case "query-token":
      query = `?token=${live.token}`;
      break;
    case "none":
      break;
  }
  if (sentOrigin !== undefined) headers.push(["Origin", sentOrigin]);
  return { headers, query, origin: sentOrigin };
}

/** What the boundary must answer, derived from the rules rather than recorded. */
function expected(
  host: HostCase,
  origin: OriginCase,
  credential: CredentialCase,
  route: RouteCase,
): Outcome {
  if (host === "unknown") return { status: 403 };
  const sent = buildRequest(host, origin, credential).origin;
  const allowedOrigin =
    sent === undefined ||
    sent === `http://${live.host}` ||
    sent === `https://${REMOTE}` ||
    sent === `https://${OTHER}`;
  const ownOrigin = host === "remote" && sent === `https://${REMOTE}`;
  const cookie = credential === "cookie" || credential === "cookie-foreign-origin";

  if (route === "index") {
    if (host === "loopback") return { status: 200, page: "token" };
    return { status: 200, page: cookie ? "cookie" : "pairing" };
  }
  if (!allowedOrigin) return { status: 403 };
  if (route === "pair") return { status: 201 };

  const bearer = credential === "master" || credential === "device";
  if (route === "api") {
    if (bearer) return { status: 200 };
    // No Origin and no Sec-Fetch-Site: a cookie needs proof that the page itself sent it.
    if (cookie && ownOrigin) return { status: 200 };
    return { status: 401 };
  }
  if (bearer) return { status: "open" };
  if (credential === "query-token")
    return host === "loopback" ? { status: "open" } : { status: 401 };
  if (cookie && ownOrigin) return { status: "open" };
  return { status: 401 };
}

async function observe(
  host: HostCase,
  origin: OriginCase,
  credential: CredentialCase,
  route: RouteCase,
): Promise<{ outcome: Outcome; body: string; headers: Record<string, string> }> {
  const request = buildRequest(host, origin, credential);
  if (route === "ws") {
    const res = await rawRequest(
      live.port,
      httpRequest("GET", `${API_ROUTES.ws}${request.query}`, [
        ...request.headers,
        ...WS_UPGRADE_HEADERS,
      ]),
    );
    const outcome: Outcome =
      res.status === 101 ? { status: "open" } : ({ status: res.status } as Outcome);
    return { outcome, body: res.body, headers: res.headers };
  }
  if (route === "pair") {
    // A fresh code each time; the clock moves past the attempt limit and any leftover codes.
    clock += 6 * 60_000;
    const code = live.pairing.issue()!.code;
    const body = JSON.stringify({ code, name: "Matrix", kind: "app" });
    const res = await rawRequest(
      live.port,
      httpRequest(
        "POST",
        `${API_ROUTES.pair}${request.query}`,
        [
          ...request.headers,
          ["Content-Type", "application/json"],
          ["Content-Length", String(Buffer.byteLength(body))],
          ["Connection", "close"],
        ],
        body,
      ),
    );
    return { outcome: { status: res.status } as Outcome, body: res.body, headers: res.headers };
  }
  const path = route === "api" ? API_ROUTES.tree : "/";
  const res = await rawRequest(
    live.port,
    httpRequest("GET", `${path}${request.query}`, [...request.headers, ["Connection", "close"]]),
  );
  let outcome: Outcome = { status: res.status } as Outcome;
  if (route === "index" && res.status === 200) {
    const page = res.body.includes('<meta name="ddl-token"')
      ? "token"
      : res.body.includes('<meta name="ddl-auth" content="cookie">')
        ? "cookie"
        : "pairing";
    outcome = { status: 200, page };
  }
  return { outcome, body: res.body, headers: res.headers };
}

const cases = HOSTS.flatMap((host) =>
  ORIGINS.flatMap((origin) =>
    CREDENTIALS.flatMap((credential) =>
      ROUTES.map(
        (route) =>
          [
            `${host} · origin ${origin} · ${credential} · ${route}`,
            host,
            origin,
            credential,
            route,
          ] as const,
      ),
    ),
  ),
);

describe("Host × Origin × credential × route", () => {
  it.each(cases)("%s", async (_name, host, origin, credential, route) => {
    const { outcome, body, headers } = await observe(host, origin, credential, route);
    expect(outcome).toEqual(expected(host, origin, credential, route));
    // The master token appears in exactly one place: the page served on a loopback Host.
    const text = `${JSON.stringify(headers)}\n${body}`;
    if (!(route === "index" && host === "loopback")) expect(text).not.toContain(live.token);
    for (const secret of Object.values(secrets)) expect(text).not.toContain(secret);
  });
});

describe("cookies from the page itself", () => {
  const cookie = () => `__Host-ddl-device=${secrets.browser}`;

  it("accepts a same-origin GET that carries no Origin, by its Sec-Fetch-Site", async () => {
    const get = (site?: string) =>
      rawRequest(
        live.port,
        httpRequest("GET", API_ROUTES.tree, [
          ["Host", REMOTE],
          ["Cookie", cookie()],
          ...(site ? ([["Sec-Fetch-Site", site]] as Array<[string, string]>) : []),
          ["Connection", "close"],
        ]),
      );
    expect((await get("same-origin")).status).toBe(200);
    for (const site of ["same-site", "cross-site", "none", undefined]) {
      expect((await get(site)).status, String(site)).toBe(401);
    }
  });

  it("never lets Sec-Fetch-Site stand in for an Origin on the WebSocket", async () => {
    const res = await rawRequest(
      live.port,
      httpRequest("GET", API_ROUTES.ws, [
        ["Host", REMOTE],
        ["Cookie", cookie()],
        ["Sec-Fetch-Site", "same-origin"],
        ...WS_UPGRADE_HEADERS,
      ]),
    );
    expect(res.status).toBe(401);
  });

  it("is judged by the Authorization header alone when one is sent", async () => {
    const res = await rawRequest(
      live.port,
      httpRequest("GET", API_ROUTES.tree, [
        ["Host", REMOTE],
        ["Origin", `https://${REMOTE}`],
        ["Cookie", cookie()],
        ["Authorization", `Bearer ${secrets.revoked}`],
        ["Connection", "close"],
      ]),
    );
    expect(res.status).toBe(401);
  });
});

describe("revoking a device", () => {
  it("closes its sockets at once, and only its own", async () => {
    const app = await startLiveApp({ remoteHosts: createRemoteHosts([REMOTE]) });
    try {
      const phone = await app.devices.add("Phone", "app");
      const laptop = await app.devices.add("Laptop", "daemon");
      const browser = await app.devices.add("Browser", "browser");
      const url = `ws://127.0.0.1:${app.port}${API_ROUTES.ws}`;
      const asPhone = await TestSocket.open(url, {
        headers: { authorization: `Bearer ${phone.token}`, host: REMOTE },
      });
      const asPhoneToo = await TestSocket.open(url, {
        headers: { authorization: `Bearer ${phone.token}` },
      });
      const asLaptop = await TestSocket.open(url, {
        headers: { authorization: `Bearer ${laptop.token}`, host: REMOTE },
      });
      const asBrowser = await TestSocket.open(url, {
        headers: { cookie: `__Host-ddl-device=${browser.token}`, host: REMOTE },
        origin: `https://${REMOTE}`,
      });
      const asMaster = await TestSocket.open(app.wsUrl());
      await Promise.all(
        [asPhone, asPhoneToo, asLaptop, asBrowser, asMaster].map((s) => s.next("hello")),
      );
      expect(app.hub.clientCount).toBe(5);

      const closed = [asPhone.closed(), asPhoneToo.closed()];
      const res = await app.api(API_ROUTES.pairedDevice(phone.device.id), { method: "DELETE" });
      expect(res.status).toBe(204);
      for (const close of await Promise.all(closed)) {
        expect(close).toEqual({ code: 1008, reason: "Device revoked" });
      }
      await waitFor(() => app.hub.clientCount === 3);
      // The others keep receiving events.
      app.runtime.emit("status", app.runtime.status());
      await Promise.all([asLaptop, asBrowser, asMaster].map((s) => s.next("agent.status")));
      expect(asPhone.count("agent.status")).toBe(0);

      expect(
        await upgradeOutcome(url, { headers: { authorization: `Bearer ${phone.token}` } }),
      ).toBe("HTTP 401");

      const browserClosed = asBrowser.closed();
      await app.devices.revoke(browser.device.id);
      expect(await browserClosed).toEqual({ code: 1008, reason: "Device revoked" });
      for (const s of [asLaptop, asMaster, asPhone, asPhoneToo, asBrowser]) s.ws.terminate();
    } finally {
      await app.close();
    }
  });
});

describe("the registry and the WebSocket", () => {
  it("allows upgrades on a remote host only while it is configured", async () => {
    const remoteHosts = createRemoteHosts();
    const app = await startLiveApp({ remoteHosts });
    try {
      const upgrade = () =>
        rawRequest(
          app.port,
          httpRequest("GET", API_ROUTES.ws, [
            ["Host", REMOTE],
            ["Origin", `https://${REMOTE}`],
            ["Authorization", `Bearer ${app.token}`],
            ...WS_UPGRADE_HEADERS,
          ]),
        );
      expect((await upgrade()).status).toBe(403);
      remoteHosts.set([REMOTE]);
      expect((await upgrade()).status).toBe(101);
      remoteHosts.set([]);
      expect((await upgrade()).status).toBe(403);
    } finally {
      await app.close();
    }
  });
});
