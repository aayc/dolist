import { describe, expect, it } from "vitest";
import { HttpError, NetworkError } from "./errors";
import { createBrowserPairing, deviceCookieWorks } from "./pairing";

function fakeFetch(status: number, body?: unknown) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return new Response(body === undefined ? null : JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

describe("pairing a remote browser", () => {
  it("posts the code as a browser, with no credential but the page's own cookies", async () => {
    const device = { id: "pdv_1", name: "Chrome on macOS", kind: "browser", createdAt: 1 };
    const { fetchImpl, calls } = fakeFetch(201, { device: { ...device, lastSeenAt: null } });
    const response = await createBrowserPairing(fetchImpl)({
      code: "ABCD-EFGH",
      name: "Chrome on macOS",
    });
    expect(response.device.name).toBe("Chrome on macOS");
    expect(calls).toHaveLength(1);
    const [{ url, init }] = calls as [{ url: string; init: RequestInit }];
    expect(url).toBe("/api/pair");
    expect(init.method).toBe("POST");
    expect(init.credentials).toBe("same-origin");
    expect(init.headers).not.toHaveProperty("Authorization");
    expect(JSON.parse(init.body as string)).toEqual({
      code: "ABCD-EFGH",
      name: "Chrome on macOS",
      kind: "browser",
    });
  });

  it("surfaces the daemon's refusal with its code", async () => {
    const { fetchImpl } = fakeFetch(401, {
      error: "pairing_rejected",
      message: "Wrong, expired or already used pairing code",
    });
    const error = await createBrowserPairing(fetchImpl)({ code: "ABCDEFGH", name: "x" }).catch(
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(HttpError);
    expect(error).toMatchObject({ status: 401, body: { error: "pairing_rejected" } });
  });

  it("reports an unreachable daemon as a NetworkError", async () => {
    const fetchImpl = (async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch;
    await expect(
      createBrowserPairing(fetchImpl)({ code: "ABCDEFGH", name: "x" }),
    ).rejects.toBeInstanceOf(NetworkError);
  });

  it("checks whether the device cookie works with an authenticated request", async () => {
    const ok = fakeFetch(200, { ok: true });
    expect(await deviceCookieWorks(ok.fetchImpl)).toBe(true);
    expect(ok.calls[0]).toMatchObject({ url: "/api/health", init: { credentials: "same-origin" } });
    expect(await deviceCookieWorks(fakeFetch(401, { error: "unauthorized" }).fetchImpl)).toBe(
      false,
    );
    const offline = (async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch;
    expect(await deviceCookieWorks(offline)).toBe(false);
  });
});
