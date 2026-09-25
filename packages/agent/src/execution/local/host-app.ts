import { basename, join } from "node:path";
import type { ComputerHostApp } from "@ddl/core";
import type { CommandRunner } from "./jxa";

/** Deeper chains than this are cut (a cycle in a corrupt table, or something odd). */
const MAX_DEPTH = 64;

interface ProcessEntry {
  ppid: number;
  /** The executable path, or a process title some apps set instead (Electron helpers). */
  comm: string;
}

/** `ps -A -o pid=,ppid=,comm=` output → pid → entry. */
export function parseProcessTable(output: string): Map<number, ProcessEntry> {
  const table = new Map<number, ProcessEntry>();
  for (const line of output.split("\n")) {
    const match = /^\s*(\d+)\s+(\d+)\s+(.+?)\s*$/.exec(line);
    if (match) table.set(Number(match[1]), { ppid: Number(match[2]), comm: match[3]! });
  }
  return table;
}

/** `/Applications/Cursor.app/Contents/Frameworks/X.app/Contents/MacOS/X` → `/Applications/Cursor.app`. */
export function outermostAppBundle(path: string): string | undefined {
  if (!path.startsWith("/")) return undefined;
  const index = path.indexOf(".app/");
  if (index > 0) return path.slice(0, index + 4);
  return path.endsWith(".app") ? path : undefined;
}

/**
 * The app macOS attributes this process's privacy permissions to: the outermost app bundle of the
 * nearest ancestor that runs from one (the Daily Do List app for a daemon it manages, Terminal or
 * an editor for `pnpm dev`). Undefined when no ancestor is an app (e.g. started by launchd).
 */
export async function findHostApp(
  runner: CommandRunner,
  pid: number = process.pid,
): Promise<ComputerHostApp | undefined> {
  const { stdout } = await runner("ps", ["-A", "-o", "pid=,ppid=,comm="]);
  const table = parseProcessTable(stdout);
  let current = pid;
  for (let depth = 0; depth < MAX_DEPTH && current > 1; depth++) {
    const entry = table.get(current);
    if (!entry) return undefined;
    const bundle = outermostAppBundle(entry.comm);
    if (bundle) {
      const bundleId = await readBundleId(runner, bundle);
      return {
        name: basename(bundle, ".app"),
        path: bundle,
        ...(bundleId ? { bundleId } : {}),
      };
    }
    current = entry.ppid;
  }
  return undefined;
}

async function readBundleId(runner: CommandRunner, bundle: string): Promise<string | undefined> {
  try {
    const { stdout } = await runner("plutil", [
      "-extract",
      "CFBundleIdentifier",
      "raw",
      "-o",
      "-",
      join(bundle, "Contents", "Info.plist"),
    ]);
    const id = stdout.trim();
    return /^[A-Za-z0-9.-]{1,200}$/.test(id) ? id : undefined;
  } catch {
    return undefined;
  }
}
