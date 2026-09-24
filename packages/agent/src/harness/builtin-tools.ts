/**
 * The coding tools a harness offers when a session asks for `builtinTools`, as plain ToolSpecs for
 * harnesses that don't bring their own (Pi does; the Cursor CLI's are disabled). Same names and
 * input shapes as Pi's built-ins, so the safety rules for built-ins apply unchanged: file tools
 * confined to the task workspace (symlink-safe), `bash` run through the ShellExecutor, which owns
 * the command environment (the daemon's own environment is never forwarded).
 */
import { spawn } from "node:child_process";
import { glob, mkdir, readdir, readFile, realpath, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { type Logger, type ToolResult, type ToolSpec, textResult } from "@ddl/core";
import type { ShellExecutor } from "../execution/types";
import { builtinToolHints } from "../safety/policy";
import { TOOL } from "../tools/contracts";
import { asInput, type ToolInput, ToolInputError } from "../tools/input";
import { findExecutable, pathDirs } from "./executables";
import type { BuiltinToolsOptions } from "./types";
import { isInside, WorkspaceGuard } from "./workspace-guard";

const MAX_LINES = 2000;
const MAX_BYTES = 50 * 1024;
const GREP_MAX_LINE_LENGTH = 500;
const GREP_TIMEOUT_MS = 30_000;
const DEFAULT_GREP_LIMIT = 100;
const DEFAULT_FIND_LIMIT = 1000;
const DEFAULT_LS_LIMIT = 500;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const IMAGE_TYPES: Readonly<Record<string, string>> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
};

export interface WorkspaceToolsSetup {
  cwd: string;
  builtins: BuiltinToolsOptions | undefined;
  logger?: Logger;
  /** ripgrep for `grep` (default: `rg` on PATH). Without it the read-only set has no grep, like Pi. */
  ripgrep?: string | null;
}

/** files → read, write, edit (read-only: read, grep, find, ls); shell → bash unless read-only. */
export function createWorkspaceTools(setup: WorkspaceToolsSetup): ToolSpec[] {
  const { builtins, logger } = setup;
  if (!builtins) return [];
  const guard = new WorkspaceGuard(setup.cwd);
  const tools: ToolSpec[] = [];
  if (builtins.files) {
    tools.push(readTool(guard));
    if (builtins.readOnly) {
      const rg =
        setup.ripgrep === undefined
          ? findExecutable("rg", pathDirs(process.env.PATH))
          : setup.ripgrep;
      if (rg) tools.push(grepTool(guard, rg));
      else logger?.debug("ripgrep not found on PATH; grep tool disabled");
      tools.push(findTool(guard), lsTool(guard));
    } else {
      tools.push(writeTool(guard), editTool(guard));
    }
  }
  if (builtins.shell) {
    if (builtins.readOnly) {
      logger?.warn("shell tool not exposed: builtinTools.readOnly allows read-only tools only");
    } else {
      tools.push(bashTool(guard.root, builtins.shell));
    }
  }
  return tools;
}

function spec(
  name: string,
  description: string,
  parameters: Record<string, unknown>,
  execute: ToolSpec["execute"],
): ToolSpec {
  return {
    name,
    label: name,
    description,
    parameters: { type: "object", ...parameters },
    safety: builtinToolHints(name) ?? {},
    execute,
  };
}

// ── read ────────────────────────────────────────────────────────────────────

