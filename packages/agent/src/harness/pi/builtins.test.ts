import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ShellExecOptions, ShellExecutor, ShellResult } from "../../execution/types";
import { createBashOperations, createBuiltinTools } from "./builtins";
import { createWorkspaceFs } from "./workspace-fs";

function shell(
  impl: (command: string, options: ShellExecOptions) => Promise<Partial<ShellResult>>,
) {
  const exec = vi.fn(
    async (command: string, options: ShellExecOptions): Promise<ShellResult> => ({
      exitCode: 0,
      output: "",
      timedOut: false,
      truncated: false,
      durationMs: 5,
      ...(await impl(command, options)),
    }),
  );
  return { exec } satisfies ShellExecutor;
}

function collect() {
  const chunks: string[] = [];
  return { chunks, onData: (data: Buffer) => chunks.push(data.toString("utf8")) };
}

describe("createBashOperations", () => {
  it("streams output, maps options and never forwards Pi's environment", async () => {
    const executor = shell(async (_command, options) => {
      options.onData?.("line 1\n");
      options.onData?.("line 2\n");
      return { exitCode: 3, output: "line 1\nline 2\n" };
    });
    const { chunks, onData } = collect();
    const signal = new AbortController().signal;
    const result = await createBashOperations(executor).exec("make test", "/work", {
      onData,
      signal,
      timeout: 1.5,
      env: { OPENROUTER_API_KEY: "should-not-leak" },
    });
    expect(result).toEqual({ exitCode: 3 });
    expect(chunks.join("")).toBe("line 1\nline 2\n");
    const [command, options] = executor.exec.mock.calls[0] ?? [];
    expect(command).toBe("make test");
    expect(options).toMatchObject({ cwd: "/work", timeoutMs: 1500, signal });
    expect(options).not.toHaveProperty("env");
  });

  it("replays buffered output when the executor does not stream", async () => {
    const { chunks, onData } = collect();
    await createBashOperations(shell(async () => ({ output: "all at once" }))).exec("x", "/w", {
      onData,
    });
    expect(chunks).toEqual(["all at once"]);
  });

  it("reports timeouts and aborts in the form Pi's bash tool expects", async () => {
    const { onData } = collect();
    const timedOut = createBashOperations(shell(async () => ({ timedOut: true, exitCode: null })));
    await expect(timedOut.exec("sleep 9", "/w", { onData, timeout: 2 })).rejects.toThrow(
      "timeout:2",
    );

    const controller = new AbortController();
    const aborting = createBashOperations(
      shell(async () => {
        controller.abort();
        throw new Error("killed");
      }),
    );
    await expect(
      aborting.exec("sleep 9", "/w", { onData, signal: controller.signal }),
    ).rejects.toThrow(/^aborted$/);
    await expect(
      createBashOperations(shell(async () => ({}))).exec("x", "/w", { onData, timeout: -1 }),
    ).rejects.toThrow(/Invalid timeout/);
  });

  it("passes through a missing exit code (signal-killed process)", async () => {
    const { onData } = collect();
    const result = await createBashOperations(shell(async () => ({ exitCode: null }))).exec(
      "x",
      "/w",
      {
        onData,
      },
    );
    expect(result).toEqual({ exitCode: null });
  });
});

describe("createBuiltinTools", () => {
  const names = (defs: Array<{ name: string }>) => defs.map((d) => d.name);
  const executor = shell(async () => ({}));

  it("creates nothing unless asked", () => {
    expect(createBuiltinTools({ cwd: "/w", builtins: undefined })).toEqual([]);
    expect(createBuiltinTools({ cwd: "/w", builtins: { files: false } })).toEqual([]);
  });

  it("mirrors Pi's coding and read-only tool sets", () => {
    expect(
      names(createBuiltinTools({ cwd: "/w", builtins: { files: true, shell: executor } })),
    ).toEqual(["read", "write", "edit", "bash"]);
    expect(
      names(
        createBuiltinTools({
          cwd: "/w",
          builtins: { files: true, readOnly: true, shell: executor },
          ripgrepAvailable: () => true,
        }),
      ),
    ).toEqual(["read", "grep", "find", "ls"]);
    expect(
      names(
        createBuiltinTools({
          cwd: "/w",
          builtins: { files: true, readOnly: true },
          ripgrepAvailable: () => false,
        }),
      ),
    ).toEqual(["read", "find", "ls"]);
    expect(
      names(createBuiltinTools({ cwd: "/w", builtins: { files: false, shell: executor } })),
    ).toEqual(["bash"]);
  });
});

describe("createWorkspaceFs", () => {
  let base: string;
  let root: string;

  beforeEach(async () => {
    base = await mkdtemp(path.join(tmpdir(), "ddl-wsfs-"));
    root = path.join(base, "workspace");
    await mkdir(path.join(root, "sub"), { recursive: true });
    await writeFile(path.join(root, "sub", "note.md"), "inside");
    await writeFile(path.join(base, "secret.env"), "outside");
  });

  afterEach(async () => {
    await rm(base, { recursive: true, force: true });
  });

  it("reads, writes and lists inside the workspace", async () => {
    const fs = createWorkspaceFs(root);
    expect((await fs.read.readFile(path.join(root, "sub", "note.md"))).toString()).toBe("inside");
    await fs.write.mkdir(path.join(root, "new", "dir"));
    await fs.write.writeFile(path.join(root, "new", "dir", "a.txt"), "hello");
    expect(await readFile(path.join(root, "new", "dir", "a.txt"), "utf8")).toBe("hello");
    expect(await fs.ls.readdir(root)).toEqual(expect.arrayContaining(["sub", "new"]));
    expect(await fs.ls.exists(path.join(root, "missing"))).toBe(false);
    expect(await fs.grep.isDirectory(path.join(root, "sub"))).toBe(true);
    const found = await fs.find.glob("*.md", root, { ignore: ["**/node_modules/**"], limit: 10 });
    expect(found.map((p) => p.split(path.sep).join("/"))).toEqual(["sub/note.md"]);
  });

  it("refuses paths outside the workspace, including via symlinks", async () => {
    const fs = createWorkspaceFs(root);
    await symlink(path.join(base, "secret.env"), path.join(root, "link.env"));
    await symlink(base, path.join(root, "escape"));
    const outside = [
      path.join(base, "secret.env"),
      path.join(root, "..", "secret.env"),
      path.join(root, "link.env"),
      path.join(root, "escape", "secret.env"),
      path.join(root, "escape", "new-file.txt"),
    ];
    for (const target of outside) {
      await expect(fs.read.readFile(target)).rejects.toThrow(/outside the task workspace/);
    }
    await expect(fs.write.writeFile(path.join(root, "escape", "x.txt"), "x")).rejects.toThrow(
      /outside the task workspace/,
    );
    await expect(fs.ls.readdir(base)).rejects.toThrow(/outside the task workspace/);
    await expect(fs.find.glob("*", base, { ignore: [], limit: 5 })).rejects.toThrow(/outside/);
    expect(await readFile(path.join(base, "secret.env"), "utf8")).toBe("outside");
  });
});
