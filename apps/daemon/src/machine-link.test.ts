import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { MemoryStorageProvider } from "@ddl/storage";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type FakeMachine, startFakeMachine } from "./fake-machine";
import { secretFile } from "./home-files";
import { MachineLink, type MachineLinkOptions } from "./machine-link";
import { RecordingLogger } from "./security/harness";
import { createSettingsStore } from "./settings-store";
import { tempDir } from "./test-helpers";

let dir: { path: string; cleanup: () => void };
let machine: FakeMachine;
let logger: RecordingLogger;

beforeEach(async () => {
  dir = tempDir("ddl-machine-link-");
  machine = await startFakeMachine();
  logger = new RecordingLogger();
});

afterEach(async () => {
  await machine.close();
  dir.cleanup();
});

async function setup(overrides: Partial<MachineLinkOptions> = {}) {
  const settings = await createSettingsStore({ storage: new MemoryStorageProvider() });
  const tokenPath = join(dir.path, "machine-token");
  const options: MachineLinkOptions = {
    settings,
    credentialFile: secretFile(tokenPath),
    deviceName: () => "Laptop",
    logger,
    ...overrides,
  };
  const link = await MachineLink.load(options);
  return { link, settings, tokenPath, options };
}

const issuedToken = () => {
  const pair = machine.requests.find((r) => r.path === "/api/health" && r.authorization);
  return pair?.authorization?.replace("Bearer ", "") ?? "";
};

