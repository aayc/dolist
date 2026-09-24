export const DEFAULT_EXTRACT_MAX_CHARS = 20_000;

/** Trims lines, collapses runs of spaces and blank lines. */
export function collapseWhitespace(text: string): string {
  return text
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.replace(/[ \t\f\v\u00a0]+/g, " ").trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function capText(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}\n[... truncated: ${text.length - maxChars} more characters ...]`;
}

/**
 * Runs in the page: the main content's `innerText` when a `main`/`article` region holds most of
 * the text, else the whole body. Must stay self-contained (it is serialized into the page).
 */
export const readablePageText = (): string => {
  const body = document.body;
  if (!body) return document.documentElement?.innerText ?? "";
  const bodyText = body.innerText;
  const regions = [
    document.querySelector("main"),
    document.querySelector("[role='main']"),
    document.querySelector("article"),
  ];
  for (const region of regions) {
    if (!(region instanceof HTMLElement)) continue;
    const text = region.innerText;
    if (text.trim().length >= Math.max(200, bodyText.length * 0.3)) return text;
  }
  return bodyText;
};
