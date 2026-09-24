import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type {
  ExecutionCapabilities,
  ExecutionProvider,
  ShellExecutor,
  Workspace,
} from "@ddl/agent";

/**
 * Execution provider with no shell, browser or computer. Used when the real provider cannot be
 * created, so research-only subagents still get a scratch workspace under DDL_HOME.
 */
export class NullExecutionProvider implements ExecutionProvider {
  readonly id = "none";
  readonly capabilities: ExecutionCapabilities = { shell: false, browser: false, computer: false };
  readonly shell: ShellExecutor = {
    exec: async () => {
      throw new Error("No execution provider is available");
    },
  };
  private readonly workspaceRoot: string;

  constructor(home: string) {
    this.workspaceRoot = join(home, "workspaces");
  }

  async prepareWorkspace(key: string): Promise<Workspace> {
    const dir = join(this.workspaceRoot, safeDirectoryName(key));
    await mkdir(dir, { recursive: true, mode: 0o700 });
    return { key, dir };
  }

  async dispose(): Promise<void> {}
}

function safeDirectoryName(key: string): string {
  const name = key.replace(/[^A-Za-z0-9_.-]/g, "_").slice(0, 100);
  return name === "" || /^\.+$/.test(name) ? `ws_${name.length}` : name;
}
