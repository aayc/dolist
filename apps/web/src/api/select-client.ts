import { readPageAuth } from "./auth";
import type { DaemonClient } from "./client";
import { HttpDaemonClient } from "./http-client";
import { createBrowserPairing, deviceCookieWorks, type PairBrowser } from "./pairing";

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
