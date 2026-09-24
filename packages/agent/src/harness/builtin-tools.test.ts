import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { type ToolResult, type ToolSpec, toolResultText } from "@ddl/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ShellExecOptions, ShellExecutor, ShellResult } from "../execution/types";
import { createWorkspaceTools } from "./builtin-tools";
import { findExecutable, pathDirs } from "./executables";

let base: string;
let root: string;

beforeEach(async () => {
  base = await mkdtemp(path.join(tmpdir(), "ddl-builtins-"));
  root = path.join(base, "workspace");
  await mkdir(path.join(root, "sub"), { recursive: true });
  await writeFile(path.join(root, "sub", "note.md"), "alpha\nbeta\ngamma\n");
  await writeFile(path.join(base, "secret.env"), "API_KEY=outside");
  await symlink(path.join(base, "secret.env"), path.join(root, "link.env"));
  await symlink(base, path.join(root, "escape"));
});

afterEach(async () => {
  await rm(base, { recursive: true, force: true });
});

function shell(result: Partial<ShellResult> = {}) {
  const exec = vi.fn(async (_command: string, options: ShellExecOptions): Promise<ShellResult> => {
    options.onData?.("line 1\n");
    return {
      exitCode: 0,
      output: "line 1\n",
      timedOut: false,
      truncated: false,
      durationMs: 3,
      ...result,
    };
  });
  return { exec } satisfies ShellExecutor;
}

function tools(
  options: Parameters<typeof createWorkspaceTools>[0]["builtins"],
  ripgrep?: string | null,
) {
  const list = createWorkspaceTools({
    cwd: root,
    builtins: options,
    ...(ripgrep === undefined ? {} : { ripgrep }),
  });
  return new Map(list.map((tool) => [tool.name, tool]));
}

async function call(tool: ToolSpec | undefined, input: unknown): Promise<ToolResult> {
  if (!tool) throw new Error("tool missing");
  try {
    return await tool.execute(input, { toolCallId: "c1" });
  } catch (error) {
    return { content: [{ type: "text", text: (error as Error).message }], isError: true };
  }
}

