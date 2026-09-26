/**
 * The helper client against the fake helper (a Node script speaking the same protocol), never the
 * real `ddl-computer`.
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useTempDirs } from "../../../testing/helpers";
import { ComputerUnavailableError, ExecutionError } from "../../errors";
import { HelperClient, type HelperClientOptions } from "./client";
import { HelperError, parseRunningApps } from "./protocol";
import {
  FAKE_HELPER,
  FAKE_HELPER_HELLO_TIMEOUT_MS,
  FAKE_HELPER_TEST_TIMEOUT_MS,
} from "./testing/fake-helper";

const tempDir = useTempDirs("ddl-helper-client-");
const clients: HelperClient[] = [];

afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.dispose()));
});

function fake(flags: string[] = [], options: Partial<HelperClientOptions> = {}): HelperClient {
  const client = new HelperClient({
    command: process.execPath,
    args: [FAKE_HELPER, "serve", ...flags],
    firstRestartDelayMs: 50,
    maxRestartDelayMs: 400,
    helloTimeoutMs: FAKE_HELPER_HELLO_TIMEOUT_MS,
    ...options,
  });
  clients.push(client);
  return client;
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Polls `check`; `timeoutMs` is a failure bound only. */
async function until(check: () => boolean, timeoutMs = 60_000): Promise<void> {
  const started = Date.now();
  while (!check()) {
    if (Date.now() - started > timeoutMs) throw new Error("timed out waiting");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

describe("HelperClient", { timeout: FAKE_HELPER_TEST_TIMEOUT_MS }, () => {
  it("starts on first use, checks the version and answers pipelined calls by id", async () => {
    const client = fake(["--fake-noise"]);
    expect(client.pid).toBeUndefined();
    const [apps, permissions, installed] = await Promise.all([
      client.call("apps", {}),
      client.call("permissions", {}),
      client.call("installedApps", {}),
    ]);
    expect(parseRunningApps(apps).map((app) => app.name)).toEqual([
      "Grok Bot",
      "WhatsApp",
      "Slack",
      "1Password",
      "Daily Do List",
    ]);
    expect(permissions).toEqual({ accessibility: true, screenRecording: true });
    expect((installed as { apps: unknown[] }).apps.length).toBeGreaterThan(5);
    expect(client.pid).toBeGreaterThan(0);
    expect(client.available).toBe(true);
  });

  it("rejects error responses with their code", async () => {
    const client = fake();
    const error = await client.call("snapshot", { pid: 504 }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(HelperError);
    expect(error).toMatchObject({ code: "protected", method: "snapshot" });
    const missing = await client.call("snapshot", { pid: 9999 }).catch((e: unknown) => e);
    expect(missing).toMatchObject({ code: "not_found" });
  });

  it("times out a call the helper never answers, then restarts it for the next one", async () => {
    const client = fake(["--fake-hang-on=installedApps"]);
    await client.call("apps", {});
    const first = client.pid!;
    const error = await client
      .call("installedApps", {}, { timeoutMs: 300 })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ExecutionError);
    expect((error as Error).message).toMatch(/didn't answer installedApps/);
    await until(() => !alive(first));
    await expect(client.call("apps", {})).resolves.toBeDefined();
    expect(client.pid).not.toBe(first);
  });

  it("fails pending calls when the helper dies and restarts it with a backoff", async () => {
    const client = fake(["--fake-crash-on=key"]);
    await client.call("apps", {});
    const pending = client.call("permissions", {});
    const crash = client.call("key", { pid: 501, combo: "return" }).catch((e: unknown) => e);
    await expect(pending).resolves.toBeDefined();
    const error = await crash;
    expect(error).toBeInstanceOf(ExecutionError);
    expect((error as Error).message).toMatch(/stopped unexpectedly \(exit code 3\)/);
    // The next call waits out the short first backoff and gets a fresh helper.
    await expect(client.call("apps", {})).resolves.toBeDefined();
    expect(client.available).toBe(true);
  });

  it("doubles the restart delay after each crash; calls inside a long delay fail fast", async () => {
    let clock = 1_000_000;
    const client = fake(["--fake-crash-on=key"], {
      now: () => clock,
      firstRestartDelayMs: 5_000,
      maxRestartDelayMs: 60_000,
    });
    const crash = async () => {
      await client.call("key", { pid: 501, combo: "a" }).catch(() => {});
      await until(() => client.pid === undefined);
    };
    await client.call("apps", {});
    await crash();
    await expect(client.call("apps", {})).rejects.toThrow(/restarts in 5 s/);
    clock += 5_000;
    await expect(client.call("apps", {})).resolves.toBeDefined();
    await crash();
    await expect(client.call("apps", {})).rejects.toThrow(/restarts in 10 s/);
    clock += 10_000;
    await client.call("apps", {});
    // A helper that stayed up for a while starts over with the first delay.
    clock += 60_000;
    await crash();
    await expect(client.call("apps", {})).rejects.toThrow(/restarts in 5 s/);
  });

  it("gives up on a helper that doesn't answer hello in time", async () => {
    const client = fake(["--fake-hang-on=hello"], { helloTimeoutMs: 300 });
    const error = await client.call("apps", {}).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ExecutionError);
    expect((error as Error).message).toMatch(/didn't answer hello/);
    await until(() => client.pid === undefined);
  });

  it("refuses to run a helper that speaks another protocol version, for good", async () => {
    const client = fake(["--fake-version=2"]);
    const error = await client.call("apps", {}).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ComputerUnavailableError);
    expect((error as Error).message).toMatch(/protocol 2/);
    expect(client.available).toBe(false);
    await expect(client.call("apps", {})).rejects.toBe(error);
  });

  it("disables itself when the helper binary is missing", async () => {
    const client = new HelperClient({ command: "/nonexistent/ddl-computer" });
    clients.push(client);
    const error = await client.call("apps", {}).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ComputerUnavailableError);
    expect((error as Error).message).toMatch(/ENOENT/);
    expect(client.available).toBe(false);
  });

  it("stops waiting when the call is aborted", async () => {
    const client = fake(["--fake-hang-on=installedApps"]);
    await client.call("apps", {});
    const controller = new AbortController();
    const call = client.call("installedApps", {}, { signal: controller.signal });
    controller.abort(new Error("stop"));
    await expect(call).rejects.toThrow("stop");
    await expect(client.call("apps", {})).resolves.toBeDefined();
  });

  it("gives the helper only an allowlisted environment", async () => {
    const dir = await tempDir();
    const envFile = path.join(dir, "env.txt");
    const client = fake([`--fake-env=${envFile}`], {
      env: { PATH: process.env.PATH, HOME: dir, OPENROUTER_API_KEY: "must-not-leak", LANG: "C" },
    });
    await client.call("apps", {});
    const names = (await readFile(envFile, "utf8")).split("\n");
    expect(names).toContain("PATH");
    expect(names).toContain("HOME");
    expect(names).not.toContain("OPENROUTER_API_KEY");
  });

  it("ends the helper on dispose and refuses calls afterwards", async () => {
    const dir = await tempDir();
    const pids = path.join(dir, "pids.txt");
    const client = fake([`--fake-pids=${pids}`]);
    await client.call("apps", {});
    const pid = Number((await readFile(pids, "utf8")).trim());
    expect(alive(pid)).toBe(true);
    await client.dispose();
    await until(() => !alive(pid));
    await expect(client.call("apps", {})).rejects.toBeInstanceOf(ComputerUnavailableError);
    expect(client.available).toBe(false);
  });

  it("restarts after the helper exits on its own", async () => {
    const client = fake(["--fake-exit-after=2"]);
    await client.call("apps", {});
    const first = client.pid;
    await until(() => client.pid === undefined);
    await expect(client.call("permissions", {})).resolves.toBeDefined();
    expect(client.pid).not.toBe(first);
  });
});
