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

/** Opens the app against the in-browser mock and waits until today's note is interactive. */
export async function openApp(page: Page, query = "mockSpeed=4"): Promise<void> {
  await page.goto(`/?mock=1${query ? `&${query}` : ""}`);
  await expect(page.getByTestId("note-title")).toBeVisible();
  await page.waitForFunction(() =>
    window.__ddlPerf?.measures.some((m) => m.name === "app:interactive"),
  );
}

export function noteTitle(page: Page) {
  return page.getByTestId("note-title");
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

export async function waitForSaved(page: Page): Promise<void> {
  await expect(page.getByTestId("status-save")).toHaveAttribute("data-state", "saved");
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
