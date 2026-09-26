import { API_ROUTES } from "@ddl/core";
import { describe, expect, it } from "vitest";
import { createTestApp, TEST_PORT } from "./test-helpers";

describe("app", () => {
  it("accepts API requests from known Origins", async () => {
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
});
