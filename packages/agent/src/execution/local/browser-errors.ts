import { errorMessage } from "@ddl/core";
import { ExecutionError } from "../errors";

/** First line of a Playwright error without the `locator.click:` API prefix, capped. */
export function cleanPlaywrightMessage(error: unknown): string {
  const first = errorMessage(error).split("\n")[0] ?? "";
  const text = first.replace(/^[\w.]+: /, "").trim() || "unknown error";
  return text.length > 300 ? `${text.slice(0, 300)}…` : text;
}

export function isTimeoutError(error: unknown): boolean {
  return error instanceof Error && error.name === "TimeoutError";
}

/** The page navigated while we were reading it; retrying after load usually works. */
export function isNavigationRace(error: unknown): boolean {
  return /Execution context was destroyed|frame was detached|navigating and changing the content/i.test(
    errorMessage(error),
  );
}

export function isDownloadStart(error: unknown): boolean {
  return /Download is starting/i.test(errorMessage(error));
}

/** Model-facing explanation of a failed element action. */
export function actionFailure(verb: string, error: unknown, timeoutMs: number): ExecutionError {
  if (error instanceof ExecutionError) return error;
  if (isTimeoutError(error)) {
    return new ExecutionError(
      `Timed out after ${Math.round(timeoutMs / 1000)}s trying to ${verb} the element — it may be hidden, disabled or covered by another element (a dialog or cookie banner). Take a new browser_snapshot and try another target.`,
      { cause: error },
    );
  }
  if (/not a <select> element|not a select element/i.test(errorMessage(error))) {
    return new ExecutionError(
      "The target is not a native <select>. Click it to open the list, then click the option.",
      { cause: error },
    );
  }
  return new ExecutionError(`Could not ${verb}: ${cleanPlaywrightMessage(error)}`, {
    cause: error,
  });
}
