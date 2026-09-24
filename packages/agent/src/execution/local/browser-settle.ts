import type { Page, Request } from "playwright-core";

export interface SettleOptions {
  /** Upper bound on waiting after the action itself finished. */
  maxWaitMs?: number;
  /** How long the network must stay quiet before the page counts as settled. */
  quietMs?: number;
}

const TRACKED_TYPES = new Set(["document", "stylesheet", "script", "xhr", "fetch"]);
const POLL_MS = 50;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function isMainFrameNavigation(page: Page, request: Request): boolean {
  try {
    return request.isNavigationRequest() && request.frame() === page.mainFrame();
  } catch {
    // Service-worker requests have no frame.
    return false;
  }
}

/**
 * Runs `action`, then waits (bounded) for what it triggered: the load event if it navigated, and
 * a short quiet period with no document/script/XHR requests in flight. Long-polling pages simply
 * hit the bound.
 */
export async function runAndSettle<T>(
  page: Page,
  action: () => Promise<T>,
  options: SettleOptions = {},
): Promise<T> {
  const maxWaitMs = options.maxWaitMs ?? 3_000;
  const quietMs = options.quietMs ?? 250;
  const inflight = new Set<Request>();
  let navigated = false;
  const onRequest = (request: Request) => {
    if (isMainFrameNavigation(page, request)) navigated = true;
    if (TRACKED_TYPES.has(request.resourceType())) inflight.add(request);
  };
  const onDone = (request: Request) => {
    inflight.delete(request);
  };
  page.on("request", onRequest);
  page.on("requestfinished", onDone);
  page.on("requestfailed", onDone);
  try {
    const result = await action();
    const deadline = Date.now() + maxWaitMs;
    if (navigated && !page.isClosed()) {
      await page
        .waitForLoadState("load", { timeout: Math.max(1, deadline - Date.now()) })
        .catch(() => {});
    }
    let quietSince = inflight.size === 0 ? Date.now() : undefined;
    while (Date.now() < deadline && !page.isClosed()) {
      if (quietSince !== undefined && Date.now() - quietSince >= quietMs) break;
      await sleep(POLL_MS);
      if (inflight.size === 0) quietSince ??= Date.now();
      else quietSince = undefined;
    }
    return result;
  } finally {
    page.off("request", onRequest);
    page.off("requestfinished", onDone);
    page.off("requestfailed", onDone);
  }
}
