import type { AgentPlacementStatus, AgentStatusResponse } from "@ddl/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { initialAgentState } from "../state/agent-reducer";
import { useAgentStore } from "../state/agent-store";
import { handleServerEvent } from "./server-events";
import type { Services } from "./services";

const MACHINE = { deviceId: "dev_vm", name: "vm-1", thisDevice: false, alwaysOnMachine: true };
const HERE = { deviceId: "dev_laptop", name: "Laptop", thisDevice: true, alwaysOnMachine: false };

function status(placement: AgentPlacementStatus | undefined, running = 0): AgentStatusResponse {
  return { enabled: true, running, ...(placement ? { placement } : {}) } as AgentStatusResponse;
}

beforeEach(() => {
  vi.useFakeTimers();
  useAgentStore.setState(initialAgentState, true);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("agent.status", () => {
  it("fetches threads, approvals, records and open threads again when the relay changes", async () => {
    const resync = vi.fn(async () => {});
    const services = { agent: { resync } } as unknown as Services;
    const send = (s: AgentStatusResponse) =>
      handleServerEvent({ type: "agent.status", status: s }, services);

    const relayed = { placement: "always_on_machine" as const, runsOn: MACHINE };
    send(status({ ...relayed, relay: "connecting" }));
    send(status({ ...relayed, relay: "connecting" }, 1));
    await vi.advanceTimersByTimeAsync(500);
    expect(resync).not.toHaveBeenCalled();
    expect(useAgentStore.getState().status?.running).toBe(1);

    // Connecting then connected in a burst: one refetch.
    send(status({ ...relayed, relay: "connected" }));
    send(status({ ...relayed, relay: "unreachable" }));
    await vi.advanceTimersByTimeAsync(500);
    expect(resync).toHaveBeenCalledTimes(1);

    // The agent moved here (a handover, the relay off): once more.
    send(status({ placement: "this_device", runsOn: HERE, relay: "off" }));
    await vi.advanceTimersByTimeAsync(500);
    expect(resync).toHaveBeenCalledTimes(2);
  });
});
