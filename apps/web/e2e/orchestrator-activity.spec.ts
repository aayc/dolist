import { expect, type Page, test } from "./fixtures";
import { focusEditorEnd, openApp } from "./helpers";

/*
 * What the orchestrator is doing while you write, with the real keyboard, against the daemon's
 * live agent (the fake OpenRouter): its turns last long enough for every phase to show. The editor
 * saves 300 ms after the last key; the e2e vault settles lines after 800 ms.
 */

test.use({ daemonSpec: { agent: "live" } });

interface Seen {
  at: number;
  what: "chip" | "note" | "status";
  line?: string;
  kind?: string;
  text: string;
}

declare global {
  interface Window {
    __activitySeen?: Seen[];
    __activityTyped?: number;
  }
}

/** Records every chip, note-header and status-bar indicator change (phases can be short). */
async function recordActivity(page: Page): Promise<void> {
  await page.evaluate(() => {
    const seen: Seen[] = [];
    window.__activitySeen = seen;
    const last = new Map<string, string>();
    const note = (what: Seen["what"], key: string, entry: Omit<Seen, "at" | "what">) => {
      const value = `${entry.kind ?? ""}|${entry.text}`;
      if (last.get(key) === value) return;
      last.set(key, value);
      seen.push({ at: performance.now(), what, ...entry });
    };
    const scan = () => {
      for (const chip of document.querySelectorAll<HTMLElement>(".cm-ddl-activity-chip")) {
        const copy = chip.closest(".cm-line")?.cloneNode(true) as HTMLElement | undefined;
        for (const widget of copy?.querySelectorAll(".cm-ddl-badge") ?? []) widget.remove();
        const line = copy?.textContent ?? "";
        note("chip", `chip:${line}`, {
          line: line.trim(),
          kind: chip.dataset.kind ?? "",
          text: chip.textContent ?? "",
        });
      }
      const header = document.querySelector("[data-testid='note-orchestrator']");
      note("note", "note", { text: header?.textContent ?? "" });
      const status = document.querySelector("[data-testid='status-orchestrator']");
      note("status", "status", { text: status?.textContent ?? "" });
    };
    new MutationObserver(scan).observe(document.body, {
      subtree: true,
      childList: true,
      attributes: true,
      characterData: true,
    });
    scan();
  });
}

async function seen(page: Page): Promise<Seen[]> {
  return page.evaluate(() => window.__activitySeen ?? []);
}

/** Types a line on a fresh, empty line at the end of today's note (replacing the template). */
async function typeLine(
  page: Page,
  text: string,
  options: { first?: boolean } = {},
): Promise<number> {
  if (options.first) {
    await focusEditorEnd(page);
    await page.keyboard.press("ControlOrMeta+A");
  } else {
    await page.keyboard.press("ControlOrMeta+End");
    await page.keyboard.press("Enter");
  }
  await page.keyboard.type(text, { delay: 5 });
  return page.evaluate(() => performance.now());
}

function chipOn(page: Page, text: string) {
  return page.locator(".cm-line", { hasText: text }).locator(".cm-ddl-activity-chip");
}

