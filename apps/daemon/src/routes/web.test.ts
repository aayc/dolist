import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createRemoteHosts } from "../remote-hosts";
import { createTestApp, tempDir } from "../test-helpers";

const THEME_SCRIPT = "document.documentElement.dataset.theme = localStorage.theme || 'dark';";
const INDEX_HTML = `<!doctype html>
<html>
<head lang="en">
<script>${THEME_SCRIPT}</script>
<script type="module" src="/assets/index-abc123.js"></script>
</head>
<body><div id="root"></div></body>
</html>`;

let dist: { path: string; cleanup: () => void };

beforeEach(() => {
  dist = tempDir("ddl-web-");
  mkdirSync(join(dist.path, "assets"));
  writeFileSync(join(dist.path, "index.html"), INDEX_HTML);
  writeFileSync(join(dist.path, "assets", "index-abc123.js"), "console.log('app')");
  writeFileSync(join(dist.path, "favicon.svg"), "<svg/>");
  writeFileSync(join(dist.path, ".secret.txt"), "hidden");
});

afterEach(() => dist.cleanup());

describe("web app", () => {
  it("injects the token into index.html and never caches it", async () => {
    const { request, token } = await createTestApp({ webDist: dist.path });
    const res = await request("/", { token: null });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain(`<head lang="en"><meta name="ddl-token" content="${token}">`);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("content-type")).toMatch(/^text\/html/);
    expect(res.headers.get("x-frame-options")).toBe("DENY");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("referrer-policy")).toBe("no-referrer");
  });

  it("allows exactly the inline scripts of index.html in its CSP", async () => {
    const { request } = await createTestApp({ webDist: dist.path });
    const csp = (await request("/", { token: null })).headers.get("content-security-policy") ?? "";
    const hash = createHash("sha256").update(THEME_SCRIPT).digest("base64");
    expect(csp).toContain(`script-src 'self' 'sha256-${hash}'`);
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("connect-src 'self' ws://127.0.0.1:7331 ws://localhost:7331");
    expect(csp).not.toContain("unsafe-eval");
  });

  it("serves hashed assets as immutable and other files as revalidated", async () => {
    const { request } = await createTestApp({ webDist: dist.path });
    const asset = await request("/assets/index-abc123.js", { token: null });
    expect(asset.status).toBe(200);
    expect(asset.headers.get("content-type")).toBe("text/javascript; charset=utf-8");
    expect(asset.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    expect(await asset.text()).toBe("console.log('app')");
    const icon = await request("/favicon.svg", { token: null });
    expect(icon.headers.get("cache-control")).toBe("no-cache");
  });

  it("falls back to index.html for app routes but 404s missing assets", async () => {
    const { request, token } = await createTestApp({ webDist: dist.path });
    const route = await request("/notes/Daily/2026-09-23.md", { token: null });
    expect(route.status).toBe(200);
    expect(await route.text()).toContain(token);
    expect((await request("/assets/missing-1234.js", { token: null })).status).toBe(404);
    expect((await request("/logo.png", { token: null })).status).toBe(404);
  });

  it("never serves dot-files or paths outside the build", async () => {
    const { request } = await createTestApp({ webDist: dist.path });
    expect((await request("/.secret.txt", { token: null })).status).toBe(404);
    const escaped = await request("/%2E%2E%2Fpackage.json", { token: null });
    expect(escaped.status).toBe(404);
    expect(await escaped.text()).not.toContain("dependencies");
  });

  it("picks up a rebuilt index.html without restarting", async () => {
    const { request } = await createTestApp({ webDist: dist.path });
    await request("/", { token: null });
    writeFileSync(join(dist.path, "index.html"), "<html><head></head><body>v2 build</body></html>");
    expect(await (await request("/", { token: null })).text()).toContain("v2 build");
  });

  it("tells a remote page whether its device cookie works, and never gives it the token", async () => {
    const remote = "vm-name.tailnet-name.ts.net";
    const app = await createTestApp({
      webDist: dist.path,
      remoteHosts: createRemoteHosts([remote]),
    });
    const browser = await app.devices.add("Browser", "browser");
    const phone = await app.devices.add("Phone", "app");
    const page = async (host: string, cookie?: string, path = "/") => {
      const res = await app.request(path, {
        host,
        token: null,
        ...(cookie ? { headers: { cookie: `__Host-ddl-device=${cookie}` } } : {}),
      });
      expect(res.headers.get("cache-control")).toBe("no-store");
      return res.text();
    };
    const pairing = '<head lang="en"><meta name="ddl-auth" content="pairing">';
    const cookie = '<head lang="en"><meta name="ddl-auth" content="cookie">';
    expect(await page(remote)).toContain(pairing);
    expect(await page(remote, browser.token)).toContain(cookie);
    expect(await page(remote, browser.token, "/notes/Daily/2026-09-23.md")).toContain(cookie);
    expect(await page(remote, phone.token)).toContain(pairing);
    expect(await page(remote, "not-a-token")).toContain(pairing);
    for (const html of [await page(remote), await page(remote, browser.token)]) {
      expect(html).not.toContain(app.token);
      expect(html).not.toContain(browser.token);
      expect(html).not.toContain("ddl-token");
    }
    await app.devices.revoke(browser.device.id);
    expect(await page(remote, browser.token)).toContain(pairing);
    // Loopback pages keep the token, cookie or not.
    const local = await page("127.0.0.1:7331", phone.token);
    expect(local).toContain(`<meta name="ddl-token" content="${app.token}">`);
    expect(local).not.toContain("ddl-auth");
  });

  it("explains how to build the UI when dist is missing, without leaking the token", async () => {
    const { request, token } = await createTestApp({ webDist: join(dist.path, "nope") });
    const res = await request("/", { token: null });
    expect(res.status).toBe(503);
    const html = await res.text();
    expect(html).toContain("pnpm build");
    expect(html).toContain("http://localhost:5173");
    expect(html).not.toContain(token);
    expect(res.headers.get("content-security-policy")).toContain("default-src 'none'");
  });
});