describe("MachineLink", () => {
  it("pairs as a daemon, keeps the credential 0600 and makes it the vault's machine", async () => {
    const { link, settings, tokenPath } = await setup();
    expect(link.status()).toEqual({
      machine: null,
      paired: false,
      reachable: null,
      checkedAt: null,
    });
    const credentials: unknown[] = [];
    link.onChange((credential) => credentials.push(credential));

    const status = await link.pair({ url: `${machine.url}/`, code: "abcd 2345" });
    expect(machine.requests[0]).toMatchObject({
      method: "POST",
      path: "/api/pair",
      authorization: undefined,
      body: { code: "ABCD2345", name: "Laptop", kind: "daemon" },
    });
    // Named after the first label of its host by default (a tailnet name in real life).
    expect(settings.get().remote.alwaysOnMachine).toEqual({ name: "127", url: machine.url });
    expect(status).toMatchObject({
      machine: { url: machine.url },
      paired: true,
      reachable: true,
      checkedAt: expect.any(Number),
      version: "0.2.0",
      agent: { runsOn: { name: "vm-1", alwaysOnMachine: true } },
      readiness: { harness: { kind: "cursor", ready: true } },
    });
    expect(status.error).toBeUndefined();

    const token = issuedToken();
    expect(token.length).toBeGreaterThan(20);
    expect(statSync(tokenPath).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(tokenPath, "utf8"))).toEqual({
      url: machine.url,
      deviceId: machine.devices[0]?.id,
      token,
    });
    expect(link.current()).toEqual({ url: machine.url, token });
    expect(credentials).toEqual([{ url: machine.url, token }]);
    expect(JSON.stringify(status)).not.toContain(token);
    expect(logger.lines.join("\n")).not.toContain(token);
    expect(machine.requests.every((r) => !JSON.stringify(r.body ?? "").includes(token))).toBe(true);

    // A restart keeps it.
    const again = await MachineLink.load({ ...(await setup()).options, settings });
    expect(again.current()).toEqual({ url: machine.url, token });
  });

  it("uses the name it's given, and answers refusals with the contract's errors", async () => {
    const { link, tokenPath } = await setup();
    await expect(link.pair({ url: machine.url, code: "ZZZZ-ZZZZ" })).rejects.toMatchObject({
      status: 401,
      code: "pairing_rejected",
    });
    machine.pairAnswer = { status: 429, body: { error: "rate_limited" } };
    await expect(link.pair({ url: machine.url, code: machine.code })).rejects.toMatchObject({
      status: 429,
      code: "rate_limited",
    });
    machine.pairAnswer = { status: 403, body: { error: "forbidden_host" } };
    await expect(link.pair({ url: machine.url, code: machine.code })).rejects.toMatchObject({
      status: 502,
      message: expect.stringMatching(/remote hosts/),
    });
    machine.pairAnswer = { status: 201, body: { device: { id: "x" } } };
    await expect(link.pair({ url: machine.url, code: machine.code })).rejects.toMatchObject({
      status: 502,
    });
    await expect(
      link.pair({ url: "http://vm-1.tailnet-name.ts.net", code: machine.code }),
    ).rejects.toMatchObject({ status: 400 });
    expect(existsSync(tokenPath)).toBe(false);
    const paired = await link.pair({ url: machine.url, code: machine.code, name: "vm-1" });
    expect(paired.machine).toEqual({ name: "vm-1", url: machine.url });
  });

  it("reports a machine that doesn't answer, within the timeout", async () => {
    const { link } = await setup({ timeoutMs: 200 });
    const closed = await startFakeMachine();
    await closed.close();
    await expect(link.pair({ url: closed.url, code: machine.code })).rejects.toMatchObject({
      status: 502,
      code: "machine_unreachable",
    });
    machine.hang = true;
    const started = performance.now();
    await expect(link.pair({ url: machine.url, code: machine.code })).rejects.toMatchObject({
      status: 502,
      message: expect.stringMatching(/timed out/),
    });
    expect(performance.now() - started).toBeLessThan(2_000);
  });

  it("checks reachability, and notices when the machine revoked this device", async () => {
    const { link } = await setup();
    await link.pair({ url: machine.url, code: machine.code });
    machine.revokeAll();
    expect(await link.check()).toMatchObject({
      paired: true,
      reachable: true,
      error: expect.stringMatching(/no longer accepts/),
    });
    await machine.close();
    expect(await link.check()).toMatchObject({
      reachable: false,
      error: expect.stringMatching(/Couldn't reach/),
    });
  });

  it("checks in the background only while someone keeps asking and the answer is stale", async () => {
    let clock = 1_000_000;
    const { link } = await setup({ now: () => clock });
    await link.pair({ url: machine.url, code: machine.code });
    const checks = () => machine.requests.filter((r) => r.path === "/api/health").length;
    const before = checks();
    link.status();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(checks()).toBe(before);
    clock += 30_000;
    link.status();
    await vi.waitFor(() => expect(checks()).toBe(before + 1));
  });

  it("forgets the credential, revoking it on the machine first", async () => {
    const { link, tokenPath, settings } = await setup();
    await link.pair({ url: machine.url, code: machine.code });
    const id = machine.devices[0]?.id;
    const status = await link.unpair();
    expect(machine.revoked).toEqual([id]);
    expect(existsSync(tokenPath)).toBe(false);
    expect(status).toEqual({
      machine: { name: "127", url: machine.url },
      paired: false,
      reachable: null,
      checkedAt: null,
    });
    expect(link.current()).toBeNull();
    // The machine stays the vault's always-on machine.
    expect(settings.get().remote.alwaysOnMachine).not.toBeNull();
    // Offline: still forgotten here.
    await link.pair({ url: machine.url, code: "ABCD2345" }).catch(() => undefined);
    await machine.close();
    expect((await link.unpair()).paired).toBe(false);
  });

  it("never sends its token to a machine the vault no longer uses", async () => {
    const { link, settings } = await setup();
    await link.pair({ url: machine.url, code: machine.code });
    const other = await startFakeMachine();
    try {
      await settings.update({ remote: { alwaysOnMachine: { name: "vm-2", url: other.url } } });
      expect(link.current()).toBeNull();
      expect(await link.check()).toMatchObject({ machine: { name: "vm-2" }, paired: false });
      expect(other.requests.every((r) => r.authorization === undefined)).toBe(true);
    } finally {
      await other.close();
    }
  });
});
