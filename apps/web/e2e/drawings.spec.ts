import type { Locator, Page } from "@playwright/test";
import { type Daemon, expect, test } from "./fixtures";
import { noteTitle, openApp } from "./helpers";

/**
 * Drawings in notes, with the real keyboard and mouse: inserting one, drawing in Excalidraw,
 * text wrapping around it, moving and resizing it, saving, reloading, opening the file itself.
 */

const NOTE = "Drawing test.md";
const WORDS = "Words that wrap around the drawing beside them, sentence after sentence.";
const PARAGRAPH = Array.from({ length: 5 }, () => WORDS).join(" ");
const DEMO = "Garden plan.excalidraw";

function noteWith(lines: readonly string[]): string {
  return ["# Drawing test", "", ...lines].join("\n");
}

async function openNote(page: Page, daemon: Daemon, content: string): Promise<void> {
  await daemon.write(NOTE, content);
  await openApp(page);
  await page.evaluate((path) => window.__ddlDebug!.openNote(path), NOTE);
  await expect(noteTitle(page)).toHaveValue("Drawing test");
}

function savedNote(daemon: Daemon): Promise<string | null> {
  return daemon.read(NOTE);
}

async function newDrawingPath(daemon: Daemon): Promise<string> {
  const paths = await daemon.list();
  const path = paths.find((p) => /^Excalidraw\/Drawing .+\.excalidraw\.md$/.test(p));
  if (!path) throw new Error(`no new drawing among ${paths.join(", ")}`);
  return path;
}

function drawingFile(daemon: Daemon, path: string): Promise<string | null> {
  return daemon.read(path);
}

function drawing(page: Page): Locator {
  return page.locator(".cm-ddl-embed-drawing");
}