function readTool(guard: WorkspaceGuard): ToolSpec {
  return spec(
    TOOL.read,
    `Read the contents of a file in the task workspace. Supports text files and images (png, jpg, gif, webp). Text output is truncated to ${MAX_LINES} lines or ${MAX_BYTES / 1024}KB (whichever comes first); use offset/limit for large files.`,
    {
      properties: {
        path: { type: "string", description: "Path to the file to read (relative or absolute)" },
        offset: { type: "number", description: "Line number to start reading from (1-indexed)" },
        limit: { type: "number", description: "Maximum number of lines to read" },
      },
      required: ["path"],
    },
    async (raw) => {
      const input = asInput(raw);
      const file = requireText(input, "path");
      const offset = optionalCount(input, "offset");
      const limit = optionalCount(input, "limit");
      const target = await guard.resolve(expandHome(file));
      const info = await statOrThrow(target, file);
      if (info.isDirectory()) throw new ToolInputError(`${file} is a directory (use ls or find)`);
      const mimeType = IMAGE_TYPES[path.extname(target).toLowerCase()];
      if (mimeType) {
        if (info.size > MAX_IMAGE_BYTES) {
          throw new ToolInputError(`${file} is too large to read as an image (${info.size} bytes)`);
        }
        const data = await readFile(target);
        return {
          content: [
            { type: "text", text: `Read image file [${mimeType}]` },
            { type: "image", data: data.toString("base64"), mimeType },
          ],
        };
      }
      const buffer = await readFile(target);
      if (buffer.subarray(0, 8192).includes(0)) {
        throw new ToolInputError(`${file} is a binary file (${info.size} bytes)`);
      }
      const lines = buffer.toString("utf8").split("\n");
      const start = offset === undefined ? 0 : Math.max(0, offset - 1);
      if (start >= lines.length) {
        throw new ToolInputError(
          `Offset ${offset} is beyond end of file (${lines.length} lines total)`,
        );
      }
      const end = limit === undefined ? lines.length : Math.min(start + limit, lines.length);
      const head = headOf(lines.slice(start, end));
      const lastShown = start + head.lines;
      const more = lastShown < lines.length;
      const note = more
        ? `\n\n[Showing lines ${start + 1}-${lastShown} of ${lines.length}. Use offset=${lastShown + 1} to continue.]`
        : "";
      return textResult(`${head.text}${note}`, { path: file, totalLines: lines.length });
    },
  );
}

/** The leading lines that fit the line and byte budgets (a single oversized line is cut). */
function headOf(lines: readonly string[]): { text: string; lines: number } {
  const out: string[] = [];
  let bytes = 0;
  for (const line of lines) {
    if (out.length >= MAX_LINES) break;
    const size = Buffer.byteLength(line, "utf8") + 1;
    if (bytes + size > MAX_BYTES) {
      if (out.length === 0) {
        out.push(
          `${Buffer.from(line, "utf8").subarray(0, MAX_BYTES).toString("utf8")} [line truncated]`,
        );
      }
      break;
    }
    out.push(line);
    bytes += size;
  }
  return { text: out.join("\n"), lines: out.length };
}

// ── write / edit ────────────────────────────────────────────────────────────

function writeTool(guard: WorkspaceGuard): ToolSpec {
  return spec(
    TOOL.write,
    "Write content to a file in the task workspace. Creates the file if it doesn't exist, overwrites it if it does, and creates parent directories.",
    {
      properties: {
        path: { type: "string", description: "Path to the file to write (relative or absolute)" },
        content: { type: "string", description: "Content to write to the file" },
      },
      required: ["path", "content"],
    },
    async (raw) => {
      const input = asInput(raw);
      const file = requireText(input, "path");
      const content = requireString(input, "content");
      const target = await guard.resolve(expandHome(file));
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, content, "utf8");
      return textResult(
        `Successfully wrote ${Buffer.byteLength(content, "utf8")} bytes to ${file}`,
      );
    },
  );
}

interface Replacement {
  start: number;
  end: number;
  newText: string;
}

