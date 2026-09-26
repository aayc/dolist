import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { prepareDemo } from "./demo-vault";
import { tempDir } from "./test-helpers";

describe("prepareDemo (DDL_DEMO=1)", () => {
  const dirs: Array<{ cleanup: () => void }> = [];
  const root = () => {
    const dir = tempDir("ddl-demo-test-");
    dirs.push(dir);
    return dir.path;
  };
  afterEach(() => {
    for (const dir of dirs.splice(0)) dir.cleanup();
  });

  it("seeds a new vault with the demo vault and turns computer use off", async () => {
    const at = root();
    const env = { DDL_HOME: join(at, "home"), DDL_VAULT: join(at, "vault") };
    await prepareDemo(env);
    expect(existsSync(join(env.DDL_VAULT, "Welcome.md"))).toBe(true);
    expect(
      JSON.parse(readFileSync(join(env.DDL_VAULT, ".daily-do-list/settings.json"), "utf8")),
    ).toEqual({ version: 1, agent: { settleMs: 1200 } });
    expect(JSON.parse(readFileSync(join(env.DDL_HOME, "config.json"), "utf8"))).toEqual({
      execution: { kind: "local", computer: { enabled: false } },
    });
  });

  it("never writes into an existing vault or over a config, and needs both folders", async () => {
    const at = root();
    const env = { DDL_HOME: join(at, "home"), DDL_VAULT: join(at, "vault") };
    mkdirSync(env.DDL_VAULT);
    mkdirSync(env.DDL_HOME);
    writeFileSync(join(env.DDL_HOME, "config.json"), "{}\n");
    await prepareDemo(env);
    expect(existsSync(join(env.DDL_VAULT, "Welcome.md"))).toBe(false);
    expect(readFileSync(join(env.DDL_HOME, "config.json"), "utf8")).toBe("{}\n");

    await expect(prepareDemo({ DDL_VAULT: join(at, "other") })).rejects.toThrow("DDL_HOME");
    await expect(prepareDemo({ DDL_HOME: env.DDL_HOME, DDL_VAULT: "vault" })).rejects.toThrow(
      "absolute",
    );
    expect(existsSync(join(at, "other"))).toBe(false);
  });
});
