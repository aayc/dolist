// @vitest-environment happy-dom
import type { AgentStatusResponse, ApprovalRequest, TaskAgentStatus, Thread } from "@ddl/core";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Services } from "../../app/services";
import { ServicesContext } from "../../app/services";
import { CommandRegistry } from "../../commands/registry";
import { initialAgentState } from "../../state/agent-reducer";
import { useAgentStore } from "../../state/agent-store";
import { pendingOf, useOutboxStore } from "../../state/outbox-store";
import { ensureAgentCommands } from "./agent-commands";
import { Composer, composerPlaceholder } from "./Composer";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const THREAD = "thr_1";

function thread(status: TaskAgentStatus): Thread {
  return {
    id: THREAD,
    taskId: "task_1",
    notePath: "Daily/2026-09-24.md",
    title: "Order a replacement water filter",
    status,
    createdAt: 1,
    updatedAt: 1,
    messages: [],
    artifacts: [],
    surfaces: [],
  };
}

const pendingApproval: ApprovalRequest = {
  id: "apr_1",
  threadId: THREAD,
  taskId: "task_1",
  toolName: "browser_click",
  input: {},
  summary: "Place order",
  risk: "high",
  categories: ["payment"],
  reason: "Spends money",
  status: "pending",
  createdAt: 1,
};

let root: Root | null = null;

function setup(status: TaskAgentStatus, options: { approval?: boolean; enabled?: boolean } = {}) {
  useAgentStore.setState(
    {
      ...initialAgentState,
      status: { enabled: options.enabled ?? true } as AgentStatusResponse,
      details: { [THREAD]: thread(status) },
      approvals: options.approval ? { [pendingApproval.id]: pendingApproval } : {},
    },
    true,
  );
  const agent = { cancel: vi.fn(async () => {}) };
  const services = { agent, commands: new CommandRegistry() } as unknown as Services;
  ensureAgentCommands(services);
  const post = vi.fn(async () => {});
  const onSend = vi.fn();
  const container = document.body.appendChild(document.createElement("div"));
  root = createRoot(container);
  act(() => {
    root!.render(
      <ServicesContext value={services}>
        <Composer threadId={THREAD} post={post} onSend={onSend} />
      </ServicesContext>,
    );
  });
  const input = container.querySelector("textarea")!;
  const button = (id: string) =>
    container.querySelector<HTMLButtonElement>(`[data-testid="${id}"]`);
  return { agent, post, onSend, input, button };
}

function type(input: HTMLTextAreaElement, value: string): void {
  const setValue = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
  act(() => {
    setValue.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function press(input: HTMLTextAreaElement, init: KeyboardEventInit): KeyboardEvent {
  const event = new KeyboardEvent("keydown", {
    key: "Enter",
    bubbles: true,
    cancelable: true,
    ...init,
  });
  act(() => {
    input.dispatchEvent(event);
  });
  return event;
}

describe("Composer", () => {
  beforeEach(() => {
    useOutboxStore.setState({ pending: {} });
  });

  afterEach(() => {
    act(() => root?.unmount());
    root = null;
    document.body.replaceChildren();
  });

  it("says what a reply does now", () => {
    expect(composerPlaceholder(true, "working", false)).toBe("Reply to the agent…");
    expect(composerPlaceholder(true, "waiting_user", false)).toBe("Reply to the agent…");
    expect(composerPlaceholder(true, "waiting_approval", true)).toBe(
      "Approve above, or reply to change course…",
    );
    for (const status of ["done", "failed", "cancelled", "ignored"] as const) {
      expect(composerPlaceholder(true, status, false)).toBe("Ask a follow-up…");
    }
    expect(composerPlaceholder(false, "working", false)).toBe("The agent is off");

    expect(setup("waiting_approval", { approval: true }).input.placeholder).toBe(
      "Approve above, or reply to change course…",
    );
  });

  it("sends on Enter: the reply shows at once and the input clears", () => {
    const { input, post, onSend, button } = setup("working");
    expect(button("composer-send")?.disabled).toBe(true);
    type(input, "  Somewhere quiet, please  ");
    expect(button("composer-send")?.disabled).toBe(false);
    const enter = press(input, {});
    expect(enter.defaultPrevented).toBe(true);
    expect(post).toHaveBeenCalledWith(THREAD, "Somewhere quiet, please");
    expect(onSend).toHaveBeenCalledTimes(1);
    expect(input.value).toBe("");
    expect(pendingOf(useOutboxStore.getState(), THREAD)).toMatchObject([
      { text: "Somewhere quiet, please", state: "sending" },
    ]);
  });

  it("leaves Shift+Enter (a new line), IME composition and blank text alone", () => {
    const { input, post } = setup("working");
    type(input, "Line one");
    expect(press(input, { shiftKey: true }).defaultPrevented).toBe(false);
    press(input, { isComposing: true });
    expect(post).not.toHaveBeenCalled();
    type(input, "   \n ");
    press(input, {});
    expect(post).not.toHaveBeenCalled();
  });

  it("offers Stop while the agent works, named by its command", () => {
    const { button, agent } = setup("working");
    const stop = button("composer-stop")!;
    expect(stop.getAttribute("aria-label")).toBe("Stop");
    expect(stop.dataset.command).toBe("agent:stop");
    act(() => stop.click());
    expect(agent.cancel).toHaveBeenCalledWith(THREAD);
    expect(stop.disabled).toBe(true);
    act(() => root?.unmount());
    root = null;
    expect(setup("done").button("composer-stop")).toBeNull();
  });

  it("is off while the agent is off", () => {
    const { input, button } = setup("idle", { enabled: false });
    expect(input.disabled).toBe(true);
    expect(input.placeholder).toBe("The agent is off");
    expect(button("composer-send")?.disabled).toBe(true);
  });
});
