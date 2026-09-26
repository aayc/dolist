import { expect, type Page } from "@playwright/test";

/** Debug hooks this folder relies on (`?debug=1`, installed by `src/app/bootstrap.tsx`). */
export interface EdgeDebug {
  activePath(): string | null;
  openNote(path: string, newTab?: boolean): Promise<boolean>;
  renderMarkdown(source: string): Promise<string>;
  delayWrites(ms: number): void;
  runCommand(id: string): boolean;
}

export type EdgeWindow = Window & { __ddlDebug: EdgeDebug };

/** Uncaught page errors and console errors; assert it's empty at the end of a test. */
export function collectErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(`pageerror: ${error.message}`));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(`console: ${message.text()}`);
  });
  return errors;
}

export async function delayWrites(page: Page, ms: number): Promise<void> {
  await page.evaluate(
    (delay) => (window as unknown as EdgeWindow).__ddlDebug.delayWrites(delay),
    ms,
  );
}

export function explorerItem(page: Page, path: string) {
  return page.locator(`[data-testid="explorer-item"][data-path="${path}"]`);
}

export function tab(page: Page, path: string) {
  return page.locator(`[data-testid="tab"][data-path="${path}"]`);
}

/** Active note's save state, as carried by the status bar (which shows nothing when saved). */
export async function expectSaved(page: Page): Promise<void> {
  await expect(page.getByTestId("status-bar")).toHaveAttribute("data-save-state", "saved");
}

/** Places the caret at the end of the editor's document. */
export async function caretToEnd(page: Page): Promise<void> {
  await page.locator(".cm-content").click();
  await page.keyboard.press("ControlOrMeta+End");
}
