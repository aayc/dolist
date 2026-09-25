import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runCli } from "./cli";
import type { RunningSyncServer } from "./server";
import { SyncStore } from "./store";

let dir: string;
let db: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "ddl-sync-cli-"));
  db = join(dir, "sync.db");
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function cli(...argv: string[]) {
  let stdout = "";
  let stderr = "";
  const code = await runCli(argv, {
    stdout: (text) => {
      stdout += text;
    },
    stderr: (text) => {
      stderr += text;
    },
  });
  return { code, stdout, stderr };
}

describe("ddl-sync vault", () => {
  it("creates a vault and shows its token once", async () => {
    const created = await cli("vault", "create", "--name", "Personal", "--db", db);
    expect(created.code).toBe(0);
    const id = /Vault id: (\S+)/.exec(created.stdout)?.[1];
    const token = /Token: {4}(\S+)/.exec(created.stdout)?.[1];
    expect(id).toMatch(/^v_[0-9a-z]{20}$/);
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(created.stdout).toContain("shown only this once");

    const store = new SyncStore(db);
    try {
      expect(store.authenticate(id!, token!)).not.toBeNull();
    } finally {
      store.close();
    }
    const listed = await cli("vault", "list", "--db", db);
    expect(listed.stdout).toContain(id);
    expect(listed.stdout).toContain("Personal");
    expect(listed.stdout).not.toContain(token);
    const raw = readFileSync(db);
    expect(raw.includes(Buffer.from(token!))).toBe(false);
  });

  it("prints JSON for scripts", async () => {
    const created = JSON.parse(
      (await cli("vault", "create", "--name", "Work", "--db", db, "--json")).stdout,
    );
    expect(created).toEqual({ vault: expect.stringMatching(/^v_/), token: expect.any(String) });
    const listed = JSON.parse((await cli("vault", "list", "--db", db, "--json")).stdout);
    expect(listed).toEqual([
      {
        id: created.vault,
        name: "Work",
        createdAt: expect.any(Number),
        lastSeq: 0,
        files: 0,
        bytes: 0,
      },
    ]);
  });

  it("rotates a token: the old one stops working", async () => {
    const { vault, token } = JSON.parse(
      (await cli("vault", "create", "--name", "A", "--db", db, "--json")).stdout,
    );
    const rotated = JSON.parse(
      (await cli("vault", "rotate-token", "--vault", vault, "--db", db, "--json")).stdout,
    );
    expect(rotated.token).not.toBe(token);
    const store = new SyncStore(db);
    try {
      expect(store.authenticate(vault, token)).toBeNull();
      expect(store.authenticate(vault, rotated.token)).not.toBeNull();
    } finally {
      store.close();
    }
    expect(await cli("vault", "rotate-token", "--vault", "v_nope", "--db", db)).toMatchObject({
      code: 1,
      stderr: expect.stringContaining('No vault with id "v_nope"'),
    });
  });

  it("explains its usage", async () => {
    expect(await cli("vault", "create", "--name", "A")).toMatchObject({
      code: 2,
      stderr: expect.stringContaining("--db is required"),
    });
    expect(await cli("vault", "create", "--db", db, "--name", "  ")).toMatchObject({ code: 2 });
    expect(await cli("vault", "explode", "--db", db)).toMatchObject({ code: 2 });
    expect(await cli("frobnicate")).toMatchObject({
      code: 2,
      stderr: expect.stringContaining("Usage"),
    });
    expect(await cli("serve", "--db", db, "--port", "99999")).toMatchObject({ code: 2 });
    expect(await cli("serve", "--db", db, "--bogus")).toMatchObject({ code: 2 });
    expect(await cli("--help")).toMatchObject({
      code: 0,
      stdout: expect.stringContaining("Usage"),
    });
  });
});

describe("ddl-sync serve", () => {
  it("serves on loopback until told to stop", async () => {
    const { vault, token } = JSON.parse(
      (await cli("vault", "create", "--name", "A", "--db", db, "--json")).stdout,
    );
    const controller = new AbortController();
    let server: RunningSyncServer | undefined;
    let stdout = "";
    const running = runCli(
      ["serve", "--db", db, "--port", "0", "--log-level", "warn"],
      { stdout: (text) => (stdout += text), stderr: () => {} },
      {
        signal: controller.signal,
        onListening: (s) => {
          server = s;
        },
      },
    );
    await expect.poll(() => server).toBeDefined();
    expect(server!.host).toBe("127.0.0.1");
    expect(stdout).toContain(`listening on ${server!.url}`);
    const health = await fetch(`${server!.url}/v1/health`);
    expect(health.status).toBe(200);
    const files = await fetch(`${server!.url}/v1/vaults/${vault}/files`, {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(await files.json()).toEqual({ files: [], seq: 0 });

    controller.abort();
    expect(await running).toBe(0);
    await expect(fetch(`${server!.url}/v1/health`)).rejects.toThrow();
  });
});
