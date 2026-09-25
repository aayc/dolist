// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { readPageAuth } from "./auth";
import { HttpDaemonClient } from "./http-client";
import { resolveStartup } from "./select-client";

function setMeta(name: string, content: string): void {
  const meta = document.head.appendChild(document.createElement("meta"));
  meta.name = name;
  meta.content = content;
}

afterEach(() => {
  for (const meta of document.head.querySelectorAll("meta")) meta.remove();
  vi.unstubAllGlobals();
});

describe("how the page authenticates", () => {
  it("reads what the daemon put in index.html", () => {
    expect(readPageAuth()).toEqual({ kind: "none" });
    setMeta("ddl-auth", "pairing");
    expect(readPageAuth()).toEqual({ kind: "pairing" });
    document.head.querySelector("meta")?.remove();
    setMeta("ddl-auth", "cookie");
    expect(readPageAuth()).toEqual({ kind: "cookie" });
    setMeta("ddl-token", " t0ken ");
    expect(readPageAuth()).toEqual({ kind: "token", token: "t0ken" });
  });
});

describe("what the page starts", () => {
  it("a loopback page uses its embedded token, exactly as before", async () => {
    setMeta("ddl-token", "t0ken");
    const startup = await resolveStartup();
    expect(startup.kind).toBe("app");
    if (startup.kind !== "app") return;
    expect(startup.pair).toBeNull();
    const client = startup.createClient(() => {}) as HttpDaemonClient;
    expect(client).toBeInstanceOf(HttpDaemonClient);
    expect(new URL(client.socketUrl()).searchParams.get("token")).toBe("t0ken");
  });

  it("a paired remote browser uses its cookie: no token, and pairing again if revoked", async () => {
    setMeta("ddl-auth", "cookie");
    const startup = await resolveStartup();
    if (startup.kind !== "app") throw new Error("expected the app");
    expect(startup.pair).not.toBeNull();
    const onUnauthorized = vi.fn();
    const fetchMock = vi.fn(
      async (_url: string, _init: RequestInit) =>
        new Response(JSON.stringify({ error: "unauthorized" }), {
          status: 401,
          headers: { "content-type": "application/json" },
        }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const client = startup.createClient(onUnauthorized) as HttpDaemonClient;
    expect(new URL(client.socketUrl()).search).toBe("");
    await expect(client.getDevice()).rejects.toMatchObject({ status: 401 });
    expect(onUnauthorized).toHaveBeenCalledTimes(1);
    const init = fetchMock.mock.calls[0]?.[1];
    expect(init?.headers).not.toHaveProperty("Authorization");
  });

  it("a remote browser told to pair checks its cookie first", async () => {
    setMeta("ddl-auth", "pairing");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 })),
    );
    // Reached from another site, the page came without the cookie; its own requests carry it.
    expect((await resolveStartup()).kind).toBe("app");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ error: "unauthorized" }), { status: 401 })),
    );
    expect((await resolveStartup()).kind).toBe("pairing");
  });
});