function editTool(guard: WorkspaceGuard): ToolSpec {
  return spec(
    TOOL.edit,
    "Edit a file in the task workspace with exact text replacements. Every edits[].oldText must match a unique, non-overlapping region of the original file; merge nearby changes into one edit.",
    {
      properties: {
        path: { type: "string", description: "Path to the file to edit (relative or absolute)" },
        edits: {
          type: "array",
          description: "One or more targeted replacements, each matched against the original file.",
          items: {
            type: "object",
            properties: {
              oldText: {
                type: "string",
                description: "Exact text to replace; must be unique in the original file.",
              },
              newText: { type: "string", description: "Replacement text." },
            },
            required: ["oldText", "newText"],
          },
        },
      },
      required: ["path", "edits"],
    },
    async (raw) => {
      const input = asInput(raw);
      const file = requireText(input, "path");
      const edits = input.edits;
      if (!Array.isArray(edits) || edits.length === 0) {
        throw new ToolInputError('"edits" must be a non-empty array of { oldText, newText }.');
      }
      const target = await guard.resolve(expandHome(file));
      await statOrThrow(target, file);
      const original = await readFile(target, "utf8");
      const replacements: Replacement[] = edits.map((edit, index) => {
        const item = asInput(edit);
        const oldText = requireString(item, "oldText");
        const newText = requireString(item, "newText");
        if (!oldText) throw new ToolInputError(`edits[${index}].oldText must not be empty`);
        const start = original.indexOf(oldText);
        if (start < 0) throw new ToolInputError(`edits[${index}].oldText was not found in ${file}`);
        if (original.indexOf(oldText, start + 1) >= 0) {
          throw new ToolInputError(
            `edits[${index}].oldText matches more than once in ${file}; include more surrounding text`,
          );
        }
        return { start, end: start + oldText.length, newText };
      });
      replacements.sort((a, b) => a.start - b.start);
      for (let i = 1; i < replacements.length; i++) {
        if (replacements[i]!.start < replacements[i - 1]!.end) {
          throw new ToolInputError("Edits overlap; merge them into one edit");
        }
      }
      let updated = original;
      for (const { start, end, newText } of [...replacements].reverse()) {
        updated = updated.slice(0, start) + newText + updated.slice(end);
      }
      await writeFile(target, updated, "utf8");
      return textResult(`Successfully replaced ${replacements.length} block(s) in ${file}.`);
    },
  );
}

// ── ls / find / grep ────────────────────────────────────────────────────────

function lsTool(guard: WorkspaceGuard): ToolSpec {
  return spec(
    TOOL.ls,
    `List a directory in the task workspace, sorted alphabetically, with '/' after directories (dotfiles included). Truncated to ${DEFAULT_LS_LIMIT} entries.`,
    {
      properties: {
        path: { type: "string", description: "Directory to list (default: the workspace)" },
        limit: { type: "number", description: "Maximum number of entries (default: 500)" },
      },
    },
    async (raw) => {
      const input = asInput(raw);
      const dir = optionalText(input, "path") ?? ".";
      const limit = optionalCount(input, "limit") ?? DEFAULT_LS_LIMIT;
      const target = await guard.resolve(expandHome(dir));
      if (!(await statOrThrow(target, dir)).isDirectory()) {
        throw new ToolInputError(`${dir} is not a directory`);
      }
      const entries = (await readdir(target, { withFileTypes: true })).sort((a, b) =>
        a.name.localeCompare(b.name),
      );
      if (entries.length === 0) return textResult("(empty directory)");
      const lines = entries.slice(0, limit).map((e) => (e.isDirectory() ? `${e.name}/` : e.name));
      if (entries.length > limit) {
        lines.push(`[${entries.length - limit} more entries not shown; raise limit to see them]`);
      }
      return textResult(lines.join("\n"));
    },
  );
}

function findTool(guard: WorkspaceGuard): ToolSpec {
  return spec(
    TOOL.find,
    `Find files in the task workspace by glob pattern ('*.ts' matches at any depth). Returns paths relative to the search directory, truncated to ${DEFAULT_FIND_LIMIT} results.`,
    {
      properties: {
        pattern: {
          type: "string",
          description: "Glob pattern, e.g. '*.ts', '**/*.json' or 'src/**/*.spec.ts'",
        },
        path: { type: "string", description: "Directory to search in (default: the workspace)" },
        limit: { type: "number", description: "Maximum number of results (default: 1000)" },
      },
      required: ["pattern"],
    },
    async (raw) => {
      const input = asInput(raw);
      const pattern = requireText(input, "pattern");
      const dir = optionalText(input, "path") ?? ".";
      const limit = optionalCount(input, "limit") ?? DEFAULT_FIND_LIMIT;
      const base = await guard.resolve(expandHome(dir));
      if (!(await statOrThrow(base, dir)).isDirectory()) {
        throw new ToolInputError(`${dir} is not a directory`);
      }
      const root = await guard.resolvedRoot();
      const matches: string[] = [];
      for await (const match of glob(pattern.includes("/") ? pattern : `**/${pattern}`, {
        cwd: base,
        exclude: ["**/node_modules/**", "**/.git/**"],
      })) {
        // A symlinked directory inside the workspace may point outside it.
        const real = await realpath(path.join(base, match)).catch(() => undefined);
        if (!real || !isInside(root, real)) continue;
        matches.push(match.split(path.sep).join("/"));
        if (matches.length >= limit) break;
      }
      if (matches.length === 0) return textResult(`No files found matching ${pattern}`);
      matches.sort();
      const note = matches.length >= limit ? `\n[Results limited to ${limit}]` : "";
      return textResult(`${matches.join("\n")}${note}`);
    },
  );
}

