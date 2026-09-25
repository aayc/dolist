import { randomBytes } from "node:crypto";
import { AgentReadinessSchema, exact } from "@ddl/contract";
import type { AgentHarnessKind, AgentMode, AgentStatusResponse, ConnectorStatus } from "@ddl/core";
import { describe, expect, it, vi } from "vitest";
import {
  type ExecutionProbe,
  type HarnessProbe,
  ReadinessMonitor,
  systemReadinessProbes,
} from "./readiness";
import { FakeAgentRuntime } from "./test-helpers";

function setup(options: { mode?: AgentMode; connectors?: ConnectorStatus[] } = {}) {
  let harness: AgentHarnessKind = "pi";
  let clock = 0;
  const harnessProbe = vi.fn(
    async (kind: AgentHarnessKind): Promise<HarnessProbe> =>
      kind === "pi"
        ? {
            ready: false,
            problem: "OPENROUTER_API_KEY is not set on this machine.",
            credential: false,
          }
        : { ready: true, credential: true },
  );
  const executionProbe = vi.fn(
    async (): Promise<ExecutionProbe> => ({ browser: true, computer: "needs_permissions" }),
  );
  const onChange = vi.fn();
  const monitor = new ReadinessMonitor({
    mode: options.mode ?? "live",
    harness: () => harness,
    connectors: { status: () => options.connectors ?? [] },
    probes: { harness: harnessProbe, execution: executionProbe },
    onChange,
    ttlMs: 1_000,
    now: () => clock,
  });
  return {
    monitor,
    harnessProbe,
    executionProbe,
    onChange,
    setHarness: (kind: AgentHarnessKind) => {
      harness = kind;
    },
    advance: (ms: number) => {
      clock += ms;
    },
  };
}

const connector = (name: string, state: ConnectorStatus["state"]): ConnectorStatus => ({
  name,
  transport: "stdio",
  state,
  toolCount: 1,
});

describe("ReadinessMonitor", () => {
  it("reports the probes' answers, booleans and counts only", async () => {
    const { monitor, onChange } = setup({
      connectors: [
        connector("calendar", "connected"),
        connector("mail", "error"),
        connector("old", "disabled"),
      ],
    });
    expect(monitor.current()).toBeUndefined();
    await monitor.refresh();
    const readiness = monitor.current();
    expect(readiness).toEqual({
      harness: {
        kind: "pi",
        ready: false,
        problem: "OPENROUTER_API_KEY is not set on this machine.",
      },
      modelCredential: false,
      browser: true,
      computer: "needs_permissions",
      connectors: { configured: 2, connected: 1 },
    });
    expect(exact(AgentReadinessSchema).safeParse(readiness).success).toBe(true);
    expect(onChange).toHaveBeenCalledOnce();
  });

  it("probes again when the harness changes or the answer is stale", async () => {
    const { monitor, harnessProbe, setHarness, advance, onChange } = setup();
    await monitor.refresh();
    setHarness("cursor");
    expect(monitor.current()).toBeUndefined();
    await vi.waitFor(() =>
      expect(monitor.current()?.harness).toEqual({ kind: "cursor", ready: true }),
    );
    expect(harnessProbe).toHaveBeenLastCalledWith("cursor");
    expect(onChange).toHaveBeenCalledTimes(2);
    const calls = harnessProbe.mock.calls.length;
    monitor.current();
    expect(harnessProbe).toHaveBeenCalledTimes(calls);
    advance(1_000);
    monitor.current();
    await vi.waitFor(() => expect(harnessProbe).toHaveBeenCalledTimes(calls + 1));
    expect(onChange).toHaveBeenCalledTimes(2);
  });

  it("needs nothing in mock mode and reports the agent off in off mode", async () => {
    const mock = setup({ mode: "mock" });
    await mock.monitor.refresh();
    expect(mock.monitor.current()).toMatchObject({
      harness: { kind: "pi", ready: true },
      modelCredential: true,
    });
    expect(mock.harnessProbe).not.toHaveBeenCalled();
    const off = setup({ mode: "off" });
    await off.monitor.refresh();
    expect(off.monitor.current()?.harness).toEqual({
      kind: "pi",
      ready: false,
      problem: "The agent is off on this device (DDL_AGENT_MODE=off).",
    });
  });

  it("prefers what a running agent reports about its browser and desktop", async () => {
    const { monitor } = setup();
    await monitor.refresh();
    const status: AgentStatusResponse = {
      ...new FakeAgentRuntime().status(),
      execution: {
        provider: "local",
        capabilities: { shell: true, browser: false, computer: true },
        computerAccess: { accessibility: true, screenRecording: true, appControl: true },
      },
    };
    expect(monitor.current(status)).toMatchObject({ browser: false, computer: "available" });
    const idle = { ...status, execution: { ...status.execution, provider: "none" } };
    expect(monitor.current(idle)).toMatchObject({ browser: true, computer: "needs_permissions" });
  });

  it("turns a failing probe into a problem, never an error", async () => {
    const { monitor, harnessProbe, executionProbe } = setup();
    harnessProbe.mockRejectedValueOnce(new Error("spawn failed"));
    executionProbe.mockRejectedValueOnce(new Error("no playwright"));
    await monitor.refresh();
    expect(monitor.current()).toMatchObject({
      harness: { ready: false, problem: "Couldn't check the agent harness (spawn failed)." },
      browser: false,
      computer: "unsupported",
    });
  });
});

describe("systemReadinessProbes", () => {
  it("checks the Pi credential's presence without ever returning it", async () => {
    const secret = randomBytes(24).toString("base64url");
    const probes = systemReadinessProbes({
      env: { OPENROUTER_API_KEY: secret },
      execution: { kind: "cloud", endpoint: "https://exec.example", apiKeyEnv: "EXEC_KEY" },
    });
    const answer = await probes.harness("pi");
    expect(answer).toEqual({ ready: true, credential: true });
    expect(JSON.stringify(answer)).not.toContain(secret);
    expect(
      await systemReadinessProbes({
        env: {},
        execution: { kind: "cloud", endpoint: "https://exec.example", apiKeyEnv: "EXEC_KEY" },
      }).harness("pi"),
    ).toEqual({
      ready: false,
      problem: "OPENROUTER_API_KEY is not set on this machine.",
      credential: false,
    });
  });

  it("reports a Cursor CLI that isn't there without running anything", async () => {
    const probes = systemReadinessProbes({
      env: { DDL_CURSOR_CLI: "/nonexistent/ddl-test/agent", PATH: "" },
      execution: { kind: "cloud", endpoint: "https://exec.example", apiKeyEnv: "EXEC_KEY" },
    });
    expect(await probes.harness("cursor")).toMatchObject({
      ready: false,
      credential: false,
      problem: expect.stringMatching(/not installed/),
    });
  });
});
