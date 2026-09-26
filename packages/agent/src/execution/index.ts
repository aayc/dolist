/**
 * Public API of the execution module: the provider registry and the model-facing tool factory.
 * Backend selection happens only here.
 */
import { type Logger, silentLogger } from "@ddl/core";
import { LocalExecutionProvider } from "./local/provider";
import type { ExecutionConfig, ExecutionProvider } from "./types";

export {
  BrowserUnavailableError,
  ComputerPermissionError,
  ComputerUnavailableError,
  ElementNotFoundError,
  ExecutionError,
  NavigationBlockedError,
  ProtectedAppError,
  StaleElementError,
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
        appControl: provider.computerHelper !== undefined,
      });
      if (provider.capabilities.computer && provider.computerHelper === undefined) {
        logger.info(
          "App control is off: the ddl-computer helper wasn't found, so computer use stays screen-level",
        );
      }
      return provider;
    }
    default:
      throw new Error(`Unknown execution provider: ${JSON.stringify(config)}`);
  }
}
