/** Reports an error without breaking the caller (global `reportError` where available). */
export function reportError(error: unknown): void {
  if (typeof globalThis.reportError === "function") {
    globalThis.reportError(error);
    return;
  }
  queueMicrotask(() => {
    throw error;
  });
}
