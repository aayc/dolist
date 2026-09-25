import { mkdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_MODEL } from "@ddl/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ConfigError, DEFAULT_PORT, loadConfig, summarizeConfig } from "./config";
import { tempDir } from "./test-helpers";

let root: { path: string; cleanup: () => void };
let homedir: string;
let cwd: string;
let ddlHome: string;

beforeEach(() => {
  root = tempDir("ddl-config-");
  homedir = join(root.path, "home");
  cwd = join(root.path, "work");
  ddlHome = join(root.path, "state");
  mkdirSync(homedir);
  mkdirSync(cwd);
});

afterEach(() => root.cleanup());

function load(
  env: Record<string, string | undefined> = {},
  platform: NodeJS.Platform = "darwin",
  executables: readonly string[] = [],
) {
  return loadConfig({
    env: { DDL_HOME: ddlHome, ...env },
    cwd,
    homedir,
    platform,
    entryScript: join(root.path, "daemon", "dist", "main.js"),
    isExecutable: (path) => executables.includes(path),
  });
}

describe("loadConfig", () => {
  it("uses defaults and creates DDL_HOME with mode 0700", () => {
    const config = load();
    expect(config).toMatchObject({
      home: ddlHome,
      vaultPath: join(homedir, "DailyDoList"),
      port: DEFAULT_PORT,
      agentMode: "live",
      model: DEFAULT_MODEL,
      sync: { kind: "none" },
      execution: {
        kind: "local",
        home: ddlHome,
        browser: { headless: true },
        computer: { enabled: true },
      },
      allowedOrigins: [],
      logLevel: "info",
      tokenPath: join(ddlHome, "daemon-token"),
      mcpConfigPath: join(ddlHome, "mcp.json"),
    });
    expect(config.webDist).toMatch(/web[/\\]dist$/);
    expect(statSync(ddlHome).mode & 0o777).toBe(0o700);
  });

  it("gives computer use the helper it finds, unless computer use is off", () => {
    const bundled = join(root.path, "daemon", "bin", "ddl-computer");
    const config = load({}, "darwin", [bundled]);
    expect(config.execution).toMatchObject({ computer: { enabled: true, helper: bundled } });
    expect(config.computerHelper).toEqual({ path: bundled, source: "bundled" });
    expect(summarizeConfig(config, homedir).computerHelper).toBe(`${bundled} (bundled)`);

    expect(load({}, "darwin").execution).toEqual(
      expect.objectContaining({ computer: { enabled: true } }),
    );
    expect(summarizeConfig(load({ DDL_COMPUTER_HELPER: "/nope" }), homedir).computerHelper).toMatch(
      /not an executable/,
    );

    mkdirSync(ddlHome, { recursive: true });
    writeFileSync(
      join(ddlHome, "config.json"),
      JSON.stringify({ execution: { kind: "local", computer: { enabled: false } } }),
    );
    expect(load({}, "darwin", [bundled]).execution).toMatchObject({
      computer: { enabled: false },
    });
    expect(
      (load({}, "darwin", [bundled]).execution as { computer?: object }).computer,
    ).not.toHaveProperty("helper");
  });

  it("defaults DDL_HOME to ~/.daily-do-list and disables computer use off macOS", () => {
    const config = loadConfig({ env: {}, cwd, homedir, platform: "linux" });
    expect(config.home).toBe(join(homedir, ".daily-do-list"));
    expect(config.execution).toMatchObject({ computer: { enabled: false } });
  });

  it("reads config.json and lets env vars win", () => {
    mkdirSync(ddlHome);
    writeFileSync(
      join(ddlHome, "config.json"),
      JSON.stringify({
        vaultPath: "~/Notes",
        port: 8000,
        agentMode: "mock",
        model: "vendor/file-model",
        sync: { kind: "local", root: "~/iCloud/Vault" },
        execution: {
          kind: "local",
          browser: { channel: "chromium" },
          computer: { enabled: false },
        },
        allowedOrigins: ["http://localhost:5174/", "TAURI://localhost"],
        webDist: "web",
      }),
    );
    const fromFile = load();
    expect(fromFile).toMatchObject({
      vaultPath: join(homedir, "Notes"),
      port: 8000,
      agentMode: "mock",
      model: "vendor/file-model",
      sync: { kind: "local", root: join(homedir, "iCloud/Vault") },
      execution: { browser: { headless: true, channel: "chromium" }, computer: { enabled: false } },
      allowedOrigins: ["http://localhost:5174", "tauri://localhost"],
      webDist: join(ddlHome, "web"),
    });

    const fromEnv = load({
      DDL_VAULT: "vault",
      DDL_PORT: "0",
      DDL_AGENT_MODE: "OFF",
      DDL_MODEL: "vendor/env-model",
      DDL_WEB_DIST: "~/dist",
      DDL_LOG_LEVEL: "debug",
    });
    expect(fromEnv).toMatchObject({
      vaultPath: join(cwd, "vault"),
      port: 0,
      agentMode: "off",
      model: "vendor/env-model",
      webDist: join(homedir, "dist"),
      logLevel: "debug",
    });
  });

  it("loads $DDL_HOME/.env before .env.local without overriding the environment", () => {
    mkdirSync(ddlHome);
    writeFileSync(join(ddlHome, ".env"), "OPENROUTER_API_KEY=from-home\nDDL_PORT=7400\n");
    writeFileSync(
      join(cwd, ".env.local"),
      "OPENROUTER_API_KEY=from-local\nDDL_MODEL=vendor/local\n",
    );
    const env: Record<string, string | undefined> = {
      DDL_HOME: ddlHome,
      DDL_MODEL: "vendor/shell",
    };
    const config = loadConfig({ env, cwd, homedir, platform: "darwin" });
    expect(env.OPENROUTER_API_KEY).toBe("from-home");
    expect(config.port).toBe(7400);
    expect(config.model).toBe("vendor/shell");
    expect(config.envFiles).toEqual([join(ddlHome, ".env"), join(cwd, ".env.local")]);
  });

  it("reports invalid configuration clearly", () => {
    expect(() => load({ DDL_PORT: "http" })).toThrow(ConfigError);
    expect(() => load({ DDL_PORT: "70000" })).toThrow(/DDL_PORT/);
    expect(() => load({ DDL_AGENT_MODE: "turbo" })).toThrow(/DDL_AGENT_MODE/);

    mkdirSync(ddlHome, { recursive: true });
    const file = join(ddlHome, "config.json");
    writeFileSync(file, "{ nope");
    expect(() => load()).toThrow(/not valid JSON/);
    writeFileSync(file, JSON.stringify({ vaultpath: "~/typo" }));
    expect(() => load()).toThrow(/vaultpath/);
    writeFileSync(file, JSON.stringify({ allowedOrigins: ["http://localhost:5174/app"] }));
    expect(() => load()).toThrow(/allowedOrigins/);
    writeFileSync(
      file,
      JSON.stringify({
        execution: { kind: "cloud", endpoint: "https://x.example", apiKeyEnv: "sk-123" },
      }),
    );
    expect(() => load()).toThrow(/NAME of an environment variable/);
  });

  it("summarizes without secrets or the username", () => {
    const config = loadConfig({
      env: { OPENROUTER_API_KEY: "secret-value" },
      cwd,
      homedir,
      platform: "darwin",
    });
    const summary = JSON.stringify(summarizeConfig(config, homedir));
    expect(summary).toContain('"vault":"~/DailyDoList"');
    expect(summary).toContain('"home":"~/.daily-do-list"');
    expect(summary).not.toContain("secret-value");
    expect(summary).not.toContain(homedir);
  });
});
