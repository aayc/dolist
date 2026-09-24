import { expect, test } from "@playwright/test";
import { openApp } from "./helpers";

test.describe("agent markdown rendering", () => {
  test("sanitizes agent output and opens links in a new tab", async ({ page }) => {
    await openApp(page);
    const render = (source: string) =>
      page.evaluate((s) => window.__ddlDebug!.renderMarkdown(s), source);

    const table = await render("**Option A** wins\n\n| a | b |\n| - | - |\n| 1 | 2 |");
    expect(table).toContain("<strong>Option A</strong>");
    expect(table).toContain("<table>");

    const hostile = await render(
      '<script>alert(1)</script><img src="x" onerror="alert(2)"><form action="https://evil.example"><button>Pay</button></form>\n\n[bad](javascript:alert(3))',
    );
    expect(hostile).not.toContain("<script");
    expect(hostile).not.toContain("onerror");
    expect(hostile).not.toMatch(/href="javascript:/i);
    expect(hostile).not.toContain("<form");
    expect(hostile).not.toContain("<button");

    const link = await render("[docs](https://example.com)");
    expect(link).toContain('target="_blank"');
    expect(link).toContain('rel="noopener noreferrer"');
  });
});
