/**
 * Remote hosts in the security policy: configured names add a Host, their `https://` Origin and
 * `wss://` in the page's CSP, and the policy follows the registry live. Nothing is inferred.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { API_ROUTES } from "@ddl/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createRemoteHosts } from "../remote-hosts";
import { createSecurityPolicy } from "../security";
import { createTestApp, TEST_PORT, tempDir, testToken } from "../test-helpers";
import {
  httpRequest,
  rawRequest,
  startLiveApp,
  upgradeOutcome,
  WS_UPGRADE_HEADERS,
} from "./harness";

const REMOTE = "vm-name.tailnet-name.ts.net";

function policyWith(hosts: string[], extraOrigins: string[] = []) {
  const remoteHosts = createRemoteHosts(hosts);
  return {
    remoteHosts,
    policy: createSecurityPolicy({
      port: TEST_PORT,
      token: testToken(),
      extraOrigins,
      remoteHosts,
    }),
  };
}

describe("host kinds", () => {
  it("serves loopback names as loopback and configured names as remote, nothing else", () => {
    const { policy } = policyWith([REMOTE, "other.example.com:8443"]);
    for (const host of ["127.0.0.1:7331", "localhost:7331", "LOCALHOST:5173", " 127.0.0.1:5173 "]) {
      expect(policy.hostKind(host), host).toBe("loopback");
    }
    for (const host of [REMOTE, "VM-NAME.tailnet-name.ts.net", "other.example.com:8443"]) {
      expect(policy.hostKind(host), host).toBe("remote");
    }
    for (const host of [
      `${REMOTE}:7331`,
      `${REMOTE}.evil.example`,
      `evil.${REMOTE}`,
      "other.example.com",
      "tailnet-name.ts.net",
      "100.64.0.1",
      "127.0.0.1",
      "",
      undefined,
      null,
    ]) {
      expect(policy.hostKind(host), String(host)).toBeNull();
    }
  });

  it("treats a default :443 as the bare name, as browsers send it", () => {
    const { policy } = policyWith([`${REMOTE}:443`]);
    expect(policy.hostKind(REMOTE)).toBe("remote");
    expect(policy.hostKind(`${REMOTE}:443`)).toBe("remote");
    expect(policy.isOriginAllowed(`https://${REMOTE}`)).toBe(true);
    expect(policy.remoteOrigin(`${REMOTE}:443`)).toBe(`https://${REMOTE}`);
    expect(policy.remoteSocketSources()).toEqual([`wss://${REMOTE}`]);
  });

  it("never treats a non-loopback allowedOrigins host as loopback", () => {
    const { policy } = policyWith([], ["http://app.example:8443", "http://localhost:5174"]);
    expect(policy.hostKind("localhost:5174")).toBe("loopback");
    expect(policy.hostKind("app.example:8443")).toBe("remote");
    // Its own https origin isn't configured, so a device cookie can never be used there.
    expect(policy.remoteOrigin("app.example:8443")).toBeNull();
  });
});

describe("origins", () => {
  it("adds only the https origin of each remote host", () => {
    const { policy } = policyWith([REMOTE, "other.example.com:8443"]);
    expect(policy.isOriginAllowed(`https://${REMOTE}`)).toBe(true);
    expect(policy.isOriginAllowed(`HTTPS://${REMOTE.toUpperCase()}/`)).toBe(true);
    expect(policy.isOriginAllowed("https://other.example.com:8443")).toBe(true);
    for (const origin of [
      `http://${REMOTE}`,
      `wss://${REMOTE}`,
      `https://${REMOTE}:8443`,
      "https://other.example.com",
      `https://evil.${REMOTE}`,
      "null",
    ]) {
      expect(policy.isOriginAllowed(origin), origin).toBe(false);
    }
    expect(policy.remoteOrigin(REMOTE)).toBe(`https://${REMOTE}`);
    expect(policy.remoteOrigin("127.0.0.1:7331")).toBeNull();
    expect(policy.remoteOrigin("evil.example")).toBeNull();
  });
});

describe("the registry drives the policy live", () => {
  it("allows a host the moment it's added and refuses it the moment it's removed", async () => {
    const remoteHosts = createRemoteHosts();
    const { request } = await createTestApp({ remoteHosts });
    const health = () => request(API_ROUTES.health, { host: REMOTE, origin: `https://${REMOTE}` });
    expect((await health()).status).toBe(403);
    remoteHosts.set([REMOTE]);
    expect((await health()).status).toBe(200);
    remoteHosts.set(["other.example.com"]);
    const refused = await health();
    expect(refused.status).toBe(403);
    expect(await refused.json()).toMatchObject({ error: "forbidden_host" });
  });

  it("updates the page's connect-src without a restart", async () => {
    const dist = tempDir("ddl-remote-csp-");
    try {
      mkdirSync(dist.path, { recursive: true });
      writeFileSync(join(dist.path, "index.html"), "<html><head></head><body></body></html>");
      const remoteHosts = createRemoteHosts();
      const { request } = await createTestApp({ webDist: dist.path, remoteHosts });
      const csp = async () =>
        (await request("/", { token: null })).headers.get("content-security-policy") ?? "";
      expect(await csp()).toContain("connect-src 'self' ws://127.0.0.1:7331 ws://localhost:7331;");
      remoteHosts.set([REMOTE, "other.example.com:8443"]);
      expect(await csp()).toContain(
        `connect-src 'self' ws://127.0.0.1:7331 ws://localhost:7331 wss://${REMOTE} wss://other.example.com:8443;`,
      );
      expect(await csp()).not.toContain(`ws://${REMOTE}`);
    } finally {
      dist.cleanup();
    }
  });
});

describe("proxies that rewrite the Host to loopback", () => {
  let live: Awaited<ReturnType<typeof startLiveApp>>;
  beforeAll(async () => {
    live = await startLiveApp({ remoteHosts: createRemoteHosts([REMOTE]) });
  });
  afterAll(() => live.close());

  it.each([
    ["x-forwarded-for", "100.64.0.7"],
    ["x-forwarded-host", REMOTE],
    ["forwarded", "for=100.64.0.7;proto=https"],
    ["x-real-ip", "100.64.0.7"],
  ])("refuses a loopback Host forwarded with %s, over HTTP and WebSocket", async (name, value) => {
    const res = await live.api(API_ROUTES.health, { headers: { [name]: value } });
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: "forbidden_host" });
    expect(await upgradeOutcome(live.wsUrl(), { headers: { [name]: value } })).toBe("HTTP 403");
  });

  it("serves a remote Host forwarded by a proxy that keeps the Host", async () => {
    const res = await rawRequest(
      live.port,
      httpRequest("GET", API_ROUTES.health, [
        ["Host", REMOTE],
        ["Authorization", `Bearer ${live.token}`],
        ["X-Forwarded-For", "100.64.0.7"],
        ["X-Forwarded-Proto", "https"],
        ["Connection", "close"],
      ]),
    );
    expect(res.status).toBe(200);
  });

  it("refuses an absolute-form target that isn't allowed, whatever the Host", async () => {
    for (const host of [live.host, REMOTE]) {
      const res = await rawRequest(
        live.port,
        httpRequest("GET", `http://evil.example${API_ROUTES.health}`, [
          ["Host", host],
          ["Authorization", `Bearer ${live.token}`],
          ["Connection", "close"],
        ]),
      );
      expect(res.status, host).toBe(403);
      const ws = await rawRequest(
        live.port,
        httpRequest("GET", `http://evil.example${API_ROUTES.ws}?token=${live.token}`, [
          ["Host", host],
          ...WS_UPGRADE_HEADERS,
        ]),
      );
      expect(ws.status, `ws ${host}`).toBe(403);
    }
  });
});

describe("a Host and an absolute-form target of different kinds", () => {
  it("is served as remote: the page never embeds the token", async () => {
    const dist = tempDir("ddl-remote-mixed-");
    const live = await startLiveApp({
      remoteHosts: createRemoteHosts([REMOTE]),
      webDist: dist.path,
    });
    try {
      writeFileSync(join(dist.path, "index.html"), "<html><head></head><body></body></html>");
      for (const [target, host] of [
        [`http://${REMOTE}/`, live.host],
        [`http://${live.host}/`, REMOTE],
      ] as const) {
        const res = await rawRequest(
          live.port,
          httpRequest("GET", target, [
            ["Host", host],
            ["Connection", "close"],
          ]),
        );
        expect(res.status, target).toBe(200);
        expect(res.body, target).not.toContain(live.token);
        expect(res.body, target).not.toContain("ddl-token");
        expect(res.body, target).toContain('<meta name="ddl-auth" content="pairing">');
      }
      const loopback = await rawRequest(
        live.port,
        httpRequest("GET", "/", [
          ["Host", live.host],
          ["Connection", "close"],
        ]),
      );
      expect(loopback.body).toContain(live.token);
    } finally {
      await live.close();
      dist.cleanup();
    }
  });
});
