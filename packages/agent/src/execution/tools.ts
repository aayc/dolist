import { type Logger, silentLogger, type ToolSpec } from "@ddl/core";
import { createBrowserTools } from "./browser-tools";
import { createComputerTools } from "./computer-tools";
import type { ExecutionProvider, ExecutionToolContext } from "./types";

/**
 * Model-facing browser_* / computer_* tools for one subagent, per its granted capabilities and
 * what the provider can actually do. The shell is not here: it is the harness's built-in `bash`
 * tool, bound to `provider.shell`.
 */
export function createExecutionTools(
  provider: ExecutionProvider,
  ctx: ExecutionToolContext,
  options: { logger?: Logger } = {},
): ToolSpec[] {
  const logger = (options.logger ?? silentLogger).child({
    component: "execution-tools",
    threadId: ctx.threadId,
  });
  const granted = new Set(ctx.capabilities);
  const tools: ToolSpec[] = [];
  const browser =
    granted.has("browser") && provider.capabilities.browser ? provider.browser : undefined;
  if (browser) tools.push(...createBrowserTools(browser, ctx, logger));
  const computer =
    granted.has("computer") && provider.capabilities.computer ? provider.computer : undefined;
  if (computer) tools.push(...createComputerTools(computer, ctx, logger));
  return tools;
}
