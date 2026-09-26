import { searchParam } from "../lib/platform";
import { readPageAuth } from "./auth";
import type { DaemonClient } from "./client";
import { HttpDaemonClient } from "./http-client";
import { createBrowserPairing, deviceCookieWorks, type PairBrowser } from "./pairing";

export function isMockMode(): boolean {
  return searchParam("mock") === "1" || import.meta.env.VITE_DDL_MOCK === "1";
}

/**
 * What the page starts: the app (with a client; `pair` when it authenticates with a device cookie,
 * for going back to pairing if the device is revoked), or the pairing screen of a remote browser.
 */
export type Startup =
  | {
      kind: "app";
      createClient(onUnauthorized: () => void): DaemonClient;
      pair: PairBrowser | null;
    }
  | { kind: "pairing"; pair: PairBrowser };

export async function resolveStartup(): Promise<Startup> {
  if (isMockMode()) return mockStartup();
  const auth = readPageAuth();
  if (auth.kind === "pairing" && !(await deviceCookieWorks())) {
    return { kind: "pairing", pair: createBrowserPairing() };
  }
  const cookie = auth.kind === "cookie" || auth.kind === "pairing";
  return {
    kind: "app",
    createClient: (onUnauthorized) =>
      new HttpDaemonClient({
        token: auth.kind === "token" ? auth.token : null,
        ...(cookie ? { onUnauthorized } : {}),
      }),
    pair: cookie ? createBrowserPairing() : null,
  };
}

/**
 * The mock (and its seed data/agent simulation) is a separate chunk that never loads in normal
 * mode. `mockAuth=pairing` serves the page a remote browser gets before pairing: the pairing
 * screen, or the app with cookie auth once this browser is a paired mock device.
 */
async function mockStartup(): Promise<Startup> {
  const [
    { MockDaemonClient },
    { parseMockComputerMode },
    { parseMockRemoteScenario },
    mockPairing,
  ] = await Promise.all([
    import("./mock/mock-client"),
    import("./mock/mock-computer"),
    import("./mock/mock-remote"),
    import("./mock/mock-pairing"),
  ]);
  const speed = Number(searchParam("mockSpeed"));
  let deviceId: string | null = null;
  let pair: PairBrowser | null = null;
  if (searchParam("mockAuth") === "pairing") {
    const pairing = new mockPairing.MockPairing({ persist: true });
    pair = mockPairing.mockBrowserPairing(pairing);
    const cookie = mockPairing.mockDeviceCookie();
    if (!cookie || !pairing.has(cookie)) return { kind: "pairing", pair };
    deviceId = cookie;
  }
  return {
    kind: "app",
    createClient: (onUnauthorized) =>
      new MockDaemonClient({
        speed: Number.isFinite(speed) && speed > 0 ? speed : 1,
        computer: parseMockComputerMode(searchParam("mockComputer")),
        remote: parseMockRemoteScenario(searchParam("mockRemote")),
        persistVault: searchParam("mockPersist") === "1",
        notes: Number(searchParam("mockNotes")) || 0,
        deviceId,
        onUnauthorized,
      }),
    pair,
  };
}
