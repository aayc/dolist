import { randomBytes } from "node:crypto";
import { readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { RecordingLogger } from "./security/harness";
import { defaultDeviceName, loadOrCreateDevice, loadSyncToken, prepareSync } from "./sync-setup";
import { tempDir } from "./test-helpers";

let dir: { path: string; cleanup: () => void };
let logger: RecordingLogger;

beforeEach(() => {
  dir = tempDir("ddl-sync-setup-");
  logger = new RecordingLogger();
});

afterEach(() => dir.cleanup());

describe("device identity", () => {
  it("is created once, private, named after the machine", async () => {
    const path = join(dir.path, "device.json");
    const device = await loadOrCreateDevice(path, logger, "Studio-Mac.local");
    expect(device).toEqual({ id: expect.stringMatching(/^dev_[0-9a-z]{20}$/), name: "Studio-Mac" });
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual(device);
    expect(await loadOrCreateDevice(path, logger, "Other-Host")).toEqual(device);
  });

  it("keeps a name the user chose and repairs what's broken", async () => {
    const path = join(dir.path, "device.json");
    writeFileSync(path, JSON.stringify({ id: "has spaces!", name: "  Kitchen iPad  " }));
    const repaired = await loadOrCreateDevice(path, logger, "host");
    expect(repaired).toEqual({ id: expect.stringMatching(/^dev_/), name: "Kitchen iPad" });
    writeFileSync(path, "{ not json");
    expect((await loadOrCreateDevice(path, logger, "host")).name).toBe("host");
    expect(logger.lines.some((line) => line.includes("device.json is unreadable"))).toBe(true);
  });

  it("names devices from the host name without its domain", () => {
    expect(defaultDeviceName("Aarons-MacBook-Pro.local")).toBe("Aarons-MacBook-Pro");
    expect(defaultDeviceName("desktop")).toBe("desktop");
    expect(defaultDeviceName("")).toBe("This device");
    expect(defaultDeviceName(".hidden")).toBe("This device");
  });
});

describe("sync token", () => {
  const secret = randomBytes(32).toString("base64url");

  it("comes from DDL_SYNC_TOKEN first, then the token file", async () => {
    const path = join(dir.path, "sync-token");
    expect(await loadSyncToken({ path, env: {}, logger })).toBeNull();
    writeFileSync(path, `${secret}\n`, { mode: 0o600 });
    expect(await loadSyncToken({ path, env: {}, logger })).toBe(secret);
    expect(await loadSyncToken({ path, env: { DDL_SYNC_TOKEN: " from-env " }, logger })).toBe(
      "from-env",
    );
  });

  it("tightens a token file other users can read", async () => {
    const path = join(dir.path, "sync-token");
    writeFileSync(path, secret, { mode: 0o644 });
    expect(await loadSyncToken({ path, env: {}, logger })).toBe(secret);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(logger.lines.join("\n")).toContain("restricted it to 0600");
  });

  it("refuses something that isn't a token without repeating it", async () => {
    const path = join(dir.path, "sync-token");
    writeFileSync(path, `export TOKEN=${secret} # pasted from a shell`, { mode: 0o600 });
    const error = await loadSyncToken({ path, env: {}, logger }).catch((e: unknown) => e);
    expect(String(error)).toMatch(/doesn't hold a sync token/);
    expect(String(error)).not.toContain(secret);
  });
});

describe("prepareSync", () => {
  const device = { id: "dev_laptop", name: "Laptop" };
  const syncTokenPath = () => join(dir.path, "sync-token");
  const remote = { kind: "remote", url: "https://sync.example.com", vault: "v_1" } as const;

  it("passes other targets through", async () => {
    const prepared = await prepareSync({
      sync: { kind: "local", root: "/somewhere" },
      syncTokenPath: syncTokenPath(),
      device,
      env: {},
      logger,
    });
    expect(prepared).toEqual({ target: { kind: "local", root: "/somewhere" } });
  });

  it("builds the remote target from the config, the token and the device", async () => {
    writeFileSync(syncTokenPath(), "the-token", { mode: 0o600 });
    const prepared = await prepareSync({
      sync: remote,
      syncTokenPath: syncTokenPath(),
      device,
      env: {},
      logger,
    });
    expect(prepared.target).toEqual({
      kind: "remote",
      url: "https://sync.example.com",
      vault: "v_1",
      token: "the-token",
      deviceId: "dev_laptop",
      deviceName: "Laptop",
    });
    expect(prepared.remote).toMatchObject({ host: "sync.example.com", device: { name: "Laptop" } });
    expect(prepared.remote?.client?.host).toBe("sync.example.com");
    expect(logger.lines.join("\n")).not.toContain("the-token");
  });

  it("turns sync off with a reason when there is no token", async () => {
    const prepared = await prepareSync({
      sync: remote,
      syncTokenPath: syncTokenPath(),
      device,
      env: {},
      logger,
    });
    expect(prepared.target).toBeNull();
    expect(prepared.remote?.client).toBeUndefined();
    expect(prepared.remote?.problem).toMatch(/no token/);
  });
});
