import { API_ROUTES } from "@ddl/core";
import { describe, expect, it } from "vitest";
import { MAX_PAIRED_DEVICES, PairedDeviceStore } from "../paired-devices";
import { PAIRING_LIMITS, PairingCodes } from "../pairing";
import { createRemoteHosts } from "../remote-hosts";
import { RecordingLogger } from "../security/harness";
import { createTestApp, type TestApp } from "../test-helpers";

const REMOTE = "vm-name.tailnet-name.ts.net";

async function issueCode(app: TestApp, name?: string): Promise<string> {
  const res = await app.request(API_ROUTES.pairingCodes, { method: "POST", json: { name } });
  expect(res.status).toBe(201);
  return ((await res.json()) as { code: string }).code;
}

function pair(app: TestApp, json: unknown, init: { host?: string; origin?: string } = {}) {
  return app.request(API_ROUTES.pair, { method: "POST", json, token: null, ...init });
}

describe("POST /api/pair", () => {
  it("pairs from a remote host and the token then works as a bearer token", async () => {
    const app = await createTestApp({ remoteHosts: createRemoteHosts([REMOTE]) });
    const code = await issueCode(app);
    const res = await pair(
      app,
      { code, name: "Phone", kind: "app" },
      { host: REMOTE, origin: `https://${REMOTE}` },
    );
    expect(res.status).toBe(201);
    const { token } = (await res.json()) as { token: string };
    for (const host of [REMOTE, "127.0.0.1:7331"]) {
      expect((await app.request(API_ROUTES.tree, { host, token })).status, host).toBe(200);
    }
  });

  it("is open to POST only: every other method still needs a credential", async () => {
    const app = await createTestApp();
    for (const method of ["GET", "PUT", "DELETE"]) {
      expect((await app.request(API_ROUTES.pair, { method, token: null })).status, method).toBe(
        401,
      );
    }
    expect((await app.request(`${API_ROUTES.pair}/`, { method: "POST", token: null })).status).toBe(
      401,
    );
  });

  it("still checks the Host and Origin", async () => {
    const app = await createTestApp();
    const code = await issueCode(app);
    const body = { code, name: "Phone", kind: "app" };
    expect((await pair(app, body, { host: "evil.example" })).status).toBe(403);
    for (const origin of ["https://evil.example", "null", `https://${REMOTE}`]) {
      expect((await pair(app, body, { origin })).status, origin).toBe(403);
    }
    expect((await pair(app, body)).status).toBe(201);
  });

  it("invalidates every outstanding code after 10 wrong ones", async () => {
    let clock = 1_790_000_000_000;
    const pairing = new PairingCodes({ now: () => clock });
    const app = await createTestApp({ pairing });
    const code = await issueCode(app);
    for (let i = 0; i < PAIRING_LIMITS.failuresBeforeInvalidation; i++) {
      clock += 15_000;
      const res = await pair(app, { code: "ZZZZ-ZZZZ", name: "x", kind: "app" });
      expect(res.status).toBe(401);
    }
    clock += 15_000;
    expect((await pair(app, { code, name: "Phone", kind: "app" })).status).toBe(401);
    expect(app.devices.size).toBe(0);
  });

  it("keeps the code when the device list is full", async () => {
    const devices = new PairedDeviceStore({ path: null, logger: new RecordingLogger() });
    const app = await createTestApp({ devices });
    const code = await issueCode(app);
    const first = await devices.add("Device 0", "app");
    for (let i = 1; i < MAX_PAIRED_DEVICES; i++) await devices.add(`Device ${i}`, "app");
    const full = await pair(app, { code, name: "Phone", kind: "app" });
    expect(full.status).toBe(429);
    expect(await full.json()).toMatchObject({ error: "rate_limited" });
    const issue = await app.request(API_ROUTES.pairingCodes, { method: "POST", json: {} });
    expect(issue.status).toBe(429);
    await devices.revoke(first.device.id);
    expect((await pair(app, { code, name: "Phone", kind: "app" })).status).toBe(201);
  });

  it("gives a browser an HttpOnly cookie instead of a token", async () => {
    const app = await createTestApp({ remoteHosts: createRemoteHosts([REMOTE]) });
    const code = await issueCode(app, "Work browser");
    const res = await pair(
      app,
      { code, name: "Browser", kind: "browser" },
      { host: REMOTE, origin: `https://${REMOTE}` },
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as { device: object; token?: string };
    expect(body).toEqual({
      device: expect.objectContaining({ name: "Work browser", kind: "browser" }),
    });
    const cookie = res.headers.get("set-cookie") ?? "";
    const [pairValue, ...attributes] = cookie.split(/;\s*/);
    expect(pairValue).toMatch(/^__Host-ddl-device=[A-Za-z0-9_-]{43}$/);
    expect(attributes.sort()).toEqual(
      ["HttpOnly", "Max-Age=34560000", "Path=/", "SameSite=Strict", "Secure"].sort(),
    );
    const value = pairValue!.slice("__Host-ddl-device=".length);
    const withCookie = { cookie: `theme=dark; __Host-ddl-device=${value}` };
    const tree = (headers: Record<string, string>, host = REMOTE) =>
      app.request(API_ROUTES.tree, { host, token: null, headers });
    expect((await tree({ ...withCookie, origin: `https://${REMOTE}` })).status).toBe(200);
    expect((await tree({ ...withCookie, "sec-fetch-site": "same-origin" })).status).toBe(200);
    // Not a bearer token, not without proof it's the page itself, never on loopback.
    expect((await app.request(API_ROUTES.tree, { host: REMOTE, token: value })).status).toBe(401);
    expect((await tree(withCookie)).status).toBe(401);
    for (const site of ["same-site", "cross-site", "none"]) {
      expect((await tree({ ...withCookie, "sec-fetch-site": site })).status, site).toBe(401);
    }
    expect((await tree({ ...withCookie, origin: "http://127.0.0.1:7331" })).status).toBe(401);
    expect(
      (await tree({ ...withCookie, origin: "http://127.0.0.1:7331" }, "127.0.0.1:7331")).status,
    ).toBe(401);
    expect(
      (await tree({ ...withCookie, "sec-fetch-site": "same-origin" }, "127.0.0.1:7331")).status,
    ).toBe(401);
    // Two device cookies are ambiguous.
    const twice = { cookie: `__Host-ddl-device=${value}; __Host-ddl-device=${value}` };
    expect((await tree({ ...twice, origin: `https://${REMOTE}` })).status).toBe(401);
  });

  it("pairs a browser only from its own page on a remote host", async () => {
    const remoteHosts = createRemoteHosts([REMOTE, "other.example.com"]);
    let clock = 1_790_000_000_000;
    const app = await createTestApp({
      remoteHosts,
      allowedOrigins: ["http://app.example:8443"],
      pairing: new PairingCodes({ now: () => (clock += 15_000) }),
    });
    const code = await issueCode(app);
    const body = { code, name: "Browser", kind: "browser" };
    for (const [host, origin] of [
      ["127.0.0.1:7331", "http://127.0.0.1:7331"],
      ["127.0.0.1:7331", undefined],
      [REMOTE, undefined],
      [REMOTE, "https://other.example.com"],
      ["other.example.com", `https://${REMOTE}`],
      ["app.example:8443", "http://app.example:8443"],
    ] as const) {
      const res = await pair(app, body, { host, ...(origin ? { origin } : {}) });
      expect(res.status, `${host} ${origin}`).toBe(400);
      expect(res.headers.get("set-cookie")).toBeNull();
    }
    // The refusals didn't use the code up.
    const ok = await pair(app, body, { host: REMOTE, origin: `https://${REMOTE}` });
    expect(ok.status).toBe(201);
  });

  it("clears a browser's cookie when it revokes itself", async () => {
    const app = await createTestApp({ remoteHosts: createRemoteHosts([REMOTE]) });
    const browser = await app.devices.add("Browser", "browser");
    const phone = await app.devices.add("Phone", "app");
    const asBrowser = {
      host: REMOTE,
      origin: `https://${REMOTE}`,
      token: null,
      headers: { cookie: `__Host-ddl-device=${browser.token}` },
    };
    const other = await app.request(API_ROUTES.pairedDevice(phone.device.id), {
      ...asBrowser,
      method: "DELETE",
    });
    expect(other.status).toBe(204);
    expect(other.headers.get("set-cookie")).toBeNull();
    const self = await app.request(API_ROUTES.pairedDevice(browser.device.id), {
      ...asBrowser,
      method: "DELETE",
    });
    expect(self.status).toBe(204);
    expect(self.headers.get("set-cookie")).toBe(
      "__Host-ddl-device=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0",
    );
    expect((await app.request(API_ROUTES.tree, asBrowser)).status).toBe(401);
  });

  it("never logs a code or a token", async () => {
    const logger = new RecordingLogger();
    const app = await createTestApp({ logger });
    const code = await issueCode(app);
    await pair(app, { code: "ZZZZZZZZ", name: "x", kind: "app" });
    const res = await pair(app, { code, name: "Phone", kind: "app" });
    const { token, device } = (await res.json()) as { token: string; device: { id: string } };
    await app.request(API_ROUTES.pairedDevice(device.id), { method: "DELETE" });
    const log = logger.lines.join("\n");
    expect(log).toMatch(/Issued a pairing code/);
    expect(log).toMatch(/Refused a pairing code/);
    expect(log).toMatch(/Paired a device/);
    expect(log).toMatch(/Revoked a device/);
    expect(log).not.toContain(code);
    expect(log).not.toContain(token);
    expect(log).not.toContain(app.token);
  });
});
