import { readFileSync } from "node:fs";
import { join } from "node:path";
import { API_ROUTES, type HealthResponse, silentLogger } from "@ddl/core";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { loadConfig } from "./config";
import { type RunningDaemon, startDaemon } from "./server";
import { tempDir } from "./test-helpers";

let dir: { path: string; cleanup: () => void } | undefined;
let daemon: RunningDaemon | undefined;

afterEach(async () => {
  await daemon?.close();
  daemon = undefined;
  dir?.cleanup();
});

async function start(): Promise<{ daemon: RunningDaemon; token: string; vault: string }> {
  dir = tempDir("ddl-server-");
  const vault = join(dir.path, "vault");
  const env = {
    DDL_HOME: join(dir.path, "home"),
    DDL_VAULT: vault,
    DDL_WEB_DIST: join(dir.path, "no-web-build"),
    DDL_AGENT_MODE: "off",
    DDL_PORT: "0",
  };
  const config = loadConfig({ env, cwd: dir.path, homedir: dir.path, platform: "darwin" });
  daemon = await startDaemon({ config, env, logger: silentLogger });
  return { daemon, token: readFileSync(config.tokenPath, "utf8").trim(), vault };
}

describe("startDaemon", () => {
  it("serves an authenticated API over the local vault on 127.0.0.1", async () => {
    const { daemon, token, vault } = await start();
    expect(daemon.url).toBe(`http://127.0.0.1:${daemon.port}`);
    const auth = { authorization: `Bearer ${token}` };

    expect((await fetch(`${daemon.url}${API_ROUTES.health}`)).status).toBe(401);
    const health = await fetch(`${daemon.url}${API_ROUTES.health}`, { headers: auth });
    expect(((await health.json()) as HealthResponse).agentMode).toBe("off");

    const put = await fetch(`${daemon.url}${API_ROUTES.note("Inbox/Idea.md")}`, {
      method: "PUT",
      headers: { ...auth, "content-type": "application/json" },
      body: JSON.stringify({ content: "- [ ] Water the plants", baseVersion: null }),
    });
    expect(put.status).toBe(201);
    expect(readFileSync(join(vault, "Inbox/Idea.md"), "utf8")).toBe("- [ ] Water the plants");

    const hello = await new Promise<string>((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${daemon.port}${API_ROUTES.ws}?token=${token}`);
      ws.once("message", (data) => {
        resolve(String(data));
        ws.close();
      });
      ws.once("error", reject);
    });
    expect(JSON.parse(hello)).toMatchObject({ type: "hello" });
  });

  it("releases the port on close", async () => {
    const { daemon } = await start();
    const { port } = daemon;
    await daemon.close();
    await expect(fetch(`http://127.0.0.1:${port}${API_ROUTES.health}`)).rejects.toThrow();
  });
});
