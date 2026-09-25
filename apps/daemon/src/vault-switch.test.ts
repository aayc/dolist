import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { silentLogger } from "@ddl/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { jsonObjectFile } from "./home-files";
import { RESTART_EXIT_CODE, VaultSwitch, type VaultSwitchOptions } from "./vault-switch";

let dir: string;
let home: string;
let current: string;
let next: string;
let restarts: string[];

beforeEach(async () => {
  dir = await realpath(await mkdtemp(join(tmpdir(), "ddl-vault-switch-")));
  home = join(dir, "home");
  current = join(dir, "DailyDoList");
  next = join(dir, "Imported");
  for (const folder of [home, current, next]) await mkdir(folder);
  await writeFile(join(home, "config.json"), `${JSON.stringify({ port: 7400 })}\n`);
  restarts = [];
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function vaultSwitch(overrides: Partial<VaultSwitchOptions> = {}): VaultSwitch {
  return new VaultSwitch({
    vaultPath: current,
    lockedByEnv: false,
    supervised: true,
    config: jsonObjectFile(join(home, "config.json")),
    home,
    homedir: dir,
    restart: (path) => restarts.push(path),
    logger: silentLogger,
    ...overrides,
  });
}

async function config(): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(join(home, "config.json"), "utf8"));
}

/** Lets the restart scheduled after the answer run. */
const afterAnswer = () => new Promise((resolve) => setImmediate(resolve));

describe("switching vaults", () => {
  it("writes vaultPath to config.json, answers, then restarts", async () => {
    const vault = vaultSwitch();
    expect(vault.response()).toEqual({ path: current, lockedByEnv: false });
    const answer = await vault.switchTo(next);
    expect(answer).toEqual({ path: next, lockedByEnv: false, restart: "supervisor" });
    expect(restarts).toEqual([]);
    await afterAnswer();
    expect(restarts).toEqual([next]);
    expect(await config()).toEqual({ port: 7400, vaultPath: next });
  });

  it("tells a daemon without a supervisor that the user starts it again", async () => {
    expect(await vaultSwitch({ supervised: false }).switchTo("~/Imported")).toMatchObject({
      path: next,
      restart: "manual",
    });
  });

  it("stores the real path of a vault reached through a link", async () => {
    await symlink(next, join(dir, "shortcut"));
    expect((await vaultSwitch().switchTo(join(dir, "shortcut"))).path).toBe(next);
  });

  it("does nothing for the vault it already opens", async () => {
    expect(await vaultSwitch().switchTo(`${current}/`)).toEqual({
      path: current,
      lockedByEnv: false,
    });
    await afterAnswer();
    expect(restarts).toEqual([]);
    expect(await config()).toEqual({ port: 7400 });
  });

  it("refuses when DDL_VAULT sets the vault", async () => {
    const vault = vaultSwitch({ lockedByEnv: true });
    expect(vault.response()).toEqual({ path: current, lockedByEnv: true });
    await expect(vault.switchTo(next)).rejects.toMatchObject({
      status: 409,
      code: "locked_by_env",
    });
    expect(await config()).toEqual({ port: 7400 });
  });

  it("refuses while something blocks it, and says what", async () => {
    const vault = vaultSwitch({ blocked: () => "An import from Obsidian is running" });
    await expect(vault.switchTo(next)).rejects.toMatchObject({
      status: 409,
      code: "conflict",
      message: "An import from Obsidian is running",
    });
    expect(await config()).toEqual({ port: 7400 });
  });

  it("refuses a second switch while restarting", async () => {
    const vault = vaultSwitch({ restart: () => {} });
    await vault.switchTo(next);
    await expect(vault.switchTo(current)).rejects.toMatchObject({ status: 409 });
  });

  it.each([
    ["a relative path", () => "Imported", /absolute path/],
    ["a missing folder", () => join(dir, "missing"), /There's no folder/],
    ["a file", () => join(dir, "file.md"), /isn't a folder/],
    ["Daily Do List's own folder", () => home, /own folder/],
    ["a folder inside it", () => join(home, "vault"), /own folder/],
    ["a folder holding it", () => dir, /own folder/],
  ])("refuses %s", async (_name, path, message) => {
    await writeFile(join(dir, "file.md"), "x");
    await mkdir(join(home, "vault"));
    await expect(vaultSwitch().switchTo(path())).rejects.toMatchObject({
      status: 400,
      code: "invalid_request",
      message: expect.stringMatching(message),
    });
    expect(await config()).toEqual({ port: 7400 });
  });

  it("doesn't restart when config.json can't be written", async () => {
    await writeFile(join(home, "config.json"), "{ not json");
    const vault = vaultSwitch();
    await expect(vault.switchTo(next)).rejects.toThrow(/not valid JSON/);
    await afterAnswer();
    expect(restarts).toEqual([]);
  });
});

describe("the restart exit code", () => {
  it("is EX_TEMPFAIL, the one the Mac app's supervisor restarts on", () => {
    expect(RESTART_EXIT_CODE).toBe(75);
  });
});
