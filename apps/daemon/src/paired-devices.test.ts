import { createHash } from "node:crypto";
import { chmodSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { silentLogger } from "@ddl/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  BEARER_DEVICE_KINDS,
  COOKIE_DEVICE_KINDS,
  LAST_SEEN_RESOLUTION_MS,
  MAX_PAIRED_DEVICES,
  PairedDeviceStore,
  TooManyPairedDevicesError,
} from "./paired-devices";
import { RecordingLogger } from "./security/harness";
import { tempDir } from "./test-helpers";

const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");

let dir: { path: string; cleanup: () => void };
let path: string;
let clock: number;
const now = () => clock;

beforeEach(() => {
  dir = tempDir("ddl-devices-");
  path = join(dir.path, "devices.json");
  clock = 1_790_000_000_000;
});
afterEach(() => dir.cleanup());

const memory = () => new PairedDeviceStore({ path: null, logger: silentLogger, now });
const onDisk = (logger = silentLogger) => PairedDeviceStore.open({ path, logger, now });

describe("pairing a device", () => {
  it("hands out a 256-bit token once and lists the device without it", async () => {
    const store = memory();
    const { device, token } = await store.add("  Phone ", "app");
    expect(Buffer.from(token, "base64url")).toHaveLength(32);
    expect(device).toEqual({
      id: expect.stringMatching(/^pd_[A-Za-z0-9]{16}$/),
      name: "Phone",
      kind: "app",
      createdAt: clock,
      lastSeenAt: null,
    });
    expect(store.list()).toEqual([device]);
    expect(JSON.stringify(store.list())).not.toContain(token);
    const second = await store.add("Laptop", "daemon");
    expect(second.token).not.toBe(token);
    expect(second.device.id).not.toBe(device.id);
  });

  it("refuses names that aren't device names", async () => {
    await expect(memory().add("   ", "app")).rejects.toThrow(RangeError);
    await expect(memory().add("a\nb", "app")).rejects.toThrow(RangeError);
    await expect(memory().add("x".repeat(65), "app")).rejects.toThrow(RangeError);
  });

  it(`pairs at most ${MAX_PAIRED_DEVICES} devices`, async () => {
    const store = memory();
    for (let i = 0; i < MAX_PAIRED_DEVICES; i++) await store.add(`Device ${i}`, "app");
    expect(store.isFull).toBe(true);
    await expect(store.add("One more", "app")).rejects.toThrow(TooManyPairedDevicesError);
  });
});

describe("authenticating a device", () => {
  it("accepts exactly its token, for the kinds that may present it", async () => {
    const store = memory();
    const app = await store.add("Phone", "app");
    const browser = await store.add("Browser", "browser");
    expect(store.authenticate(app.token, BEARER_DEVICE_KINDS)?.id).toBe(app.device.id);
    expect(store.authenticate(browser.token, COOKIE_DEVICE_KINDS)?.id).toBe(browser.device.id);
    // A browser's cookie is not a bearer token, and an app's token is not a cookie.
    expect(store.authenticate(browser.token, BEARER_DEVICE_KINDS)).toBeNull();
    expect(store.authenticate(app.token, COOKIE_DEVICE_KINDS)).toBeNull();
    for (const candidate of [
      "",
      undefined,
      null,
      `${app.token}x`,
      app.token.slice(1),
      app.token.toUpperCase(),
      sha256(app.token),
      "x".repeat(10_000),
    ]) {
      expect(store.authenticate(candidate, BEARER_DEVICE_KINDS), String(candidate)).toBeNull();
    }
  });

  it("records use with one-minute resolution", async () => {
    const store = memory();
    const { device, token } = await store.add("Phone", "app");
    clock += 5_000;
    const seen = clock;
    expect(store.authenticate(token, BEARER_DEVICE_KINDS)?.lastSeenAt).toBe(seen);
    clock += LAST_SEEN_RESOLUTION_MS - 1;
    expect(store.authenticate(token, BEARER_DEVICE_KINDS)?.lastSeenAt).toBe(seen);
    clock += 1;
    expect(store.authenticate(token, BEARER_DEVICE_KINDS)?.lastSeenAt).toBe(clock);
    expect(store.get(device.id)?.lastSeenAt).toBe(clock);
  });
});

