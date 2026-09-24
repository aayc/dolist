/**
 * Public API of the execution module: the provider registry and the model-facing tool factory.
 * Backend selection happens only here.
 */
import { type Logger, silentLogger } from "@ddl/core";
import { CloudExecutionProvider } from "./cloud/provider";
import { LocalExecutionProvider } from "./local/provider";
import type { ExecutionConfig, ExecutionProvider } from "./types";

export { CloudExecutionProvider } from "./cloud/provider";
export {
  BrowserUnavailableError,
  ComputerPermissionError,
  ComputerUnavailableError,
  ElementNotFoundError,
  ExecutionError,
  NavigationBlockedError,
  NotImplementedError,
  StaleRefError,
} from "./errors";
export { LocalExecutionProvider } from "./local/provider";
export { createExecutionTools } from "./tools";

export async function createExecutionProvider(
  config: ExecutionConfig,
  options: { logger?: Logger } = {},
): Promise<ExecutionProvider> {
  const logger = (options.logger ?? silentLogger).child({ component: "execution" });
  switch (config.kind) {
    case "local": {
      const provider = new LocalExecutionProvider(config, { logger });
      logger.info("execution provider ready", {
        provider: provider.id,
        ...provider.capabilities,
        browserSource: provider.browserExecutable?.source ?? null,
      });
      return provider;
    }
    case "cloud":
      return new CloudExecutionProvider(config, { logger });
    default: {
      const unknown: never = config;
      throw new Error(`Unknown execution provider: ${JSON.stringify(unknown)}`);
    }
  }
}
