import { API_ROUTES, WORKSPACE_ID_HEADER } from "@ddl/core";
import { describe, expect, it } from "vitest";
import { createTestApp } from "../test-helpers";

describe("authenticated attachment bytes", () => {
  it("conditionally uploads exact bytes, serves guarded metadata, and soft deletes the original", async () => {
    const app = await createTestApp();
    const { workspaceId } = (await (await app.request("/api/health")).json()) as {
      workspaceId: string;
    };
    const headers = {
      [WORKSPACE_ID_HEADER]: workspaceId,
      "content-type": "application/octet-stream",
    };
    const bytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0, 255, 128]);
    const path = "Assets/Café #1%.png";
    const route = API_ROUTES.file(path);
    expect(
      (
        await app.request(`${route}?ifAbsent=1`, {
          method: "PUT",
          headers,
          body: bytes,
          token: null,
        })
      ).status,
    ).toBe(401);
    const saved = await app.request(`${route}?ifAbsent=1`, { method: "PUT", headers, body: bytes });
    expect(saved.status).toBe(201);
    const metadata = (await saved.json()) as { version: string };
    expect(
      (await app.request(`${route}?ifAbsent=1`, { method: "PUT", headers, body: bytes })).status,
    ).toBe(409);
    const read = await app.request(route, { headers });
    expect(new Uint8Array(await read.arrayBuffer())).toEqual(bytes);
    expect(read.headers.get("x-ddl-file-version")).toBe(metadata.version);
    expect(decodeURIComponent(read.headers.get("x-ddl-file-path")!)).toBe(path);
    expect(read.headers.get("content-type")).toBe("image/png");
    expect(read.headers.get("content-disposition")).toMatch(/^inline;/);
    expect(
      (await app.request(route, { headers: { [WORKSPACE_ID_HEADER]: "different-workspace" } }))
        .status,
    ).toBe(412);
    expect((await app.request(route, { method: "DELETE", headers })).status).toBe(200);
    expect((await app.storage.readBinary(`.trash/${path}`))?.bytes).toEqual(bytes);
  });

  it("never grants inline execution from extensions or claimed upload MIME", async () => {
    const app = await createTestApp();
    for (const [path, text, type] of [
      ["fake.png", "<html><script>synthetic()</script>", "application/octet-stream"],
      ["active.svg", "<svg onload='synthetic()'/>", "image/svg+xml; charset=utf-8"],
      ["document.pdf", "%PDF-synthetic", "application/pdf"],
    ]) {
      await app.storage.writeBinary(path!, new TextEncoder().encode(text!));
      const response = await app.request(API_ROUTES.file(path!));
      expect(response.headers.get("content-type")).toBe(type);
      expect(response.headers.get("content-disposition")).toMatch(/^attachment;/);
      expect(response.headers.get("content-security-policy")).toContain("sandbox;");
      expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    }
    for (const path of [
      ".daily-do-list/workspace.json",
      "Assets/../Secret.png",
      "Assets/%2e%2e/Secret.png",
    ]) {
      const response = await app.request(API_ROUTES.file(path));
      expect(response.status).not.toBe(200);
    }
  });
});
