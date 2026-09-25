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
