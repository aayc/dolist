import type { ComputerAccess } from "@ddl/core";
import { describe, expect, it } from "vitest";
import { ComputerStatusMonitor } from "./computer-status";
import type { AppController, ExecutionProvider, InstalledApp, RunningApp } from "./types";

const READY: ComputerAccess = {
  accessibility: true,
  screenRecording: true,
  appControl: true,
  hostApp: { name: "Daily Do List" },
};

function provider(options: {
  access?: () => Promise<ComputerAccess | undefined>;
  running?: RunningApp[];
  installed?: InstalledApp[];
  computer?: boolean;
  noApps?: boolean;
}) {
  const calls = { access: 0, running: 0, installed: 0 };
  const apps = {
    runningApps: async () => {
      calls.running++;
      return options.running ?? [];
    },
    installedApps: async () => {
      calls.installed++;
      return options.installed ?? [];
    },
  } as unknown as AppController;
  const execution = {
    id: "fake",
    capabilities: { shell: true, browser: false, computer: options.computer ?? true },
    ...(options.noApps ? {} : { apps }),
    computerAccess: async () => {
      calls.access++;
      return options.access ? options.access() : READY;
    },
  } as unknown as ExecutionProvider;
  return { execution, calls };
}

const app = (
  name: string,
  path = `/Applications/${name}.app`,
  bundleId?: string,
): InstalledApp => ({
  name,
  path,
  ...(bundleId ? { bundleId } : {}),
});

describe("ComputerStatusMonitor", () => {
  it("lists running apps first, then third-party ones, never protected ones", async () => {
    const { execution } = provider({
      running: [
        { name: "WhatsApp", pid: 2, active: true, hidden: false },
        {
          name: "1Password",
          bundleId: "com.1password.1password",
          pid: 3,
          active: false,
          hidden: false,
        },
      ],
      installed: [
        app("Notes", "/System/Applications/Notes.app"),
        app("Grok Bot"),
        app("Okta Verify"),
        app("WhatsApp"),
        app("ChatGPT"),
      ],
    });
    const monitor = new ComputerStatusMonitor(execution, { maxApps: 3 });
    await monitor.refresh();
    expect(monitor.current()).toEqual({
      access: READY,
      apps: ["WhatsApp", "ChatGPT", "Grok Bot"],
      moreApps: 1,
    });
  });

  it("never waits: a stale read refreshes in the background and reports changes", async () => {
    let clock = 0;
    let access: ComputerAccess = { ...READY, accessibility: false };
    const changes: number[] = [];
    const { execution, calls } = provider({ access: async () => access });
    const monitor = new ComputerStatusMonitor(execution, {
      now: () => clock,
      onChange: () => changes.push(clock),
    });
    expect(monitor.current()).toEqual({ apps: [], moreApps: 0 });
    await monitor.refresh();
    expect(monitor.current().access?.accessibility).toBe(false);
    expect(changes).toEqual([0]);

    access = READY;
    clock = 1_000;
    monitor.current();
    await monitor.refresh();
    expect(calls.access).toBe(1);
    clock = 3_000;
    monitor.current();
    await monitor.refresh();
    expect(calls.access).toBe(2);
    expect(monitor.current().access?.accessibility).toBe(true);
    expect(changes).toEqual([0, 3_000]);
    expect(calls.installed).toBe(1);
  });

  it("does nothing without computer use, or once stopped", async () => {
    const off = provider({ computer: false });
    const monitor = new ComputerStatusMonitor(off.execution);
    expect(monitor.supported).toBe(false);
    await monitor.refresh(true);
    monitor.current();
    expect(off.calls.access).toBe(0);

    const on = provider({ noApps: true });
    const stopped = new ComputerStatusMonitor(on.execution);
    stopped.stop();
    stopped.current();
    await stopped.refresh(true);
    expect(on.calls.access).toBe(0);
  });

  it("keeps the last known status when a check fails", async () => {
    let fail = false;
    const { execution } = provider({
      access: async () => {
        if (fail) throw new Error("helper down");
        return READY;
      },
      noApps: true,
    });
    const monitor = new ComputerStatusMonitor(execution);
    await monitor.refresh(true);
    fail = true;
    await monitor.refresh(true);
    expect(monitor.current().access).toEqual(READY);
  });
});
