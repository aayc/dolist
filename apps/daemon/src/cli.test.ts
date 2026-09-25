import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { API_ROUTES, silentLogger } from "@ddl/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type CliIo, runCli } from "./cli";
import { loadConfig } from "./config";
import { type RunningDaemon, startDaemon } from "./server";
import { tempDir } from "./test-helpers";

const REMOTE = "vm-name.tailnet-name.ts.net";
const daemonDir = fileURLToPath(new URL("..", import.meta.url));

let dir: { path: string; cleanup: () => void };
let daemon: RunningDaemon | undefined;
let token: string;
let env: Record<string, string>;

beforeEach(() => {
  dir = tempDir("ddl-cli-");
  token = "";
  env = {
    DDL_HOME: join(dir.path, "home"),
    DDL_VAULT: join(dir.path, "vault"),
    DDL_WEB_DIST: join(dir.path, "no-web-build"),
    DDL_AGENT_MODE: "off",
    DDL_PORT: "0",
  };
});

afterEach(async () => {
  await daemon?.close();
  daemon = undefined;
  dir.cleanup();
});

/** A daemon over this test's home, answering to `remoteHosts`; the CLI's env points at it. */
async function start(remoteHosts = REMOTE): Promise<RunningDaemon> {
  const daemonEnv = { ...env, DDL_REMOTE_HOSTS: remoteHosts };
  const config = loadConfig({ env: { ...daemonEnv }, cwd: dir.path, homedir: dir.path });
  daemon = await startDaemon({ config, env: daemonEnv, logger: silentLogger });
  env.DDL_PORT = String(daemon.port);
  token = readFileSync(config.tokenPath, "utf8").trim();
  return daemon;
}

async function cli(args: string[], overrides: Record<string, string> = {}) {
  let stdout = "";
  let stderr = "";
  const io: CliIo = {
    env: { ...env, ...overrides },
    stdout: (text) => {
      stdout += text;
    },
    stderr: (text) => {
      stderr += text;
    },
    config: { cwd: dir.path, homedir: dir.path },
  };
  const code = await runCli(args, io);
  if (token) expect(`${stdout}${stderr}`).not.toContain(token);
  return { code, stdout, stderr };
}

function codeIn(stdout: string): string {
  const match = /Pairing code: ([2-9A-Z]{4})-([2-9A-Z]{4})/.exec(stdout);
  if (!match) throw new Error(`no code in ${stdout}`);
  return `${match[1]}${match[2]}`;
}

async function pairWith(code: string, name = "Laptop") {
  const res = await fetch(`${daemon!.url}${API_ROUTES.pair}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ code, name, kind: "daemon" }),
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

describe("pair", () => {
  it("prints a code the daemon accepts, its expiry and the URL", async () => {
    await start();
    const { code, stdout, stderr } = await cli(["pair", "--name", "Work laptop"]);
    expect(code).toBe(0);
    expect(stderr).toBe("");
    expect(stdout).toMatch(/^Pairing code: [2-9A-Z]{4}-[2-9A-Z]{4}\n/);
    expect(stdout).toMatch(/Valid once, until \d\d:\d\d \(5 minutes\)\./);
    expect(stdout).toContain(`open https://${REMOTE} `);
    const paired = await pairWith(codeIn(stdout));
    expect(paired.status).toBe(201);
    expect(paired.body).toMatchObject({ device: { name: "Work laptop", kind: "daemon" } });
  });

  it("accepts --name=… and no name at all", async () => {
    await start();
    const named = await cli(["pair", "--name=Phone"]);
    expect(named.code).toBe(0);
    expect((await pairWith(codeIn(named.stdout), "x")).body).toMatchObject({
      device: { name: "Phone" },
    });
    const unnamed = await cli(["pair"]);
    expect((await pairWith(codeIn(unnamed.stdout), "Tablet")).body).toMatchObject({
      device: { name: "Tablet" },
    });
  });

  it("says when the daemon has no remote host yet", async () => {
    await start("");
    const { code, stdout } = await cli(["pair"]);
    expect(code).toBe(0);
    expect(stdout).toMatch(/no remote hosts yet[\s\S]*remote\.hosts in ~\/home\/config\.json/);
  });

  it("passes on the daemon's refusal when too many codes are waiting", async () => {
    await start();
    for (let i = 0; i < 3; i++) expect((await cli(["pair"])).code).toBe(0);
    const refused = await cli(["pair"]);
    expect(refused.code).toBe(1);
    expect(refused.stderr).toMatch(/pairing codes are already waiting/);
  });

  it("refuses bad arguments with the usage, before calling the daemon", async () => {
    for (const args of [
      ["pair", "--name"],
      ["pair", "--name", "  "],
      ["pair", "extra"],
    ]) {
      const { code, stderr } = await cli(args);
      expect(code, args.join(" ")).toBe(2);
      expect(stderr).toMatch(/--name|Usage/);
    }
  });
});

