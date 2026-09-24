import { describe, expect, it } from "vitest";
import { checkOpenRouterKey } from "./openrouter";

function fakeFetch(respond: () => Response | Promise<Response>): typeof fetch {
  return (async () => respond()) as unknown as typeof fetch;
}

describe("checkOpenRouterKey", () => {
  it("accepts a key the key-info endpoint recognizes", async () => {
    const result = await checkOpenRouterKey("k", {
      fetch: fakeFetch(() => Response.json({ data: { label: "x" } })),
    });
    expect(result).toEqual({ status: "valid" });
  });

  it("reports rejected keys with OpenRouter's message", async () => {
    const result = await checkOpenRouterKey("k", {
      fetch: fakeFetch(() =>
        Response.json({ error: { message: "User not found.", code: 401 } }, { status: 401 }),
      ),
    });
    expect(result).toEqual({ status: "invalid", httpStatus: 401, message: "User not found." });
  });

  it("treats outages and network errors as unknown instead of blocking", async () => {
    expect(
      await checkOpenRouterKey("k", { fetch: fakeFetch(() => new Response("", { status: 503 })) }),
    ).toEqual({ status: "unknown", message: "HTTP 503" });
    const offline = await checkOpenRouterKey("k", {
      fetch: fakeFetch(() => {
        throw new TypeError("fetch failed");
      }),
    });
    expect(offline).toEqual({ status: "unknown", message: "fetch failed" });
  });
});