function grepTool(guard: WorkspaceGuard, rg: string): ToolSpec {
  return spec(
    TOOL.grep,
    `Search file contents in the task workspace for a pattern (ripgrep; respects .gitignore). Returns matching lines with file paths and line numbers, truncated to ${DEFAULT_GREP_LIMIT} matches.`,
    {
      properties: {
        pattern: { type: "string", description: "Search pattern (regex or literal string)" },
        path: {
          type: "string",
          description: "Directory or file to search (default: the workspace)",
        },
        glob: { type: "string", description: "Filter files by glob pattern, e.g. '*.ts'" },
        ignoreCase: { type: "boolean", description: "Case-insensitive search (default: false)" },
        literal: { type: "boolean", description: "Treat pattern as a literal string" },
        context: { type: "number", description: "Lines of context around each match (default: 0)" },
        limit: { type: "number", description: "Maximum number of matches (default: 100)" },
      },
      required: ["pattern"],
    },
    async (raw, ctx) => {
      const input = asInput(raw);
      const pattern = requireText(input, "pattern");
      const target = await guard.resolve(expandHome(optionalText(input, "path") ?? "."));
      const root = await guard.resolvedRoot();
      const args = ["--no-config", "--line-number", "--with-filename", "--no-heading"];
      args.push("--color", "never", "--max-columns", String(GREP_MAX_LINE_LENGTH));
      if (input.ignoreCase === true) args.push("--ignore-case");
      if (input.literal === true) args.push("--fixed-strings");
      const context = optionalCount(input, "context");
      if (context) args.push("--context", String(Math.min(context, 20)));
      const fileGlob = optionalText(input, "glob");
      if (fileGlob) args.push("--glob", fileGlob);
      args.push("--", pattern, path.relative(root, target) || ".");
      const limit = optionalCount(input, "limit") ?? DEFAULT_GREP_LIMIT;
      return runRipgrep(rg, args, root, limit, ctx.signal);
    },
  );
}

/** Match lines are `file:line:text`; context lines `file-line-text`; groups are split by `--`. */
async function runRipgrep(
  rg: string,
  args: string[],
  cwd: string,
  limit: number,
  signal: AbortSignal | undefined,
): Promise<ToolResult> {
  const child = spawn(rg, args, {
    cwd,
    env: { PATH: process.env.PATH ?? "" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const lines: string[] = [];
  let matches = 0;
  let pending = "";
  let stderr = "";
  let limited = false;
  const stop = () => child.kill("SIGTERM");
  const timer = setTimeout(stop, GREP_TIMEOUT_MS);
  signal?.addEventListener("abort", stop, { once: true });
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    pending += chunk;
    let newline = pending.indexOf("\n");
    while (newline >= 0 && !limited) {
      const raw = pending.slice(0, newline);
      const line = raw.startsWith("./") ? raw.slice(2) : raw;
      pending = pending.slice(newline + 1);
      if (/^.+?:\d+:/.test(line)) matches++;
      lines.push(line);
      if (matches >= limit) {
        limited = true;
        stop();
      }
      newline = pending.indexOf("\n");
    }
  });
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    stderr = (stderr + chunk).slice(-2000);
  });
  const code = await new Promise<number | null>((resolve, reject) => {
    child.on("error", reject);
    child.on("close", resolve);
  }).finally(() => {
    clearTimeout(timer);
    signal?.removeEventListener("abort", stop);
  });
  if (signal?.aborted) throw new Error("grep aborted");
  if (!limited && code === 1) return textResult("No matches found");
  if (!limited && code !== 0) {
    throw new Error(`grep failed${stderr.trim() ? `: ${stderr.trim().split("\n")[0]}` : ""}`);
  }
  const note = limited ? `\n[Results limited to ${limit} matches]` : "";
  return textResult(`${lines.join("\n")}${note}`);
}

