/**
 * Typed failures raised by execution providers. Tools turn them into model-visible error results;
 * anything else escaping a provider is treated as an infrastructure failure.
 */

export class ExecutionError extends Error {
  override name = "ExecutionError";
}

/** No usable Chrome/Chromium executable, or the browser failed to launch. */
export class BrowserUnavailableError extends ExecutionError {
  override name = "BrowserUnavailableError";
}

/** A navigation was refused by policy (e.g. `file:` or `javascript:` URLs). */
export class NavigationBlockedError extends ExecutionError {
  override name = "NavigationBlockedError";
}

/** An element ref does not resolve against the page's latest snapshot. */
export class StaleRefError extends ExecutionError {
  override name = "StaleRefError";
}

/** A selector/text target matched nothing on the page. */
export class ElementNotFoundError extends ExecutionError {
  override name = "ElementNotFoundError";
}

/** Computer use is not available on this platform or was disabled. */
export class ComputerUnavailableError extends ExecutionError {
  override name = "ComputerUnavailableError";
}

/** The OS refused an input or capture operation (macOS privacy permissions). */
export class ComputerPermissionError extends ExecutionError {
  override name = "ComputerPermissionError";
}

/** The app is off-limits to agents (Daily Do List, System Settings, password managers…). */
export class ProtectedAppError extends ExecutionError {
  override name = "ProtectedAppError";
}

/** An app element id is out of date: the app has to be read again. */
export class StaleElementError extends ExecutionError {
  override name = "StaleElementError";
}
