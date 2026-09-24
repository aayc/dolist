/**
 * Public API of the execution module. (Initial stubs — replaced by the real implementation.)
 */
import type { Logger, ToolSpec } from "@ddl/core";
import type { ExecutionConfig, ExecutionProvider, ExecutionToolContext } from "./types";

export async function createExecutionProvider(
  _config: ExecutionConfig,
  _options: { logger?: Logger } = {},
): Promise<ExecutionProvider> {
  throw new Error("createExecutionProvider: not implemented yet");
}

/** Model-facing browser_* / computer_* tools for one subagent, per its granted capabilities. */
export function createExecutionTools(
  _provider: ExecutionProvider,
  _ctx: ExecutionToolContext,
): ToolSpec[] {
  return [];
}