test.describe("what the orchestrator is doing while you write", () => {
  test("a request line: a dot at once, then what it's doing, then the outcome that opens its thread", async ({
    page,
  }) => {
    test.setTimeout(60_000);
    await openApp(page);
    await recordActivity(page);
    const request = "Can you find a plumber for Saturday?";
    const typed = await typeLine(page, request, { first: true });

    const chip = chipOn(page, request);
    await expect(chip).toHaveText("Started a task ↗", { timeout: 15_000 });
    await expect(chip).toHaveAttribute("data-kind", "outcome");
    const chips = (await seen(page)).filter((s) => s.what === "chip" && s.line === request);
    const kinds = chips.map((s) => s.kind);
    expect(kinds[0]).toBe("noticed");
    expect(kinds).toContain("looking");
    expect(kinds.at(-1)).toBe("outcome");
    const dot = chips.find((s) => s.kind === "noticed")!;
    const looking = chips.find((s) => s.kind === "looking")!;
    const outcome = chips.find((s) => s.kind === "outcome")!;
    // The dot shows with the first save, a settle delay before the orchestrator's turn starts.
    expect(dot.at - typed).toBeLessThan(1_000);
    expect(looking.at - dot.at).toBeGreaterThanOrEqual(250);
    test.info().annotations.push({
      type: "timing",
      description: `dot ${Math.round(dot.at - typed)} ms after the last key, turn ${Math.round(looking.at - dot.at)} ms after the dot, outcome ${Math.round(outcome.at - dot.at)} ms after the dot; chips: ${kinds.join(" → ")}`,
    });

    const headers = (await seen(page)).filter((s) => s.what === "note").map((s) => s.text);
    expect(headers).toContain("Orchestrator: reading this note…");
    // The line got its thread (a badge) too; the chip opens it.
    await expect(
      page
        .locator(".cm-line", { hasText: request })
        .locator(".cm-ddl-badge:not(.cm-ddl-activity-chip)"),
    ).toBeVisible();
    await chip.hover();
    await expect(page.locator("#ddl-tooltip .tooltip-text")).toHaveText(
      `Started a task: ${request}`,
    );
    await page.screenshot({ path: test.info().outputPath("request-outcome.png") });
    await chip.click();
    await expect(page.getByTestId("thread-title")).toHaveText(request);
  });

  test("plain prose gets no chip; a note to self ends with a quick “Nothing to do”", async ({
    page,
  }) => {
    test.setTimeout(60_000);
    await openApp(page);
    await recordActivity(page);
    const prose = "Slept well, long walk by the river.";
    await typeLine(page, prose, { first: true });
    const todo = "TODO: water the ferns";
    await typeLine(page, todo);

    const chip = chipOn(page, todo);
    await expect(chip).toHaveText("Nothing to do", { timeout: 15_000 });
    const shownAt = await page.evaluate(() => performance.now());
    // It fades sooner than an outcome that did something (6 s).
    await expect(chip).toHaveCount(0, { timeout: 5_000 });
    const goneAfter = (await page.evaluate(() => performance.now())) - shownAt;
    expect(goneAfter).toBeLessThan(5_000);
    expect((await seen(page)).some((s) => s.what === "chip" && s.line === prose)).toBe(false);
    await expect(chipOn(page, prose)).toHaveCount(0);
  });

  test("editing the line beyond recognition drops its chip; typing on keeps it", async ({
    page,
  }) => {
    test.setTimeout(60_000);
    await openApp(page);
    const request = "Is the pharmacy open on Sunday?";
    await typeLine(page, request, { first: true });
    const chip = chipOn(page, request);
    await expect(chip).toHaveText("Replied ↗", { timeout: 15_000 });
    await page.keyboard.type(" And Monday", { delay: 5 });
    await expect(
      page.locator(".cm-line", { hasText: "And Monday" }).locator(".cm-ddl-activity-chip"),
    ).toHaveCount(1);
    await page.keyboard.press("ControlOrMeta+A");
    await page.keyboard.type("Call mom", { delay: 5 });
    await expect(page.locator(".cm-ddl-activity-chip")).toHaveCount(0);
  });

  test("the status bar says what it works on elsewhere", async ({ page }) => {
    test.setTimeout(60_000);
    await openApp(page);
    await recordActivity(page);
    await page.evaluate(() => window.__ddlDebug!.runCommand("agent:orchestrator"));
    const view = page.getByTestId("orchestrator-view");
    await view.getByTestId("composer-input").click();
    await page.keyboard.type("What are you working on?", { delay: 5 });
    await page.keyboard.press("Enter");
    await expect(
      view.getByTestId("message-text").filter({ hasText: "Nothing is running" }),
    ).toBeVisible();
    const statuses = async () =>
      (await seen(page)).filter((s) => s.what === "status").map((s) => s.text);
    expect(await statuses()).toContain("Orchestrator: working on your message");
    // Once the turn ends, the status bar says nothing again.
    await expect.poll(async () => (await statuses()).at(-1)).toBe("");
  });

  test("with reduced motion nothing pulses", async ({ page }) => {
    test.setTimeout(60_000);
    await page.emulateMedia({ reducedMotion: "reduce" });
    await openApp(page);
    const request = "Can you find a dentist near the office?";
    await typeLine(page, request, { first: true });
    const chip = chipOn(page, request);
    await expect(chip).toHaveAttribute("data-kind", /noticed|looking|working/);
    expect(
      await chip.locator(".cm-ddl-badge-icon").evaluate((el) => getComputedStyle(el).animationName),
    ).toBe("none");
  });
});
