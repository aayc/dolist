// @vitest-environment happy-dom
import type { DeviceVaultResponse } from "@ddl/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NetworkError } from "../../api/errors";
import { useToastStore } from "../../state/toast-store";
import { ui } from "../../state/ui-store";
import { announceVaultSwitch, requestVaultSwitch, waitForVault } from "./vault-switch";

const NEW = "/Users/me/Obsidian Notebook (Daily Do List)";
const OLD = "/Users/me/Demo Vault";

afterEach(() => {
  ui.set({ overlay: null });
  useToastStore.setState({ toasts: [] });
  sessionStorage.clear();
  vi.useRealTimers();
});

describe("switching vaults", () => {
  it("saves open notes first, then covers the app while the daemon restarts", async () => {
    const order: string[] = [];
    const response: DeviceVaultResponse = { path: NEW, lockedByEnv: false, restart: "supervisor" };
    const deps = {
      preload: vi.fn(async () => order.push("preload")),
      flush: vi.fn(async () => {
        order.push("flush");
      }),
      client: {
        switchVault: vi.fn(async (path: string) => {
          order.push(`switch ${path}`);
          return response;
        }),
      },
    };
    expect(await requestVaultSwitch(deps, NEW, OLD)).toBe(response);
    expect(order).toEqual(["preload", "flush", `switch ${NEW}`]);
    expect(ui.get().overlay).toEqual({ kind: "vault-switch", path: NEW, restart: "supervisor" });
  });

  it("leaves the page alone when the daemon is already on that vault", async () => {
    const deps = {
      preload: async () => {},
      flush: async () => {},
      client: { switchVault: async () => ({ path: NEW, lockedByEnv: false }) },
    };
    await requestVaultSwitch(deps, NEW, OLD);
    expect(ui.get().overlay).toBeNull();
    announceVaultSwitch();
    expect(useToastStore.getState().toasts).toEqual([]);
  });

  it("waits through the old daemon and the restart until the new vault answers", async () => {
    vi.useFakeTimers();
    const answers: Array<DeviceVaultResponse | Error> = [
      { path: OLD, lockedByEnv: false },
      new NetworkError("refused"),
      new NetworkError("refused"),
      { path: NEW, lockedByEnv: false },
    ];
    const getVault = vi.fn(async () => {
      const next = answers.shift()!;
      if (next instanceof Error) throw next;
      return next;
    });
    const back = waitForVault({ getVault }, NEW, { signal: new AbortController().signal });
    await vi.advanceTimersByTimeAsync(2_000);
    expect(await back).toBe(true);
    expect(getVault).toHaveBeenCalledTimes(4);
  });

  it("stops waiting when the overlay goes away", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const getVault = vi.fn(async () => ({ path: OLD, lockedByEnv: false }));
    const back = waitForVault({ getVault }, NEW, { signal: controller.signal });
    await vi.advanceTimersByTimeAsync(1_200);
    controller.abort();
    expect(await back).toBe(false);
  });

  it("says where the page is after the reload, and where the old vault is, once", async () => {
    await requestVaultSwitch(
      {
        preload: async () => {},
        flush: async () => {},
        client: { switchVault: async () => ({ path: NEW, lockedByEnv: false, restart: "manual" }) },
      },
      NEW,
      OLD,
    );
    announceVaultSwitch();
    expect(useToastStore.getState().toasts).toMatchObject([
      {
        kind: "success",
        title: "Now on Obsidian Notebook (Daily Do List)",
        body: `Your previous vault is kept untouched at ${OLD}.`,
      },
    ]);
    announceVaultSwitch();
    expect(useToastStore.getState().toasts).toHaveLength(1);
  });
});
