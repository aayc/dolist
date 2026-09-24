/**
 * Pi's built-in coding tools, created only when a session asks for them: file tools bound to the
 * workspace, and `bash` executed through our ShellExecutor (the ExecutionProvider).
 */
import { accessSync, constants } from "node:fs";
import path from "node:path";
import type { Logger } from "@ddl/core";
import {
  type BashOperations,
  createBashToolDefinition,
  createEditToolDefinition,
  createFindToolDefinition,
  createGrepToolDefinition,
  createLsToolDefinition,
  createReadToolDefinition,
  createWriteToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { ShellExecutor } from "../../execution/types";
import type { BuiltinToolsOptions } from "../types";
import type { AnyToolDefinition } from "./tools";
import { createWorkspaceFs } from "./workspace-fs";

export interface BuiltinToolsSetup {
  cwd: string;
  builtins: BuiltinToolsOptions | undefined;
  logger?: Logger;
  /** Overridable for tests. Default: `rg` found on PATH. */
  ripgrepAvailable?: () => boolean;
}

/**
 * files → read, write, edit (read-only: read, grep, find, ls); shell → bash unless read-only.
 * Mirrors Pi's createCodingTools / createReadOnlyTools split.
 */
export function createBuiltinTools(setup: BuiltinToolsSetup): AnyToolDefinition[] {
  const { cwd, builtins, logger } = setup;
  if (!builtins) return [];
  const definitions: AnyToolDefinition[] = [];
  if (builtins.files) {
    const fs = createWorkspaceFs(cwd);
    definitions.push(createReadToolDefinition(cwd, { operations: fs.read }));
    if (builtins.readOnly) {
      // Without rg on PATH, Pi's grep downloads ripgrep into the user's global ~/.pi directory.
      if ((setup.ripgrepAvailable ?? ripgrepOnPath)()) {
        definitions.push(createGrepToolDefinition(cwd, { operations: fs.grep }));
      } else {
        logger?.debug("ripgrep not found on PATH; grep tool disabled");
      }
      definitions.push(
        createFindToolDefinition(cwd, { operations: fs.find }),
        createLsToolDefinition(cwd, { operations: fs.ls }),
      );
    } else {
      definitions.push(
        createWriteToolDefinition(cwd, { operations: fs.write }),
        createEditToolDefinition(cwd, { operations: fs.edit }),
      );
    }
  }
  if (builtins.shell) {
    if (builtins.readOnly) {
      logger?.warn("shell tool not exposed: builtinTools.readOnly allows read-only tools only");
    } else {
      definitions.push(
        createBashToolDefinition(cwd, {
          operations: createBashOperations(builtins.shell),
          exposeSessionEnvironment: false,
        }),
      );
    }
  }
  return definitions;
}

/**
 * Adapts our ShellExecutor to Pi's BashOperations. Pi hands over the daemon's entire
 * `process.env` (API keys included); it is deliberately not forwarded — the ShellExecutor owns the
 * command environment.
 */
export function createBashOperations(shell: ShellExecutor): BashOperations {
  return {
    async exec(command, cwd, { onData, signal, timeout }) {
      if (timeout !== undefined && !(Number.isFinite(timeout) && timeout > 0)) {
        throw new Error("Invalid timeout: must be a finite number of seconds");
      }
      if (signal?.aborted) throw new Error("aborted");
      let streamed = false;
      let result: Awaited<ReturnType<ShellExecutor["exec"]>>;
      try {
        result = await shell.exec(command, {
          cwd,
          ...(timeout === undefined ? {} : { timeoutMs: Math.round(timeout * 1000) }),
          ...(signal ? { signal } : {}),
          onData: (chunk) => {
            if (!chunk) return;
            streamed = true;
            onData(Buffer.from(chunk, "utf8"));
          },
        });
      } catch (error) {
        if (signal?.aborted) throw new Error("aborted");
        throw error;
      }
      if (!streamed && result.output) onData(Buffer.from(result.output, "utf8"));
      // Pi turns these exact messages into "Command aborted" / "Command timed out after N seconds".
      if (signal?.aborted) throw new Error("aborted");
      if (result.timedOut) {
        throw new Error(`timeout:${timeout ?? Math.max(1, Math.round(result.durationMs / 1000))}`);
      }
      return { exitCode: result.exitCode };
    },
  };
}

let ripgrepOnPathCache: boolean | undefined;

function ripgrepOnPath(): boolean {
  ripgrepOnPathCache ??= isExecutableOnPath(process.platform === "win32" ? "rg.exe" : "rg");
  return ripgrepOnPathCache;
}

function isExecutableOnPath(file: string): boolean {
  for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
    if (!dir) continue;
    try {
      accessSync(path.join(dir, file), constants.X_OK);
      return true;
    } catch {
      // not in this directory
    }
  }
  return false;
}
