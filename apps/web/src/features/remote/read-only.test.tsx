// @vitest-environment happy-dom
import type { AgentPlacementStatus, AgentStatusResponse, ApprovalRequest, Thread } from "@ddl/core";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HttpError } from "../../api/errors";
import { failureTitle } from "../../app/agent-actions";
import { type Services, ServicesContext } from "../../app/services";
import { CommandRegistry } from "../../commands/registry";
import { initialAgentState } from "../../state/agent-reducer";
import { useAgentStore } from "../../state/agent-store";
import { ApprovalCard } from "../agent/ApprovalCard";
import { ensureAgentCommands } from "../agent/agent-commands";
import { Composer } from "../agent/Composer";
import { ThreadHeader } from "../agent/ThreadHeader";
import { AgentAvailabilityBanner, availabilityBanner } from "./AgentAvailabilityBanner";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const HERE = { deviceId: "dev_laptop", name: "Laptop", thisDevice: true, alwaysOnMachine: false };
const MACHINE = { deviceId: "dev_vm", name: "vm-1", thisDevice: false, alwaysOnMachine: true };
const OTHER = {
  deviceId: "dev_work",
  name: "Work laptop",
  thisDevice: false,
  alwaysOnMachine: false,
};

const THREAD: Thread = {
  id: "thr_1",
  taskId: "task_1",
  notePath: "Daily/2026-09-25.md",
  title: "Order a replacement water filter",
  status: "waiting_approval",
  createdAt: 1,
  updatedAt: 1,
  messages: [],
  artifacts: [],
  surfaces: [],
};

const APPROVAL: ApprovalRequest = {
  id: "apr_1",
  threadId: "thr_1",
  taskId: "task_1",
  toolName: "browser_click",
  input: {},
  summary: "Place the order",
  risk: "high",
  categories: ["payment"],
  reason: "Spends money",
  status: "pending",
  createdAt: 1,
};

let root: Root | null = null;
let container: HTMLElement;

function render(placement: AgentPlacementStatus | undefined) {
  useAgentStore.setState(
    {
      ...initialAgentState,
      status: { enabled: true, ...(placement ? { placement } : {}) } as AgentStatusResponse,
      details: { [THREAD.id]: THREAD },
      approvals: { [APPROVAL.id]: APPROVAL },
    },
    true,
  );
  const agent = { cancel: vi.fn(), retry: vi.fn(), decide: vi.fn() };
  const services = {
    agent,
    client: {},
    commands: new CommandRegistry(),
  } as unknown as Services;
  ensureAgentCommands(services);
  container = document.body.appendChild(document.createElement("div"));
  root = createRoot(container);
  act(() => {
    root!.render(
      <ServicesContext value={services}>
        <AgentAvailabilityBanner />
        <ThreadHeader threadId={THREAD.id} />
        <ApprovalCard approval={APPROVAL} />
        <Composer threadId={THREAD.id} post={vi.fn(async () => {})} />
      </ServicesContext>,
    );
  });
  return { agent };
}

const q = <T extends Element = HTMLElement>(testId: string) =>
  container.querySelector<T>(`[data-testid="${testId}"]`);

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  container?.remove();
});

describe("the read-only banner", () => {
  it("says why this device only shows the synced state", () => {
    const relayed = { placement: "always_on_machine" as const, runsOn: MACHINE };
    expect(availabilityBanner({ ...relayed, relay: "unreachable" })).toEqual({
      kind: "unreachable",
      text: "The always-on machine can't be reached — showing the last synced state",
    });
    expect(availabilityBanner({ ...relayed, relay: "not_paired" })).toMatchObject({
      kind: "not_paired",
    });
    expect(
      availabilityBanner(
        { ...relayed, relay: "not_paired" },
        "The always-on machine no longer accepts this device. Pair it again.",
      ),
    ).toEqual({
      kind: "rejected",
      text: "The always-on machine no longer accepts this device — showing the last synced state",
    });
    expect(availabilityBanner({ ...relayed, relay: "connecting" })).toEqual({ kind: "none" });
    expect(availabilityBanner({ placement: "this_device", runsOn: OTHER, relay: "off" })).toEqual({
      kind: "elsewhere",
      text: "The agent is running on Work laptop — showing the last synced state",
    });
    expect(
      availabilityBanner({ placement: "always_on_machine", runsOn: null, relay: "off" }),
    ).toEqual({
      kind: "idle",
      text: "The always-on machine isn't running the agent right now — showing the last synced state",
    });
  });

  it("stays away while this device can act on the agent, or while it's being handed over", () => {
    expect(availabilityBanner(undefined)).toEqual({ kind: "none" });
    expect(availabilityBanner({ placement: "this_device", runsOn: HERE, relay: "off" })).toEqual({
      kind: "none",
    });
    expect(
      availabilityBanner({ placement: "always_on_machine", runsOn: MACHINE, relay: "connected" }),
    ).toEqual({ kind: "none" });
    expect(
      availabilityBanner({
        placement: "this_device",
        runsOn: MACHINE,
        relay: "off",
        note: "Taking over from vm-1…",
      }),
    ).toEqual({ kind: "none" });
  });
});

describe("agent actions while read-only", () => {
  it("are disabled, each saying why, with the banner above", () => {
    render({ placement: "this_device", runsOn: OTHER, relay: "off" });
    expect(q("agent-banner")?.textContent).toContain("The agent is running on Work laptop");
    for (const id of ["approve-once", "approve-task", "deny", "thread-stop", "composer-send"]) {
      const control = q<HTMLButtonElement>(id)!;
      expect(control.disabled, id).toBe(true);
      expect(control.closest<HTMLElement>(".disabled-reason")?.dataset.tooltip, id).toBe(
        "The agent is running on Work laptop",
      );
    }
    const input = q<HTMLTextAreaElement>("composer-input")!;
    expect(input.disabled).toBe(true);
    expect(input.placeholder).toBe("The agent is running on Work laptop");
    expect(q("approval-readonly")?.textContent).toContain("answer it where the agent runs");
  });

  it("offers running here from the banner when the machine can't be reached", () => {
    render({ placement: "always_on_machine", runsOn: MACHINE, relay: "unreachable" });
    expect(q("agent-banner")?.dataset.kind).toBe("unreachable");
    expect(q("agent-banner-run-here")?.textContent).toBe("Run it on this device instead");
    expect(q<HTMLButtonElement>("approve-once")!.disabled).toBe(true);
  });

  it("are enabled where this device runs the agent or relays to the machine", () => {
    for (const placement of [
      { placement: "this_device" as const, runsOn: HERE, relay: "off" as const },
      { placement: "always_on_machine" as const, runsOn: MACHINE, relay: "connected" as const },
      undefined,
    ]) {
      render(placement);
      expect(q("agent-banner")).toBeNull();
      expect(q<HTMLButtonElement>("approve-once")!.disabled).toBe(false);
      expect(q("disabled-reason")).toBeNull();
      act(() => root?.unmount());
      container.remove();
    }
    root = null;
  });

  it("toast a 503 as the agent being unable to act, with the daemon's reason", () => {
    const refused = new HttpError(503, "The agent is running on Work laptop.", {
      error: "agent_unavailable",
      message: "The agent is running on Work laptop.",
    });
    expect(failureTitle(refused, "Couldn't stop the task")).toBe("The agent can't act right now");
    expect(failureTitle(new HttpError(500, "boom"), "Couldn't stop the task")).toBe(
      "Couldn't stop the task",
    );
  });
});
