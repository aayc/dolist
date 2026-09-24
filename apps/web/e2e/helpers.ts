import { expect, type Page } from "@playwright/test";

export interface PerfMeasure {
  name: string;
  duration: number;
  ts: number;
  detail?: Record<string, unknown>;
}

declare global {
  interface Window {
    __ddlPerf?: {
      measures: PerfMeasure[];
      longTasks: Array<{ start: number; duration: number }>;
      detailed: boolean;
      prefetched: boolean;
      clear(): void;
      mark(name: string): void;
    };
    __ddlMock?: {
      createNote(path: string, content: string): void;
      externalEdit(path: string, content: string): void;
      deleteNote(path: string): void;
      readNote(path: string): string | null;
      listPaths(): string[];
    };
    __ddlDebug?: {
      evictNote(path: string): void;
      activePath(): string | null;
      openNote(path: string, newTab?: boolean): Promise<boolean>;
      renderMarkdown(source: string): Promise<string>;
      delayWrites(ms: number): void;
      runCommand(id: string): boolean;
      shortcutKeys(id: string): readonly string[] | null;
    };
  }
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

/** Local calendar date `days` from today as YYYY-MM-DD (daily notes use local time). */
export function isoDate(days = 0): string {
  const date = new Date();
  date.setDate(date.getDate() + days);
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

export function dailyPath(days = 0): string {
  return `Daily/${isoDate(days)}.md`;
}

/** A daily note's title: "Thursday, September 24", with the year only when it isn't this year. */
export function dailyTitle(days = 0): string {
  const date = new Date();
  date.setDate(date.getDate() + days);
  const year = date.getFullYear() === new Date().getFullYear() ? {} : { year: "numeric" as const };
  return date.toLocaleDateString("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
    ...year,
  });
}

/** Opens the app against the in-browser mock and waits until today's note is interactive. */
export async function openApp(page: Page, query = "mockSpeed=4"): Promise<void> {
  await page.goto(`/?mock=1${query ? `&${query}` : ""}`);
  await expect(page.getByTestId("note-title")).toBeVisible();
  await page.waitForFunction(() =>
    window.__ddlPerf?.measures.some((m) => m.name === "app:interactive"),
  );
}

/**
 * The editable title (file name) of a regular note. Matching the input only makes assertions wait
 * while a daily note, whose title is a read-only heading, is still shown.
 */
export function noteTitle(page: Page) {
  return page.locator("input[data-testid='note-title']");
}

/** A daily note's read-only title: its date. */
export function dailyHeading(page: Page) {
  return page.locator("h1[data-testid='note-title']");
}

/** The daily note `days` from today is the one shown. */
export async function expectDailyNote(page: Page, days = 0): Promise<void> {
  await expect(dailyHeading(page).locator("time")).toHaveAttribute("datetime", isoDate(days));
}

/** Clicks into the editor and moves the caret to the end of the document. */
export async function focusEditorEnd(page: Page): Promise<void> {
  await page.locator(".cm-content").click();
  await page.keyboard.press("ControlOrMeta+End");
}

/** Types a task on the first (template) line of today's note: "- [ ] <text>". */
export async function typeTask(page: Page, text: string): Promise<void> {
  await focusEditorEnd(page);
  await page.keyboard.type(text, { delay: 5 });
}

/** The status bar shows nothing for a saved note; its save state is on the bar itself. */
export async function waitForSaved(page: Page): Promise<void> {
  await expect(page.getByTestId("status-bar")).toHaveAttribute("data-save-state", "saved");
}

export function badge(page: Page) {
  return page.locator(".cm-ddl-badge");
}

/** Records whether a streaming message was ever rendered (streams can finish between polls). */
export async function watchForStreaming(page: Page): Promise<void> {
  await page.evaluate(() => {
    const flag = window as unknown as { __sawStreaming?: boolean };
    flag.__sawStreaming = Boolean(document.querySelector('[data-streaming="true"]'));
    new MutationObserver(() => {
      if (document.querySelector('[data-streaming="true"]')) flag.__sawStreaming = true;
    }).observe(document.body, { subtree: true, childList: true, attributes: true });
  });
}

export async function sawStreaming(page: Page): Promise<boolean> {
  return page.evaluate(() =>
    Boolean((window as unknown as { __sawStreaming?: boolean }).__sawStreaming),
  );
}