// ── bash ────────────────────────────────────────────────────────────────────

function bashTool(cwd: string, shell: ShellExecutor): ToolSpec {
  return spec(
    TOOL.bash,
    `Execute a shell command in the task workspace. Returns combined stdout and stderr, truncated to the last ${MAX_LINES} lines or ${MAX_BYTES / 1024}KB. Optionally provide a timeout in seconds.`,
    {
      properties: {
        command: { type: "string", description: "Shell command to execute" },
        timeout: { type: "number", description: "Timeout in seconds (optional)" },
      },
      required: ["command"],
    },
    async (raw, ctx) => {
      const input = asInput(raw);
      const command = requireText(input, "command");
      const timeout = input.timeout;
      if (
        timeout !== undefined &&
        !(typeof timeout === "number" && Number.isFinite(timeout) && timeout > 0)
      ) {
        throw new ToolInputError('"timeout" must be a positive number of seconds.');
      }
      let streamed = "";
      const result = await shell.exec(command, {
        cwd,
        ...(timeout === undefined ? {} : { timeoutMs: Math.round(timeout * 1000) }),
        ...(ctx.signal ? { signal: ctx.signal } : {}),
        onData: (chunk) => {
          if (!chunk) return;
          streamed += chunk;
          if (streamed.length > MAX_BYTES * 4) streamed = streamed.slice(-MAX_BYTES * 2);
          ctx.onUpdate?.(textResult(tailOf(streamed)));
        },
      });
      const output = tailOf(result.output || streamed) || "(no output)";
      if (ctx.signal?.aborted)
        return { ...textResult(`${output}\n\nCommand aborted`), isError: true };
      if (result.timedOut) {
        const seconds = timeout ?? Math.max(1, Math.round(result.durationMs / 1000));
        return {
          ...textResult(`${output}\n\nCommand timed out after ${seconds} seconds`),
          isError: true,
        };
      }
      if (result.exitCode !== 0) {
        const status =
          result.exitCode === null ? "was killed" : `exited with code ${result.exitCode}`;
        return { ...textResult(`${output}\n\nCommand ${status}`), isError: true };
      }
      return textResult(output, { exitCode: 0 });
    },
  );
}

/** The trailing lines that fit the line and byte budgets. */
function tailOf(text: string): string {
  const lines = text.replace(/\n$/, "").split("\n");
  const out: string[] = [];
  let bytes = 0;
  for (let i = lines.length - 1; i >= 0 && out.length < MAX_LINES; i--) {
    const size = Buffer.byteLength(lines[i]!, "utf8") + 1;
    if (bytes + size > MAX_BYTES) break;
    out.unshift(lines[i]!);
    bytes += size;
  }
  const dropped = lines.length - out.length;
  return dropped > 0 ? `[${dropped} earlier lines truncated]\n${out.join("\n")}` : out.join("\n");
}

// ── input helpers ───────────────────────────────────────────────────────────

function requireString(input: ToolInput, key: string): string {
  const value = input[key];
  if (typeof value !== "string")
    throw new ToolInputError(`"${key}" is required and must be a string.`);
  return value;
}

function requireText(input: ToolInput, key: string): string {
  const value = requireString(input, key);
  if (!value.trim()) throw new ToolInputError(`"${key}" must not be empty.`);
  return value;
}

function optionalText(input: ToolInput, key: string): string | undefined {
  const value = input[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") throw new ToolInputError(`"${key}" must be a string.`);
  return value.trim() ? value : undefined;
}

function optionalCount(input: ToolInput, key: string): number | undefined {
  const value = input[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new ToolInputError(`"${key}" must be a non-negative number.`);
  }
  return Math.floor(value);
}

function expandHome(target: string): string {
  if (target === "~") return os.homedir();
  return target.startsWith("~/") ? path.join(os.homedir(), target.slice(2)) : target;
}

async function statOrThrow(target: string, shown: string) {
  try {
    return await stat(target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new ToolInputError(`Not found: ${shown}`);
    }
    throw error;
  }
}
