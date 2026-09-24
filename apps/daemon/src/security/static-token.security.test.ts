import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { API_ROUTES } from "@ddl/core";
import { fc, test } from "@fast-check/vitest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { injectToken } from "../routes/web";
import { createTestApp, type TestApp, tempDir } from "../test-helpers";
import { httpRequest, type MemoryLiveApp, rawRequest, startLiveApp, TestSocket } from "./harness";

const INDEX = `<!doctype html><html><head><title>Daily Do List</title></head><body><div id="root"></div></body></html>`;

/** Decodes the four entities `escapeAttribute` produces (in the reverse order). */
const unescapeAttribute = (value: string) =>
  value
    .replaceAll("&quot;", '"')
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&amp;", "&");

describe("token injection into index.html", () => {
  test.prop([
    fc.string({ unit: "grapheme", maxLength: 80 }),
    fc.constantFrom(INDEX, "<HEAD lang=en></HEAD>", "<p>no head</p>"),
  ])("keeps any token inside one attribute value and recovers it exactly", (token, html) => {
    const out = injectToken(html, token);
    const metas = out.match(/<meta name="ddl-token" content="([^"]*)">/g) ?? [];
    expect(metas).toHaveLength(1);
    const content = /<meta name="ddl-token" content="([^"]*)">/.exec(out)![1]!;
    expect(content).not.toMatch(/[<>"]/);
    expect(unescapeAttribute(content)).toBe(token);
    expect(out.replace(metas[0]!, "")).toBe(html);
  });

  it("escapes markup-breaking characters, including replacement patterns", () => {
    const out = injectToken(INDEX, `"><script>alert(1)</script>&amp;$&$1`);
    expect(out).toContain(
      '<meta name="ddl-token" content="&quot;&gt;&lt;script&gt;alert(1)&lt;/script&gt;&amp;amp;$&amp;$1">',
    );
    expect(out).not.toContain("<script>alert(1)");
  });
});

