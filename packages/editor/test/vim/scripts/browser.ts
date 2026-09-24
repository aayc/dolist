/**
 * Chromium for the vim scripts: Playwright's bundled Chromium when it is installed (what CI uses),
 * otherwise the local Google Chrome. `VIM_CHROMIUM_CHANNEL=chrome` forces Chrome.
 */
import { existsSync } from "node:fs";
import { type Browser, chromium, type Page } from "playwright-core";
import { VIEWPORT } from "../format";
import { buildOracleFont, ORACLE_FONT_FAMILY, ORACLE_FONT_SIZE } from "./oracle-font";

const FONT_FACE = `@font-face{font-family:"${ORACLE_FONT_FAMILY}";src:url(data:font/ttf;base64,${Buffer.from(
  buildOracleFont(),
).toString("base64")}) format("truetype")}`;

/**
 * Loads the oracle font and measures it the way CodeMirror measures text. A string, because
 * functions passed to `page.evaluate` would carry tsx's helper calls into the page.
 */
const MEASURE_FONT = `(async () => {
  const font = '${ORACLE_FONT_SIZE}px "${ORACLE_FONT_FAMILY}"';
  await document.fonts.load(font);
  const span = document.createElement("span");
  span.style.font = font;
  span.style.whiteSpace = "pre";
  span.textContent = "abcdefghijklmnopqrstuvwxyz";
  document.body.append(span);
  const rect = span.getBoundingClientRect();
  span.remove();
  return { loaded: document.fonts.check(font), textHeight: rect.height, charWidth: rect.width / 26 };
})()`;

interface FontMetrics {
  loaded: boolean;
  textHeight: number;
  charWidth: number;
}

export async function launchChromium(): Promise<Browser> {
  const channel = process.env.VIM_CHROMIUM_CHANNEL;
  if (!channel && existsSync(chromium.executablePath())) return chromium.launch();
  return chromium.launch({ channel: channel || "chrome" });
}

export interface PageErrors {
  readonly errors: string[];
}

/**
 * Opens a page on a secure origin (the clipboard API needs one) running `script`, once the oracle
 * font is loaded and lays out with the metrics the vectors record (see ./oracle-font.ts).
 */
export async function openScriptPage(browser: Browser, script: string): Promise<Page & PageErrors> {
  const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } });
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.stack ?? error.message));
  const html = [
    "<!doctype html>",
    `<html><head><meta charset="utf-8"><style>body{margin:0}${FONT_FACE}</style></head>`,
    `<body><div id="root"></div><script>${script.replaceAll("</script", "<\\/script")}</script></body></html>`,
  ].join("");
  await page.route("https://vim.test/**", (route) =>
    route.fulfill({ status: 200, contentType: "text/html; charset=utf-8", body: html }),
  );
  await page.goto("https://vim.test/");
  const metrics = await page.evaluate<FontMetrics>(MEASURE_FONT);
  if (
    !metrics.loaded ||
    metrics.textHeight !== VIEWPORT.textHeight ||
    metrics.charWidth !== VIEWPORT.charWidth
  ) {
    throw new Error(
      `the oracle font doesn't lay out as the vectors record: got ${JSON.stringify(metrics)}, ` +
        `want textHeight ${VIEWPORT.textHeight} and charWidth ${VIEWPORT.charWidth}`,
    );
  }
  return Object.assign(page, { errors });
}
