import { randomBytes } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { silentLogger } from "@ddl/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type DaemonSyncConfig, loadConfig } from "./config";
import { DeviceSettings, deviceSettingsFiles } from "./device-settings";
import { createRemoteHosts } from "./remote-hosts";
import { RecordingLogger } from "./security/harness";
import { tempDir } from "./test-helpers";

let dir: { path: string; cleanup: () => void };
let home: string;

beforeEach(() => {
  dir = tempDir("ddl-device-settings-");
  home = join(dir.path, "home");
});

afterEach(() => dir.cleanup());

function load(env: Record<string, string> = {}) {
  return loadConfig({
    env: { DDL_HOME: home, ...env },
    cwd: dir.path,
    homedir: dir.path,
    platform: "linux",
  });
}

function settingsFor(
  config: ReturnType<typeof load>,
  applied: DaemonSyncConfig[] = [],
  logger = silentLogger,
) {
  return new DeviceSettings({
    device: { id: "dev_laptop", name: "Laptop" },
    placement: config.placement,
    sync: config.sync,
    lockedByEnv: config.lockedByEnv,
    remoteHosts: createRemoteHosts(config.remoteHosts),
    files: deviceSettingsFiles(config),
    hasToken: false,
    applySync: async (sync) => {
      applied.push(sync);
    },
    logger,
  });
}

const json = (path: string): unknown => JSON.parse(readFileSync(path, "utf8"));
const mode = (path: string) => statSync(path).mode & 0o777;

describe("device settings on disk", () => {
  it("edit config.json in place, keeping keys they don't own", async () => {
    load();
    writeFileSync(
      join(home, "config.json"),
      JSON.stringify({
        port: 7400,
        agent: { placement: "this_device" },
        remote: { hosts: ["old.example"] },
      }),
    );
    const config = load();
    expect(config).toMatchObject({ placement: "this_device", remoteHosts: ["old.example"] });
    const settings = settingsFor(config);
    const placements: string[] = [];
    settings.onPlacementChange((placement) => placements.push(placement));

    await settings.patch({
      placement: "always_on_host",
      remoteHosts: ["vm-name.tailnet-name.ts.net"],
    });
    expect(json(config.configPath)).toEqual({
      port: 7400,
      agent: { placement: "always_on_host" },
      remote: { hosts: ["vm-name.tailnet-name.ts.net"] },
    });
    expect(mode(config.configPath)).toBe(0o600);
    expect(placements).toEqual(["always_on_host"]);
    expect(readdirSync(home).filter((name) => name.endsWith(".tmp"))).toEqual([]);
    expect(load()).toMatchObject({
      port: 7400,
      placement: "always_on_host",
      remoteHosts: ["vm-name.tailnet-name.ts.net"],
    });
  });

  it("rename the device in device.json", async () => {
    const config = load();
    const settings = settingsFor(config);
    const device = settings.device;
    await settings.patch({ name: "Work laptop" });
    expect(json(config.devicePath)).toEqual({ id: "dev_laptop", name: "Work laptop" });
    expect(mode(config.devicePath)).toBe(0o600);
    expect(device.name).toBe("Work laptop");
    expect(settings.response().device).toEqual({ id: "dev_laptop", name: "Work laptop" });
  });

  it("refuse fields set by environment variables, and say so", async () => {
    const config = load({
      DDL_AGENT_PLACEMENT: "always_on_host",
      DDL_REMOTE_HOSTS: "vm-name.tailnet-name.ts.net, other.example",
      DDL_SYNC_TOKEN: "t",
    });
    expect(config).toMatchObject({
      placement: "always_on_host",
      remoteHosts: ["vm-name.tailnet-name.ts.net", "other.example"],
      lockedByEnv: ["placement", "remoteHosts", "sync"],
    });
    const settings = settingsFor(config);
    for (const attempt of [
      () => settings.patch({ placement: "this_device" }),
      () => settings.patch({ remoteHosts: [] }),
      () => settings.setupSync({ url: "https://sync.example.com", vault: "v_1", token: "t" }),
      () => settings.removeSync(),
    ]) {
      await expect(attempt()).rejects.toMatchObject({ status: 409, code: "locked_by_env" });
    }
    expect(existsSync(config.configPath)).toBe(false);
  });

  it("save the sync setup with its token 0600, never returning or logging the token", async () => {
    const config = load();
    const applied: DaemonSyncConfig[] = [];
    const logger = new RecordingLogger();
    const settings = settingsFor(config, applied, logger);
    const secret = randomBytes(32).toString("base64url");

    await expect(
      settings.setupSync({ url: "https://sync.example.com", vault: "v_1" }),
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      settings.setupSync({ url: "http://sync.example.com", vault: "v_1", token: secret }),
    ).rejects.toMatchObject({ status: 400 });

    const response = await settings.setupSync({
      url: "https://sync.example.com",
      vault: "v_1",
      token: secret,
    });
    expect(response.sync).toEqual({
      url: "https://sync.example.com",
      vault: "v_1",
      hasToken: true,
    });
    expect(JSON.stringify(response)).not.toContain(secret);
    expect(readFileSync(config.syncTokenPath, "utf8")).toBe(`${secret}\n`);
    expect(mode(config.syncTokenPath)).toBe(0o600);
    expect(json(config.configPath)).toEqual({
      sync: { kind: "remote", url: "https://sync.example.com", vault: "v_1" },
    });
    expect(applied).toEqual([{ kind: "remote", url: "https://sync.example.com", vault: "v_1" }]);
    expect(load().sync).toEqual(applied[0]);

    // A new address keeps the saved token.
    await settings.setupSync({ url: "https://sync2.example.com", vault: "v_2" });
    expect(readFileSync(config.syncTokenPath, "utf8")).toBe(`${secret}\n`);

    const off = await settings.removeSync();
    expect(off.sync).toEqual({ url: null, vault: null, hasToken: false });
    expect(existsSync(config.syncTokenPath)).toBe(false);
    expect(json(config.configPath)).toEqual({});
    expect(applied.at(-1)).toEqual({ kind: "none" });
    expect(logger.lines.join("\n")).not.toContain(secret);
  });
});