async function center(locator: Locator): Promise<{ x: number; y: number }> {
  const box = await locator.boundingBox();
  if (!box) throw new Error("not visible");
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

/** Drags with the real mouse, in steps like a hand. */
async function drag(page: Page, from: { x: number; y: number }, to: { x: number; y: number }) {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(from.x + (to.x - from.x) / 4, from.y + (to.y - from.y) / 4, { steps: 4 });
  await page.mouse.move(to.x, to.y, { steps: 12 });
  await page.mouse.up();
}

/** In the open editor: a rectangle (R) and an arrow (A), each dragged out on the canvas. */
async function drawRectangleAndArrow(page: Page): Promise<void> {
  const overlay = page.getByTestId("drawing-editor");
  await expect(overlay.locator(".excalidraw canvas").first()).toBeVisible({ timeout: 20_000 });
  const box = (await overlay.boundingBox())!;
  const at = (fx: number, dy: number) => ({ x: box.x + box.width * fx, y: box.y + dy });
  await page.keyboard.press("r");
  await drag(page, at(0.3, 110), at(0.45, 190));
  await page.keyboard.press("a");
  await drag(page, at(0.5, 150), at(0.7, 230));
}

/** Text of lines beside the drawing never reaches into its box. */
async function expectTextBeside(page: Page): Promise<void> {
  const overlaps = await page.evaluate(() => {
    const frame = document.querySelector(".cm-ddl-embed-drawing")!.getBoundingClientRect();
    const found: string[] = [];
    let beside = 0;
    for (const line of document.querySelectorAll(".cm-line")) {
      if (line.querySelector(".cm-ddl-embed")) continue;
      const range = document.createRange();
      range.selectNodeContents(line);
      for (const rect of range.getClientRects()) {
        if (rect.width === 0 || rect.bottom <= frame.top || rect.top >= frame.bottom) continue;
        beside++;
        const left = Math.max(rect.left, frame.left);
        const right = Math.min(rect.right, frame.right);
        if (right - left > 1)
          found.push(`${line.textContent?.slice(0, 30)} ${rect.left}-${rect.right}`);
      }
    }
    return { found, beside };
  });
  expect(overlaps.beside).toBeGreaterThan(2);
  expect(overlaps.found).toEqual([]);
}

test.describe("drawings", () => {
  test("insert one, draw in it, and the note wraps around it", async ({ page, daemon }) => {
    const requests: string[] = [];
    page.on("request", (request) => requests.push(request.url()));
    // The daemon's CSP stops Excalidraw's CDN fallbacks before they leave the machine.
    page.on("requestfailed", (request) => {
      const at = requests.indexOf(request.url());
      if (request.failure()?.errorText === "csp" && at >= 0) requests.splice(at, 1);
    });
    await openNote(page, daemon, noteWith([PARAGRAPH, "", PARAGRAPH, "", "Last line."]));
    await page.locator(".cm-line", { hasText: WORDS }).first().click();
    await page.getByTestId("insert-drawing").click();

    const overlay = page.getByTestId("drawing-editor");
    await expect(overlay).toBeVisible();
    await drawRectangleAndArrow(page);
    await page.keyboard.press("Escape");
    await expect(overlay).toBeHidden();

    // Saved: the file has both elements, with the Obsidian plugin's 8-character ids.
    const path = await newDrawingPath(daemon);
    await expect.poll(() => drawingFile(daemon, path)).toContain('"type": "arrow"');
    const file = (await drawingFile(daemon, path))!;
    expect(file).toContain("excalidraw-plugin: parsed");
    expect(file).toContain('"type": "rectangle"');
    expect([...file.matchAll(/"id": "([^"]+)"/g)].map((m) => m[1]!.length)).toEqual([8, 8]);
    const name = path.slice("Excalidraw/".length, -".md".length);
    await expect
      .poll(() => savedNote(daemon))
      .toBe(noteWith([`![[${name}|360|right-wrap]]`, PARAGRAPH, "", PARAGRAPH, "", "Last line."]));

    // Drawn in the note: floated right, selected again after Escape, the text wrapping around it.
    const box = drawing(page);
    await expect(box).toHaveClass(/cm-ddl-embed-right-wrap/);
    await expect(box).toHaveClass(/is-selected/);
    await expect(box.locator("svg path").first()).toBeVisible();
    expect((await box.boundingBox())!.width).toBeCloseTo(360, 0);
    await expectTextBeside(page);

    // Typing beside it never overlaps it.
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("End");
    await page.keyboard.type(" More words typed beside the drawing to make this line wrap again.");
    await expectTextBeside(page);

    // Enter on the selected drawing edits it again.
    await box.click();
    await page.keyboard.press("Enter");
    await expect(overlay).toBeVisible();
    await page.getByTestId("drawing-done").click();
    await expect(overlay).toBeHidden();

    // Fonts and everything else come from the app itself, never a CDN.
    const origin = new URL(page.url()).origin;
    expect(requests.filter((url) => !url.startsWith(origin) && !url.startsWith("data:"))).toEqual(
      [],
    );
  });

  test("move it to the other side and another line, resize it, delete it", async ({
    page,
    daemon,
  }) => {
    await openNote(
      page,
      daemon,
      noteWith([`![[${DEMO}|300|right-wrap]]`, PARAGRAPH, "", "Last line."]),
    );
    const box = drawing(page);
    await expect(box.locator("svg")).toBeVisible();
    await box.click();
    await expect(box).toHaveClass(/is-selected/);

    // Dragged by its middle: its top edge picks the line, its center the side.
    const column = (await page.locator(".cm-content").boundingBox())!;
    const grab = async () => {
      const frame = (await drawing(page).boundingBox())!;
      return { point: await center(drawing(page)), toTop: frame.height / 2 };
    };

    // To the left side, before "Last line.".
    const lastBox = (await page.locator(".cm-line", { hasText: "Last line." }).boundingBox())!;
    const first = await grab();
    await drag(page, first.point, { x: column.x + 120, y: lastBox.y + 2 + first.toTop });
    await expect
      .poll(() => savedNote(daemon))
      .toBe(noteWith([PARAGRAPH, "", `![[${DEMO}|300|left-wrap]]`, "Last line."]));
    await expect(drawing(page)).toHaveClass(/cm-ddl-embed-left-wrap/);
    expect((await drawing(page).boundingBox())!.x).toBeLessThan(column.x + column.width / 3);

    // Back to the right, on the same line: only the side changes.
    const second = await grab();
    await drag(page, second.point, {
      x: column.x + column.width - 120,
      y: second.point.y - 4,
    });
    await expect
      .poll(() => savedNote(daemon))
      .toBe(noteWith([PARAGRAPH, "", `![[${DEMO}|300|right-wrap]]`, "Last line."]));

    // Wider by 100 px from its free corner (a right float grows to the left).
    const handle = drawing(page).locator(".cm-ddl-embed-resize-start");
    await expect(handle).toBeVisible();
    const start = await center(handle);
    await drag(page, start, { x: start.x - 100, y: start.y + 20 });
    await expect
      .poll(() => savedNote(daemon))
      .toBe(noteWith([PARAGRAPH, "", `![[${DEMO}|400|right-wrap]]`, "Last line."]));
    await expect.poll(async () => (await drawing(page).boundingBox())!.width).toBeCloseTo(400, 0);

    // Delete removes the embed (the file stays); undo brings it back.
    await expect(drawing(page)).toHaveClass(/is-selected/);
    await page.keyboard.press("Delete");
    await expect(drawing(page)).toHaveCount(0);
    await expect.poll(() => savedNote(daemon)).toBe(noteWith([PARAGRAPH, "", "Last line."]));
    await page.keyboard.press("ControlOrMeta+z");
    await expect(drawing(page)).toBeVisible();
    expect(await daemon.list()).toContain(`Excalidraw/${DEMO}.md`);
  });

  test("in vim mode, a selected drawing still takes Enter, Escape and Delete", async ({
    page,
    daemon,
  }) => {
    const embed = `![[${DEMO}|300|right-wrap]]`;
    await openNote(page, daemon, noteWith([embed, PARAGRAPH]));
    await page.evaluate(() => window.__ddlDebug!.runCommand("editor:vim"));
    await expect(page.getByTestId("status-vim")).toHaveAttribute("data-mode", "normal");
    const box = drawing(page);
    await expect(box.locator("svg")).toBeVisible();
    await box.click();
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("drawing-editor")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("drawing-editor")).toBeHidden();
    await expect(box).toHaveClass(/is-selected/);
    await page.keyboard.press("Delete");
    await expect(box).toHaveCount(0);
    await expect.poll(() => savedNote(daemon)).toBe(noteWith([PARAGRAPH]));
    // Back in the note, in normal mode: vim's undo restores the line.
    await page.keyboard.press("u");
    await expect.poll(() => savedNote(daemon)).toBe(noteWith([embed, PARAGRAPH]));
  });

  test("it's saved: a reload shows it, and the file opens full size", async ({ page, daemon }) => {
    await openNote(page, daemon, noteWith([PARAGRAPH]));
    await page.locator(".cm-line", { hasText: WORDS }).first().click();
    await page.keyboard.press("ControlOrMeta+Shift+X");
    await drawRectangleAndArrow(page);
    await page.keyboard.press("Escape");
    const path = await newDrawingPath(daemon);
    await expect.poll(() => drawingFile(daemon, path)).toContain('"type": "arrow"');
    await expect.poll(() => savedNote(daemon)).toContain("|360|right-wrap]]");

    await page.reload();
    await expect(page.getByTestId("note-title")).toBeVisible();
    await page.evaluate((note) => window.__ddlDebug!.openNote(note), NOTE);
    await expect(drawing(page).locator("svg path").first()).toBeVisible({ timeout: 20_000 });

    // The context menu opens the drawing itself: Excalidraw over the pane, not its markdown.
    await drawing(page).click({ button: "right" });
    await page.getByRole("menuitem", { name: "Open drawing" }).click();
    const pane = page.getByTestId("drawing-pane");
    await expect(pane.locator(".excalidraw canvas").first()).toBeVisible({ timeout: 20_000 });
    await expect(page.getByTestId("editor-host")).toBeHidden();
    await expect(page.getByTestId("tab").last()).toHaveAttribute("data-path", path);
  });

  test("an image goes into a drawing through the file picker, shrunk and saved", async ({
    page,
    daemon,
  }) => {
    await openNote(page, daemon, noteWith([PARAGRAPH]));
    await page.locator(".cm-line", { hasText: WORDS }).first().click();
    await page.keyboard.press("ControlOrMeta+Shift+X");
    const overlay = page.getByTestId("drawing-editor");
    await expect(overlay.locator(".excalidraw canvas").first()).toBeVisible({ timeout: 20_000 });
    // A 3000 × 20 PNG, drawn in the page: Excalidraw shrinks images wider than 1440 px.
    const png = await page.evaluate(async () => {
      const canvas = document.createElement("canvas");
      canvas.width = 3000;
      canvas.height = 20;
      const context = canvas.getContext("2d")!;
      context.fillStyle = "#e03131";
      context.fillRect(0, 0, 3000, 20);
      const blob = await new Promise<Blob>((resolve) =>
        canvas.toBlob((b) => resolve(b!), "image/png"),
      );
      return [...new Uint8Array(await blob.arrayBuffer())];
    });
    const chooser = page.waitForEvent("filechooser");
    await page.keyboard.press("9");
    await (await chooser).setFiles({
      name: "stripe.png",
      mimeType: "image/png",
      buffer: Buffer.from(png),
    });
    const box = (await overlay.boundingBox())!;
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    await page.getByTestId("drawing-done").click();
    await expect(overlay).toBeHidden();
    const path = await newDrawingPath(daemon);
    await expect.poll(() => drawingFile(daemon, path)).toContain('"type": "image"');
    const file = (await drawingFile(daemon, path))!;
    expect(file).toContain('"mimeType": "image/png"');
    const dataURL = /"dataURL": "(data:image\/png;base64,[^"]+)"/.exec(file)![1]!;
    const width = await page.evaluate(async (src) => {
      const image = new Image();
      image.src = src;
      await image.decode();
      return image.naturalWidth;
    }, dataURL);
    expect(width).toBeLessThanOrEqual(1440);
    await expect(drawing(page).locator("svg image")).toHaveCount(1);
  });

  test("a change made elsewhere shows at once, and Insert drawing is in the palette and menu", async ({
    page,
    daemon,
  }) => {
    await openNote(page, daemon, noteWith([`![[${DEMO}|300|left-wrap]]`, PARAGRAPH]));
    const box = drawing(page);
    await expect(box.locator("svg")).toBeVisible();
    const before = await box.locator("svg").innerHTML();
    const file = `Excalidraw/${DEMO}.md`;
    const text = (await daemon.read(file))!;
    await daemon.write(
      file,
      text.replace('"backgroundColor": "#b2f2bb"', '"backgroundColor": "#ffc9c9"'),
    );
    await expect.poll(() => box.locator("svg").innerHTML()).not.toBe(before);

    await page.locator(".cm-line", { hasText: WORDS }).first().click();
    await page.keyboard.press("ControlOrMeta+p");
    await page.keyboard.type("Insert drawing");
    await page.keyboard.press("Enter");
    const overlay = page.getByTestId("drawing-editor");
    await expect(overlay).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(overlay).toBeHidden();
    await expect(drawing(page)).toHaveCount(2);

    await page.locator(".cm-line", { hasText: WORDS }).first().click({ button: "right" });
    await page.getByRole("menuitem", { name: "Insert drawing" }).click();
    await expect(overlay).toBeVisible();
    await page.mouse.click(5, 450);
    await expect(overlay).toBeHidden();
    await expect(drawing(page)).toHaveCount(3);
  });
});