describe("devices and revoke", () => {
  it("lists paired devices and revokes one", async () => {
    await start();
    expect((await cli(["devices"])).stdout).toBe("No devices are paired with this daemon.\n");
    const issued = await cli(["pair", "--name", "Old phone"]);
    const paired = (await pairWith(codeIn(issued.stdout))).body as {
      device: { id: string };
      token: string;
    };
    const listed = await cli(["devices"]);
    expect(listed.code).toBe(0);
    expect(listed.stdout).toMatch(/^NAME\s+KIND\s+PAIRED\s+LAST SEEN\s+ID\n/);
    expect(listed.stdout).toMatch(
      new RegExp(
        `Old phone\\s+daemon\\s+\\d{4}-\\d\\d-\\d\\d \\d\\d:\\d\\d\\s+never\\s+${paired.device.id}\\n$`,
      ),
    );
    expect(listed.stdout).not.toContain(paired.token);

    expect(await cli(["revoke", paired.device.id])).toMatchObject({
      code: 0,
      stdout: `Revoked ${paired.device.id}.\n`,
    });
    const auth = { authorization: `Bearer ${paired.token}` };
    expect((await fetch(`${daemon!.url}${API_ROUTES.tree}`, { headers: auth })).status).toBe(401);
    expect((await cli(["devices"])).stdout).not.toContain(paired.device.id);
    expect(await cli(["revoke", paired.device.id])).toMatchObject({
      code: 1,
      stderr: "Unknown device\n",
    });
    expect((await cli(["revoke"])).code).toBe(2);
    expect((await cli(["devices", "extra"])).code).toBe(2);
  });
});

describe("failures", () => {
  it("explains a missing token, a stopped daemon and an unknown command", async () => {
    const missing = await cli(["pair"], { DDL_PORT: String(await freePort()) });
    expect(missing.code).toBe(1);
    expect(missing.stderr).toMatch(/no daemon token at ~\/home\/daemon-token/);

    await start();
    const closed = await freePort();
    const stopped = await cli(["pair"], { DDL_PORT: String(closed) });
    expect(stopped.code).toBe(1);
    expect(stopped.stderr).toMatch(new RegExp(`isn't answering on 127\\.0\\.0\\.1:${closed}`));

    expect((await cli(["pair"], { DDL_PORT: "0" })).stderr).toMatch(/set DDL_PORT/);

    const unknown = await cli(["serve"]);
    expect(unknown.code).toBe(2);
    expect(unknown.stderr).toMatch(/Unknown command "serve"[\s\S]*Usage/);
    expect(await cli(["help"])).toMatchObject({ code: 0, stdout: expect.stringMatching(/^Usage/) });
  });
});

describe("the entry point", () => {
  it("runs `main.js pair` as a subcommand and exits with its code", async () => {
    await start();
    const run = promisify(execFile);
    const childEnv = { ...env, HOME: dir.path, PATH: process.env.PATH ?? "" };
    const { stdout } = await run(
      process.execPath,
      ["--import", "tsx", "src/main.ts", "pair", "--name", "From the entry point"],
      { cwd: daemonDir, env: childEnv },
    );
    expect(stdout).toMatch(/^Pairing code: /);
    expect(stdout).not.toContain(token);
    const failed = await run(process.execPath, ["--import", "tsx", "src/main.ts", "nope"], {
      cwd: daemonDir,
      env: childEnv,
    }).catch((error: { code: number; stderr: string }) => error);
    expect(failed).toMatchObject({ code: 2, stderr: expect.stringMatching(/Unknown command/) });
  }, 30_000);
});

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}