describe("static files and the SPA fallback", () => {
  let root: { path: string; cleanup: () => void };
  let dist: string;
  let app: TestApp;

  beforeAll(async () => {
    root = tempDir("ddl-static-");
    dist = join(root.path, "dist");
    mkdirSync(join(dist, "assets"), { recursive: true });
    writeFileSync(join(dist, "index.html"), INDEX);
    writeFileSync(join(dist, "assets", "app-3f9a.js"), "console.log('app')");
    writeFileSync(join(dist, "favicon.svg"), "<svg/>");
    writeFileSync(join(dist, "manifest.webmanifest"), "{}");
    writeFileSync(join(dist, "report.html"), "<p>static</p>");
    writeFileSync(join(dist, ".env"), "OPENROUTER_API_KEY=dist-canary");
    mkdirSync(join(dist, ".git"));
    writeFileSync(join(dist, ".git", "config"), "dist-canary");
    writeFileSync(join(root.path, "secret.txt"), "outside-canary");
    writeFileSync(join(root.path, "secret.js"), "outside-canary");
    app = await createTestApp({ webDist: dist });
  });
  afterAll(() => root.cleanup());

  const get = (path: string, method = "GET") => app.request(path, { method, token: null });

  it("never serves files outside the build or dot-files inside it", async () => {
    for (const path of [
      "/..%2Fsecret.txt",
      "/..%2F..%2Fsecret.txt",
      "/assets/..%2F..%2Fsecret.txt",
      "/assets/%2e%2e%2f%2e%2e%2fsecret.js",
      "/%2e%2e/secret.txt",
      "/.%2e/secret.js",
      "/%5c..%5csecret.txt",
      "/..%5c..%5csecret.js",
      "/assets/..\\..\\secret.js",
      "/secret.txt%00.js",
      "/assets/app-3f9a.js%00",
      "//secret.txt",
      "/assets//..//..//secret.js",
      "/%252e%252e/secret.txt",
      "/.env",
      "/%2eenv",
      "/.git/config",
      "/assets/../.env",
      "/%2e%2e%2f.env",
      "/dist/index.html",
    ]) {
      const res = await get(path);
      const body = await res.text();
      expect(body, path).not.toContain("canary");
      expect([200, 404], path).toContain(res.status);
      if (res.status === 200) expect(body, path).toContain('<meta name="ddl-token"');
    }
  });

  it("puts the token only in the HTML shell, never in assets, API answers or errors", async () => {
    const withToken: string[] = [];
    const responses: Array<[string, Response]> = [
      ["/", await get("/")],
      ["/index.html", await get("/index.html")],
      ["/notes/Daily/2026-09-23.md", await get("/notes/Daily/2026-09-23.md")],
      ["/assets/app-3f9a.js", await get("/assets/app-3f9a.js")],
      ["/favicon.svg", await get("/favicon.svg")],
      ["/manifest.webmanifest", await get("/manifest.webmanifest")],
      ["/report.html", await get("/report.html")],
      ["/assets/missing.js", await get("/assets/missing.js")],
      ["/missing.png", await get("/missing.png")],
      ["POST /", await get("/", "POST")],
      ["PUT /index.html", await get("/index.html", "PUT")],
      ["/ws", await get("/ws")],
      ["/api/health (no token)", await get(API_ROUTES.health)],
      ["/api/health", await app.request(API_ROUTES.health)],
      ["/api/nope", await app.request("/api/nope")],
      ["/api/vault/tree", await app.request(API_ROUTES.tree)],
      ["/api/settings", await app.request(API_ROUTES.settings)],
      ["/api/agent/status", await app.request(API_ROUTES.agentStatus)],
      ["foreign host", await app.request("/", { host: "evil.example", token: null })],
      ["foreign origin", await app.request(API_ROUTES.health, { origin: "http://evil.example" })],
      ["bad json", await app.request(API_ROUTES.note("a.md"), { method: "PUT", body: "{" })],
      ["bad path", await app.request("/api/notes/..%2Fx.md")],
      [
        "413",
        await app.request(API_ROUTES.note("a.md"), {
          method: "PUT",
          body: "x".repeat(5 * 1024 * 1024 + 1),
        }),
      ],
    ];
    for (const [label, res] of responses) {
      const text = `${JSON.stringify([...res.headers])}\n${await res.text()}`;
      if (text.includes(app.token)) withToken.push(label);
    }
    expect(withToken.sort()).toEqual(["/", "/index.html", "/notes/Daily/2026-09-23.md"].sort());
  });

  it("sends caching and security headers suited to each kind of response", async () => {
    const index = await get("/");
    expect(index.headers.get("cache-control")).toBe("no-store");
    expect(index.headers.get("content-security-policy")).toMatch(/frame-ancestors 'none'/);
    expect(index.headers.get("content-security-policy")).toMatch(/object-src 'none'/);
    expect(index.headers.get("x-frame-options")).toBe("DENY");
    expect(index.headers.get("cross-origin-opener-policy")).toBe("same-origin");

    const asset = await get("/assets/app-3f9a.js");
    expect(asset.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    expect(asset.headers.get("content-type")).toBe("text/javascript; charset=utf-8");
    expect((await get("/favicon.svg")).headers.get("cache-control")).toBe("no-cache");
    const staticHtml = await get("/report.html");
    expect(staticHtml.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
    expect(staticHtml.headers.get("x-frame-options")).toBe("DENY");

    for (const res of [
      index,
      asset,
      await get("/missing.png"),
      await app.request(API_ROUTES.health),
    ]) {
      expect(res.headers.get("x-content-type-options")).toBe("nosniff");
      expect(res.headers.get("referrer-policy")).toBe("no-referrer");
      expect(res.headers.get("cross-origin-resource-policy")).toBe("same-origin");
      for (const name of res.headers.keys()) expect(name).not.toMatch(/^access-control-/);
    }
    expect((await app.request(API_ROUTES.health)).headers.get("cache-control")).toBe("no-store");
  });

  it("answers HEAD for the shell without a body", async () => {
    const res = await get("/", "HEAD");
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("");
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  it("explains a missing build without the token, and still 404s assets", async () => {
    const missing = await createTestApp({ webDist: join(root.path, "nope") });
    for (const path of ["/", "/index.html", "/notes/x.md"]) {
      const res = await missing.request(path, { token: null });
      expect(res.status, path).toBe(503);
      const body = await res.text();
      expect(body).not.toContain(missing.token);
      expect(res.headers.get("cache-control")).toBe("no-store");
      expect(res.headers.get("content-security-policy")).toContain("default-src 'none'");
    }
    for (const path of ["/assets/app.js", "/favicon.svg"]) {
      expect((await missing.request(path, { token: null })).status, path).toBe(404);
    }
  });
});

describe("the token never travels anywhere else", () => {
  let live: MemoryLiveApp;
  beforeAll(async () => {
    live = await startLiveApp();
  });
  afterAll(() => live.close());

  it("is absent from WebSocket traffic and upgrade refusals", async () => {
    const socket = await TestSocket.open(live.wsUrl());
    await socket.next("hello");
    socket.send("garbage");
    socket.send({ type: "surface.subscribe", threadId: live.token, surface: "browser" });
    socket.send({ type: "thread.read", threadId: live.token });
    live.runtime.emit("status", live.runtime.status());
    await socket.next("agent.status");
    await socket.barrier();
    for (const event of socket.events) expect(JSON.stringify(event)).not.toContain(live.token);
    socket.ws.terminate();

    for (const headers of [
      [["Host", "evil.example"]],
      [
        ["Host", live.host],
        ["Origin", "http://evil.example"],
      ],
      [["Host", live.host]],
    ] as Array<Array<[string, string]>>) {
      const res = await rawRequest(
        live.port,
        httpRequest("GET", `${API_ROUTES.ws}?token=${live.token.slice(0, 63)}x`, [
          ...headers,
          ["Upgrade", "websocket"],
          ["Connection", "Upgrade"],
          ["Sec-WebSocket-Key", "dGhlIHNhbXBsZSBub25jZQ=="],
          ["Sec-WebSocket-Version", "13"],
        ]),
      );
      expect(res.status).toBeGreaterThanOrEqual(400);
      expect(`${JSON.stringify(res.headers)}${res.body}`).not.toContain(live.token.slice(0, 63));
    }
  });
});