describe("createWorkspaceTools", () => {
  it("offers Pi's tool sets with Pi's names and the built-in safety hints", () => {
    const executor = shell();
    expect([...tools({ files: true, shell: executor }).keys()]).toEqual([
      "read",
      "write",
      "edit",
      "bash",
    ]);
    expect([
      ...tools({ files: true, readOnly: true, shell: executor }, "/usr/bin/rg").keys(),
    ]).toEqual(["read", "grep", "find", "ls"]);
    expect([...tools({ files: true, readOnly: true }, null).keys()]).toEqual([
      "read",
      "find",
      "ls",
    ]);
    expect([...tools({ files: false, shell: executor }).keys()]).toEqual(["bash"]);
    expect(createWorkspaceTools({ cwd: root, builtins: undefined })).toEqual([]);
    const set = tools({ files: true, shell: executor });
    expect(set.get("read")?.safety).toEqual({ readOnly: true, category: "read" });
    expect(set.get("write")?.safety).toEqual({ category: "file_write" });
    expect(set.get("bash")?.safety).toEqual({ category: "system" });
    expect(set.get("edit")?.parameters).toMatchObject({ required: ["path", "edits"] });
  });

  it("reads, writes and edits inside the workspace", async () => {
    const set = tools({ files: true });
    expect(toolResultText(await call(set.get("read"), { path: "sub/note.md" }))).toBe(
      "alpha\nbeta\ngamma\n",
    );
    expect(
      toolResultText(await call(set.get("read"), { path: "sub/note.md", offset: 2, limit: 1 })),
    ).toBe("beta\n\n[Showing lines 2-2 of 4. Use offset=3 to continue.]");
    await call(set.get("write"), { path: "out/new.txt", content: "one two" });
    expect(await readFile(path.join(root, "out", "new.txt"), "utf8")).toBe("one two");
    const edited = await call(set.get("edit"), {
      path: "out/new.txt",
      edits: [
        { oldText: "one", newText: "1" },
        { oldText: "two", newText: "2" },
      ],
    });
    expect(edited.isError).toBeUndefined();
    expect(await readFile(path.join(root, "out", "new.txt"), "utf8")).toBe("1 2");
    const ambiguous = await call(set.get("edit"), {
      path: "sub/note.md",
      edits: [{ oldText: "a", newText: "x" }],
    });
    expect(toolResultText(ambiguous)).toMatch(/matches more than once/);
    const missing = await call(set.get("edit"), {
      path: "sub/note.md",
      edits: [{ oldText: "zeta", newText: "x" }],
    });
    expect(toolResultText(missing)).toMatch(/was not found/);
    const overlap = await call(set.get("edit"), {
      path: "sub/note.md",
      edits: [
        { oldText: "alpha\nbeta", newText: "x" },
        { oldText: "beta\ngamma", newText: "y" },
      ],
    });
    expect(toolResultText(overlap)).toMatch(/overlap/);
  });

  it("refuses paths outside the workspace, including through symlinks and ~", async () => {
    const set = tools({ files: true });
    for (const target of [
      path.join(base, "secret.env"),
      "../secret.env",
      "link.env",
      "escape/secret.env",
      "~/.ssh/id_ed25519",
    ]) {
      const result = await call(set.get("read"), { path: target });
      expect(result.isError).toBe(true);
      expect(toolResultText(result)).toMatch(/outside the task workspace/);
    }
    const write = await call(set.get("write"), { path: "escape/planted.txt", content: "x" });
    expect(toolResultText(write)).toMatch(/outside the task workspace/);
    const edit = await call(set.get("edit"), {
      path: "link.env",
      edits: [{ oldText: "API", newText: "X" }],
    });
    expect(toolResultText(edit)).toMatch(/outside the task workspace/);
    expect(await readFile(path.join(base, "secret.env"), "utf8")).toBe("API_KEY=outside");
  });

  it("lists and finds inside the workspace without following links out of it", async () => {
    const set = tools({ files: true, readOnly: true }, null);
    const listing = toolResultText(await call(set.get("ls"), {}));
    expect(listing.split("\n")).toEqual(["escape", "link.env", "sub/"]);
    expect(toolResultText(await call(set.get("ls"), { path: ".." }))).toMatch(
      /outside the task workspace/,
    );
    expect(toolResultText(await call(set.get("find"), { pattern: "*.md" }))).toBe("sub/note.md");
    const all = toolResultText(await call(set.get("find"), { pattern: "**/*" }));
    expect(all).not.toContain("secret.env");
    expect(toolResultText(await call(set.get("find"), { pattern: "*", path: base }))).toMatch(
      /outside/,
    );
  });

  const rg = findExecutable("rg", pathDirs(process.env.PATH));
  it.skipIf(!rg)("greps with ripgrep inside the workspace only", async () => {
    const set = tools({ files: true, readOnly: true }, rg ?? null);
    expect(toolResultText(await call(set.get("grep"), { pattern: "beta" }))).toBe(
      "sub/note.md:2:beta",
    );
    expect(toolResultText(await call(set.get("grep"), { pattern: "API_KEY" }))).toBe(
      "No matches found",
    );
    expect(toolResultText(await call(set.get("grep"), { pattern: "x", path: base }))).toMatch(
      /outside/,
    );
    expect(toolResultText(await call(set.get("grep"), { pattern: "(" })).length).toBeGreaterThan(0);
  });

  it("runs bash through the ShellExecutor in the workspace without passing an environment", async () => {
    const executor = shell();
    const updates: ToolResult[] = [];
    const bash = tools({ files: false, shell: executor }).get("bash");
    const result = await bash!.execute(
      { command: "make test", timeout: 1.5 },
      { toolCallId: "c1", onUpdate: (partial) => updates.push(partial) },
    );
    expect(toolResultText(result)).toBe("line 1");
    expect(executor.exec).toHaveBeenCalledWith(
      "make test",
      expect.objectContaining({ cwd: root, timeoutMs: 1500 }),
    );
    expect(executor.exec.mock.calls[0]?.[1]).not.toHaveProperty("env");
    expect(updates.map(toolResultText)).toEqual(["line 1"]);

    const failing = tools({ files: false, shell: shell({ exitCode: 2, output: "boom\n" }) }).get(
      "bash",
    );
    expect(await call(failing, { command: "false" })).toMatchObject({ isError: true });
    expect(toolResultText(await call(failing, { command: "false" }))).toBe(
      "boom\n\nCommand exited with code 2",
    );
    const slow = tools({ files: false, shell: shell({ timedOut: true, exitCode: null }) }).get(
      "bash",
    );
    expect(toolResultText(await call(slow, { command: "sleep 9", timeout: 2 }))).toMatch(
      /timed out after 2 seconds/,
    );
    expect(toolResultText(await call(slow, { command: "x", timeout: -1 }))).toMatch(
      /positive number/,
    );
  });
});