describe("revoking a device", () => {
  it("stops its token at once and tells every listener", async () => {
    const store = memory();
    const phone = await store.add("Phone", "app");
    const laptop = await store.add("Laptop", "app");
    const revoked: string[] = [];
    store.onRevoke(() => {
      throw new Error("listener bug");
    });
    const off = store.onRevoke((id) => revoked.push(id));
    expect(await store.revoke(phone.device.id)).toBe(true);
    expect(store.authenticate(phone.token, BEARER_DEVICE_KINDS)).toBeNull();
    expect(store.authenticate(laptop.token, BEARER_DEVICE_KINDS)?.id).toBe(laptop.device.id);
    expect(await store.revoke(phone.device.id)).toBe(false);
    expect(await store.revoke("pd_unknown")).toBe(false);
    off();
    await store.revoke(laptop.device.id);
    expect(revoked).toEqual([phone.device.id]);
    expect(store.list()).toEqual([]);
  });
});

describe("devices.json", () => {
  it("is 0600 and holds token hashes only, never tokens", async () => {
    const store = await onDisk();
    const phone = await store.add("Phone", "app");
    const browser = await store.add("Browser", "browser");
    expect(statSync(path).mode & 0o777).toBe(0o600);
    const content = readFileSync(path, "utf8");
    for (const { token } of [phone, browser]) {
      expect(content).not.toContain(token);
      expect(content).not.toContain(Buffer.from(token, "base64url").toString("hex"));
      expect(content).toContain(sha256(token));
    }
    expect(JSON.parse(content)).toEqual({
      version: 1,
      devices: [
        expect.objectContaining({ id: phone.device.id, name: "Phone", kind: "app" }),
        expect.objectContaining({ id: browser.device.id, name: "Browser", kind: "browser" }),
      ],
    });
    expect(readdirSync(dir.path)).toEqual(["devices.json"]);
  });

  it("survives a restart, revocations included", async () => {
    const first = await onDisk();
    const phone = await first.add("Phone", "app");
    const laptop = await first.add("Laptop", "daemon");
    await first.revoke(laptop.device.id);
    const second = await onDisk();
    expect(second.list().map((d) => d.id)).toEqual([phone.device.id]);
    expect(second.authenticate(phone.token, BEARER_DEVICE_KINDS)?.id).toBe(phone.device.id);
    expect(second.authenticate(laptop.token, BEARER_DEVICE_KINDS)).toBeNull();
  });

  it("writes lastSeenAt at most once a minute", async () => {
    const store = await onDisk();
    const { token } = await store.add("Phone", "app");
    const lastSeen = () =>
      (JSON.parse(readFileSync(path, "utf8")) as { devices: Array<{ lastSeenAt: number }> })
        .devices[0]?.lastSeenAt;
    clock += 1_000;
    const first = clock;
    store.authenticate(token, BEARER_DEVICE_KINDS);
    await store.flush();
    expect(lastSeen()).toBe(first);
    const { mtimeMs } = statSync(path);
    for (let i = 0; i < 20; i++) {
      clock += 2_000;
      store.authenticate(token, BEARER_DEVICE_KINDS);
    }
    await store.flush();
    expect(lastSeen()).toBe(first);
    expect(statSync(path).mtimeMs).toBe(mtimeMs);
    clock = first + LAST_SEEN_RESOLUTION_MS;
    store.authenticate(token, BEARER_DEVICE_KINDS);
    await store.flush();
    expect(lastSeen()).toBe(clock);
  });

  it("keeps every device when many pair at once", async () => {
    const store = await onDisk();
    const paired = await Promise.all(
      Array.from({ length: 10 }, (_, i) => store.add(`Device ${i}`, "app")),
    );
    const reopened = await onDisk();
    expect(reopened.size).toBe(10);
    for (const { token, device } of paired) {
      expect(reopened.authenticate(token, BEARER_DEVICE_KINDS)?.id).toBe(device.id);
    }
    expect(readdirSync(dir.path)).toEqual(["devices.json"]);
  });

  it("tightens a file others can read", async () => {
    const store = await onDisk();
    await store.add("Phone", "app");
    chmodSync(path, 0o644);
    const logger = new RecordingLogger();
    await onDisk(logger);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(logger.lines.join("\n")).toMatch(/restricted it to 0600/);
  });

  it("fails closed on a file it can't read: moved aside, nobody paired", async () => {
    for (const content of [
      "{ nope",
      JSON.stringify({ version: 2, devices: [] }),
      JSON.stringify({ version: 1, devices: [{ id: "pd_x", tokenSha256: "abc" }] }),
    ]) {
      writeFileSync(path, content, { mode: 0o600 });
      const logger = new RecordingLogger();
      const store = await onDisk(logger);
      expect(store.list()).toEqual([]);
      expect(readFileSync(`${path}.invalid`, "utf8")).toBe(content);
      expect(logger.lines.join("\n")).toMatch(/must pair again/);
    }
  });
});
