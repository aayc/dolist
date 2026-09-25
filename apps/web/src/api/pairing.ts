import { API_ROUTES, type PairRequest, type PairResponse } from "@ddl/core";
import { NetworkError } from "./errors";
import { readResponse } from "./http-response";

/** What a remote browser sends to pair: the code it was given and what to call it. */
export interface BrowserPairing {
  code: string;
  name: string;
}

/** Pairs this browser; the answer sets its HttpOnly device cookie (the page then reloads). */
export type PairBrowser = (pairing: BrowserPairing) => Promise<PairResponse>;

async function send(fetchImpl: typeof fetch, url: string, init: RequestInit): Promise<Response> {
  try {
    return await fetchImpl(url, {
      ...init,
      credentials: "same-origin",
      signal: AbortSignal.timeout(20_000),
    });
  } catch (error) {
    throw new NetworkError(
      error instanceof Error ? error.message : "Could not reach the Daily Do List daemon",
    );
  }
}

/** `POST /api/pair` as a browser: no credential (the code is one), the cookie comes back. */
export function createBrowserPairing(fetchImpl: typeof fetch = fetch): PairBrowser {
  return async ({ code, name }) => {
    const body: PairRequest = { code, name, kind: "browser" };
    const response = await send(fetchImpl, API_ROUTES.pair, {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    return readResponse<PairResponse>(response);
  };
}

/**
 * Whether this browser's device cookie works. A page reached from another site is served as
 * `pairing` because `SameSite=Strict` keeps the cookie off that navigation, while the page's own
 * requests carry it.
 */
export async function deviceCookieWorks(fetchImpl: typeof fetch = fetch): Promise<boolean> {
  try {
    const response = await send(fetchImpl, API_ROUTES.health, {
      headers: { Accept: "application/json" },
    });
    return response.ok;
  } catch {
    return false;
  }
}
