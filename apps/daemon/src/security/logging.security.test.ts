import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";
import { API_ROUTES } from "@ddl/core";
import { LocalFsStorageProvider } from "@ddl/storage";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "../config";
import { type RunningDaemon, startDaemon } from "../server";
import { createTestApp, tempDir } from "../test-helpers";
import { RecordingLogger, TestSocket, upgradeOutcome } from "./harness";

let dir: { path: string; cleanup: () => void } | undefined;
let daemon: RunningDaemon | undefined;
let fakeOpenRouter: Server | undefined;
const savedEnv = { ...process.env };

afterEach(async () => {
  await daemon?.close();
  daemon = undefined;
  await new Promise((resolve) =>
    fakeOpenRouter ? fakeOpenRouter.close(resolve) : resolve(undefined),
  );
  fakeOpenRouter = undefined;
  vi.restoreAllMocks();
  for (const key of ["OPENROUTER_API_KEY", "DDL_OPENROUTER_BASE_URL"]) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
  dir?.cleanup();
  dir = undefined;
});

/** Everything written to the console or stdout/stderr from now on. */
function captureOutput(): string[] {
  const lines: string[] = [];
  const record = (...args: unknown[]) => {
    lines.push(args.map((arg) => (typeof arg === "string" ? arg : String(arg))).join(" "));
  };
  for (const method of ["log", "info", "warn", "error", "debug"] as const) {
    vi.spyOn(console, method).mockImplementation(record);
  }
  for (const stream of [process.stdout, process.stderr]) {
    const write = stream.write.bind(stream);
    vi.spyOn(stream, "write").mockImplementation(((chunk: unknown, ...rest: unknown[]) => {
      lines.push(String(chunk));
      return (write as (...a: unknown[]) => boolean)(chunk, ...rest);
    }) as typeof stream.write);
  }
  return lines;
}

