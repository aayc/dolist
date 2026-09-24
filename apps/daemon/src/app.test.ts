import { API_ROUTES, API_VERSION, type HealthResponse } from "@ddl/core";
import { describe, expect, it } from "vitest";
import { createSecurityPolicy } from "./security";
import { createTestApp, TEST_PORT, testToken } from "./test-helpers";

describe("authentication", () => {
  it("rejects API requests without a bearer token", async () => {
    const { request } = await createTestApp();
    const res = await request(API_ROUTES.health, { token: null });
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toBe("Bearer");
    expect(await res.json()).toMatchObject({ error: "unauthorized" });
  });

  it("rejects a wrong token, including one that differs only in length", async () => {
    const { request, token } = await createTestApp();
    expect((await request(API_ROUTES.health, { token: testToken() })).status).toBe(401);
    expect((await request(API_ROUTES.health, { token: `${token}0` })).status).toBe(401);
    expect(
      (
        await request(API_ROUTES.health, {
          headers: { authorization: `Basic ${token}` },
          token: null,
        })
      ).status,
    ).toBe(401);
  });

  it("protects every API route, including unknown ones", async () => {
    const { request } = await createTestApp();
    for (const path of [API_ROUTES.tree, API_ROUTES.note("a.md"), "/api", "/api/nope"]) {
      expect((await request(path, { token: null })).status).toBe(401);
    }
  });

  it("serves health with a valid token", async () => {
    const { request } = await createTestApp();
    const res = await request(API_ROUTES.health);
    expect(res.status).toBe(200);
    const body = (await res.json()) as HealthResponse;
    expect(body).toMatchObject({ ok: true, apiVersion: API_VERSION, agentMode: "mock" });
    expect(body.vaultName).toBe("Memory vault");
  });
});

describe("Host and Origin checks", () => {
  it("rejects foreign Host headers (DNS rebinding) before authentication", async () => {
    const { request } = await createTestApp();
    for (const host of ["evil.example:7331", "127.0.0.1:9999", "localhost", "127.0.0.1"]) {
      const res = await request(API_ROUTES.health, { host });
      expect(res.status, host).toBe(403);
      expect(await res.json()).toMatchObject({ error: "forbidden_host" });
    }
    expect((await request("/", { host: "evil.example:7331", token: null })).status).toBe(403);
  });

  it("accepts the daemon and Vite dev-server hosts", async () => {
    const { request } = await createTestApp();
    for (const host of [
      `localhost:${TEST_PORT}`,
      "LOCALHOST:7331",
      "localhost:5173",
      "127.0.0.1:5173",
    ]) {
      expect((await request(API_ROUTES.health, { host })).status, host).toBe(200);
    }
  });

  it("rejects unknown and null Origins on any API method", async () => {
    const { request } = await createTestApp();
    for (const origin of ["http://evil.example", "null", "http://localhost:7331.evil.example"]) {
      const put = await request(API_ROUTES.note("a.md"), {
        method: "PUT",
        origin,
        json: { content: "x" },
      });
      expect(put.status, origin).toBe(403);
      expect(await put.json()).toMatchObject({ error: "forbidden_origin" });
      expect((await request(API_ROUTES.health, { origin })).status).toBe(403);
    }
  });

  it("accepts known Origins and requests without an Origin", async () => {
    const { request } = await createTestApp({ allowedOrigins: ["tauri://localhost"] });
    for (const origin of [
      `http://127.0.0.1:${TEST_PORT}`,
      `http://localhost:${TEST_PORT}`,
      "http://localhost:5173",
      "http://127.0.0.1:5173",
      "tauri://localhost",
    ]) {
      const res = await request(API_ROUTES.note("a.md"), {
        method: "PUT",
        origin,
        json: { content: "x" },
      });
      expect(res.ok, origin).toBe(true);
    }
    const res = await request(API_ROUTES.note("b.md"), { method: "PUT", json: { content: "x" } });
    expect(res.status).toBe(201);
  });

  it("derives Host entries from extra http origins", () => {
    const policy = createSecurityPolicy({
      port: 7331,
      token: testToken(),
      extraOrigins: ["http://localhost:5174/", "tauri://localhost"],
    });
    expect(policy.isHostAllowed("localhost:5174")).toBe(true);
    expect(policy.isOriginAllowed("http://localhost:5174")).toBe(true);
    expect(policy.isHostAllowed("localhost")).toBe(false);
  });
});

describe("request hygiene", () => {
  it("rejects bodies over 5 MB", async () => {
    const { request } = await createTestApp();
    const res = await request(API_ROUTES.note("big.md"), {
      method: "PUT",
      body: JSON.stringify({ content: "x".repeat(5 * 1024 * 1024 + 10) }),
    });
    expect(res.status).toBe(413);
    expect(await res.json()).toMatchObject({ error: "payload_too_large" });
  });

  it("rejects invalid JSON and unknown fields", async () => {
    const { request } = await createTestApp();
    const bad = await request(API_ROUTES.note("a.md"), { method: "PUT", body: "{nope" });
    expect(bad.status).toBe(400);
    expect(await bad.json()).toMatchObject({ error: "invalid_json" });
    const extra = await request(API_ROUTES.note("a.md"), {
      method: "PUT",
      json: { content: "x", sneaky: true },
    });
    expect(extra.status).toBe(400);
    expect(await extra.json()).toMatchObject({ error: "invalid_request" });
  });

  it("sets security headers and never sends CORS headers", async () => {
    const { request } = await createTestApp();
    const res = await request(API_ROUTES.health, { origin: "http://localhost:5173" });
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("referrer-policy")).toBe("no-referrer");
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("guards and validates paths containing encoded line terminators", async () => {
    const { request } = await createTestApp();
    for (const path of [
      "/api/notes/a%0Ab.md",
      "/api/notes/a%E2%80%A8b%0D.md",
      "/api/threads/x%0Ay",
    ]) {
      const anonymous = await request(path, { token: null });
      expect(anonymous.status, path).toBe(401);
      expect(anonymous.headers.get("x-content-type-options")).toBe("nosniff");
      expect((await request(path)).status, path).toBe(400);
    }
  });

  it("answers unknown API routes with JSON 404 and plain /ws with 426", async () => {
    const { request } = await createTestApp();
    const missing = await request("/api/does-not-exist");
    expect(missing.status).toBe(404);
    expect(await missing.json()).toMatchObject({ error: "not_found" });
    expect((await request("/ws")).status).toBe(426);
  });
});
