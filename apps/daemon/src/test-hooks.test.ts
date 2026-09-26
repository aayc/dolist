import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createFakeExecution } from "@ddl/agent/testing";
import { type AgentStatusResponse, API_ROUTES, silentLogger } from "@ddl/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "./config";
import { type RunningDaemon, startDaemon } from "./server";
import { tempDir } from "./test-helpers";
import { testHooks } from "./test-hooks";

describe("testHooks", () => {
  it("are off unless DDL_TEST_HOOKS is exactly 1", () => {
    expect(testHooks({})).toBeNull();
    expect(testHooks({ DDL_TEST_COMPUTER: "missing" })).toBeNull();
    for (const value of ["0", "true", "yes", "", " "]) {
      expect(testHooks({ DDL_TEST_HOOKS: value })).toBeNull();
    }
    expect(testHooks({ DDL_TEST_HOOKS: "1" })).not.toBeNull();
  });

  it("simulate a Mac's computer access and hide the controllers that would act on it", async () => {
    const hooks = testHooks({ DDL_TEST_HOOKS: "1", DDL_TEST_COMPUTER: "missing" })!;
    const fake = createFakeExecution();
    const provider = hooks.execution(fake);
    expect(provider.capabilities).toEqual({ ...fake.capabilities, computer: true });
    expect(await provider.computerAccess?.()).toEqual({
      accessibility: false,
      screenRecording: false,
      appControl: true,
      hostApp: { name: "Daily Do List" },
    });
    expect(provider.computer).toBeUndefined();
    expect(provider.apps).toBeUndefined();
    expect(provider.id).toBe(fake.id);
    await provider.shell.exec("echo hi", { cwd: "/tmp" });
    expect(fake.commands).toEqual([{ command: "echo hi", cwd: "/tmp" }]);
  });

  it("open no System Settings: the pane's permission is allowed a moment later", async () => {
    vi.useFakeTimers();
    try {
      const hooks = testHooks({ DDL_TEST_HOOKS: "1", DDL_TEST_COMPUTER: "missing" })!;
      const provider = hooks.execution(createFakeExecution());
      expect(await hooks.systemSettings.open("accessibility")).toBe("opened");
      expect((await provider.computerAccess?.())?.accessibility).toBe(false);
      await vi.advanceTimersByTimeAsync(300);
      expect(await provider.computerAccess?.()).toMatchObject({
        accessibility: true,
        screenRecording: false,
      });
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("the daemon's test hooks", () => {
  let dir: { path: string; cleanup: () => void } | undefined;
  let daemon: RunningDaemon | undefined;

  afterEach(async () => {
    await daemon?.close();
    daemon = undefined;
    dir?.cleanup();
  });

  async function agentStatus(extra: Record<string, string>): Promise<AgentStatusResponse> {
    dir = tempDir("ddl-test-hooks-");
    const env = {
      DDL_HOME: join(dir.path, "home"),
      DDL_VAULT: join(dir.path, "vault"),
      DDL_WEB_DIST: join(dir.path, "no-web-build"),
      DDL_AGENT_MODE: "mock",
      DDL_PORT: "0",
      ...extra,
    };
    const config = loadConfig({ env, cwd: dir.path, homedir: dir.path, platform: "linux" });
    daemon = await startDaemon({ config, env, logger: silentLogger });
    const token = readFileSync(config.tokenPath, "utf8").trim();
    const response = await fetch(`${daemon.url}${API_ROUTES.agentStatus}`, {
      headers: { authorization: `Bearer ${token}` },
    });
    return (await response.json()) as AgentStatusResponse;
  }

  it("are off by default: DDL_TEST_COMPUTER alone changes nothing", async () => {
    const status = await agentStatus({ DDL_TEST_COMPUTER: "missing" });
    expect(status.execution.capabilities.computer).toBe(false);
    expect(status.execution.computerAccess).toBeUndefined();
  });

  it("with DDL_TEST_HOOKS=1, report the simulated access", async () => {
    await agentStatus({ DDL_TEST_HOOKS: "1", DDL_TEST_COMPUTER: "missing" });
    const token = readFileSync(join(dir!.path, "home", "daemon-token"), "utf8").trim();
    await vi.waitFor(
      async () => {
        const response = await fetch(`${daemon!.url}${API_ROUTES.agentStatus}`, {
          headers: { authorization: `Bearer ${token}` },
        });
        const status = (await response.json()) as AgentStatusResponse;
        expect(status.execution.capabilities.computer).toBe(true);
        expect(status.execution.computerAccess).toMatchObject({ accessibility: false });
      },
      { timeout: 10_000, interval: 100 },
    );
  });
});