/** Answers the key check like OpenRouter does for a revoked key, and records what it was sent. */
async function startFakeOpenRouter(seen: string[]): Promise<string> {
  fakeOpenRouter = createServer((req, res) => {
    seen.push(`${req.method} ${req.url} ${req.headers.authorization ?? ""}`);
    res.writeHead(401, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: { message: "User not found.", code: 401 } }));
  });
  await new Promise<void>((resolve) => fakeOpenRouter!.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(fakeOpenRouter.address() as AddressInfo).port}/api/v1`;
}

describe("daemon logs", () => {
  it("never contain the bearer token or API keys, from start through live-mode key checks to shutdown", async () => {
    dir = tempDir("ddl-logging-");
    const home = join(dir.path, "state");
    const dist = join(dir.path, "dist");
    mkdirSync(home, { recursive: true });
    mkdirSync(dist);
    writeFileSync(
      join(dist, "index.html"),
      "<!doctype html><html><head></head><body></body></html>",
    );
    const apiKey = `sk-or-v1-${randomBytes(24).toString("hex")}`;
    const otherSecret = `other-${randomBytes(16).toString("hex")}`;
    writeFileSync(join(home, ".env"), `ANOTHER_SERVICE_TOKEN=${otherSecret}\n`);
    const keyChecks: string[] = [];
    const baseUrl = await startFakeOpenRouter(keyChecks);
    // The agent runtime reads these from process.env directly.
    process.env.OPENROUTER_API_KEY = apiKey;
    process.env.DDL_OPENROUTER_BASE_URL = baseUrl;
    const env: Record<string, string | undefined> = {
      DDL_HOME: home,
      DDL_VAULT: join(dir.path, "vault"),
      DDL_WEB_DIST: dist,
      DDL_AGENT_MODE: "live",
      DDL_PORT: "0",
      DDL_LOG_LEVEL: "debug",
      OPENROUTER_API_KEY: apiKey,
      DDL_OPENROUTER_BASE_URL: baseUrl,
    };

    const external: string[] = [];
    const realFetch = globalThis.fetch;
    vi.spyOn(globalThis, "fetch").mockImplementation((input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      if (url.hostname !== "127.0.0.1") {
        external.push(url.href);
        return Promise.reject(new Error("network disabled in tests"));
      }
      return realFetch(input, init);
    });
    const lines = captureOutput();

    const config = loadConfig({ env, cwd: dir.path, homedir: dir.path, platform: "linux" });
    daemon = await startDaemon({ config, env });
    const token = readFileSync(config.tokenPath, "utf8").trim();
    const base = daemon.url;
    const auth = { authorization: `Bearer ${token}` };
    const json = { ...auth, "content-type": "application/json" };
    const flipped = `${token.slice(0, -1)}${token.endsWith("0") ? "1" : "0"}`;

    expect((await fetch(`${base}/`)).status).toBe(200);
    for (const headers of [{}, auth, { authorization: `Bearer ${flipped}` }]) {
      await fetch(`${base}${API_ROUTES.health}?token=${token}`, { headers });
    }
    const status = await (
      await fetch(`${base}${API_ROUTES.agentStatus}`, { headers: auth })
    ).text();
    expect(status).toContain("OpenRouter rejected");
    expect(status).not.toContain(apiKey);
    await fetch(`${base}${API_ROUTES.note("Inbox/a.md")}`, {
      method: "PUT",
      headers: json,
      body: JSON.stringify({ content: `${token} ${apiKey}` }),
    });
    await fetch(`${base}${API_ROUTES.note("Inbox/a.md")}`, { headers: auth });
    await fetch(`${base}${API_ROUTES.note("Inbox/a.md/b.md")}`, {
      method: "PUT",
      headers: json,
      body: '{"content":"x"}',
    });
    await fetch(`${base}${API_ROUTES.note("../x.md")}`, { headers: auth });
    await fetch(`${base}${API_ROUTES.settings}`, {
      method: "PUT",
      headers: json,
      body: JSON.stringify({ theme: "dark" }),
    });
    await fetch(`${base}${API_ROUTES.search(token)}`, { headers: auth });
    await fetch(`${base}${API_ROUTES.threadMessages("thr_missing")}`, {
      method: "POST",
      headers: json,
      body: JSON.stringify({ text: apiKey }),
    });
    await fetch(`${base}${API_ROUTES.note("Inbox/a.md")}`, { method: "DELETE", headers: auth });
    await fetch(`${base}${API_ROUTES.health}`, {
      headers: { ...auth, origin: "http://evil.example" },
    });

    const socket = await TestSocket.open(
      `ws://127.0.0.1:${daemon.port}${API_ROUTES.ws}?token=${token}`,
    );
    await socket.next("hello");
    socket.send({ type: "hello", clientId: "tab_a" });
    socket.send(`{"broken":${token}`);
    socket.send({ type: "surface.subscribe", threadId: token, surface: "browser" });
    socket.send({ type: "editor.activity", notePath: `${apiKey}.md`, line: 1 });
    await socket.barrier();
    socket.ws.close();
    expect(
      await upgradeOutcome(`ws://127.0.0.1:${daemon.port}${API_ROUTES.ws}?token=${flipped}`),
    ).toBe("HTTP 401");

    await daemon.close();
    daemon = undefined;

    expect(external).toEqual([]);
    expect(keyChecks).toEqual([`GET /api/v1/key Bearer ${apiKey}`]);
    expect(lines.some((line) => line.includes("Request failed"))).toBe(true);
    const leaks = lines.filter((line) =>
      [token, flipped, apiKey, otherSecret].some((secret) => line.includes(secret)),
    );
    expect(leaks).toEqual([]);
  });

  // BUG (errors.ts, not owned here): 500s are logged with `error.stack`, whose frames carry absolute
  // file paths (e.g. /Users/<name>/…), and file-system errors carry absolute vault paths in their
  // message. home-paths.ts promises logs never contain the user name (paths are `~`-abbreviated).
  // Expected: no absolute paths under the home directory or of the daemon's own sources.
  it.fails("never contain absolute paths of the daemon's sources or the user's home", async () => {
    const vault = tempDir("ddl-logging-paths-");
    try {
      const logger = new RecordingLogger();
      const app = await createTestApp({
        storage: new LocalFsStorageProvider({ root: vault.path }),
        logger,
      });
      await app.storage.write("a.md", "a file");
      const res = await app.request(API_ROUTES.note("a.md/b.md"), {
        method: "PUT",
        json: { content: "x" },
      });
      expect(res.status).toBe(500);
      const errors = logger.lines.filter((line) => line.startsWith("error"));
      expect(errors.length).toBeGreaterThan(0);
      for (const line of errors) {
        expect(line).not.toContain(import.meta.dirname.replace(/[/\\]src[/\\]security$/, ""));
        expect(line).not.toContain(homedir());
      }
    } finally {
      vault.cleanup();
    }
  });
});
