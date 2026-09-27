import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { API_ROUTES, type HealthResponse, silentLogger, WORKSPACE_ID_HEADER } from "@ddl/core";
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

async function start(): Promise<{
  daemon: RunningDaemon;
  token: string;
  vault: string;
  env: Record<string, string>;
}> {
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
  return { daemon, token: readFileSync(config.tokenPath, "utf8").trim(), vault, env };
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

  it("recovers a lost capture response after a real daemon restart and rejects its old context when that host opens another vault", async () => {
    const first = await start();
    const auth = { authorization: `Bearer ${first.token}` };
    const health = (await (
      await fetch(`${first.daemon.url}${API_ROUTES.health}`, { headers: auth })
    ).json()) as HealthResponse;
    expect(health.workspaceId).toBeDefined();
    expect(health.hostId).toBeDefined();
    const headers = {
      ...auth,
      "content-type": "application/json",
      [WORKSPACE_ID_HEADER]: health.workspaceId!,
    };
    const body = JSON.stringify({
      operationId: "capture_restart",
      hostId: health.hostId,
      text: "- [ ] A synthetic capture",
      capturedAt: 1,
      timeZone: "UTC",
    });
    const response = await fetch(`${first.daemon.url}${API_ROUTES.dailyAppend("2026-09-27")}`, {
      method: "POST",
      headers,
      body,
    });
    expect(response.status).toBe(200);
    await response.body?.cancel(); // The client never learns the saved base.
    await first.daemon.close();
    const notePath = join(first.vault, "Daily/2026-09-27.md");
    const saved = readFileSync(notePath, "utf8");
    writeFileSync(notePath, `${saved}Later words from another editor\n`);
    daemon = await startDaemon({
      config: first.daemon.config,
      env: first.env,
      logger: silentLogger,
    });
    const retry = await fetch(`${daemon.url}${API_ROUTES.dailyAppend("2026-09-27")}`, {
      method: "POST",
      headers,
      body,
    });
    expect(retry.status).toBe(200);
    const receipt = await retry.json();
    expect(receipt.outcome).toBe("applied");
    expect(receipt.note.content).toBe(saved);
    expect(readFileSync(notePath, "utf8")).toBe(`${saved}Later words from another editor\n`);
    await daemon.close();
    daemon = await startDaemon({
      config: { ...first.daemon.config, vaultPath: join(dir!.path, "other-vault") },
      env: first.env,
      logger: silentLogger,
    });
    const refused = await fetch(`${daemon.url}${API_ROUTES.dailyAppend("2026-09-27")}`, {
      method: "POST",
      headers,
      body,
    });
    expect(refused.status).toBe(412);
    expect((await refused.json()).error).toBe("workspace_mismatch");
  });

  it("releases the port on close", async () => {
    const { daemon } = await start();
    const { port } = daemon;
    await daemon.close();
    await expect(fetch(`http://127.0.0.1:${port}${API_ROUTES.health}`)).rejects.toThrow();
  });
});
