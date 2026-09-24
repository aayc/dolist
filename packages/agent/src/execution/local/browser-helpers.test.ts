import { describe, expect, it } from "vitest";
import { NavigationBlockedError } from "../errors";
import { type ResolveBrowserDeps, resolveBrowserExecutable } from "./browser-executable";
import { normalizeBrowserKey } from "./browser-keys";
import {
  describeRefs,
  fieldRefsWithValues,
  formatSnapshot,
  maskFieldValues,
  normalizeRef,
  VALUE_MASK,
} from "./browser-snapshot";
import { capText, collapseWhitespace } from "./browser-text";
import { normalizeNavigationUrl } from "./browser-url";

const SNAPSHOT = `- generic [ref=e1]:
  - heading "Welcome" [level=1] [ref=e2]
  - link "Next page" [ref=e4] [cursor=pointer]:
    - /url: /next
  - textbox "User" [ref=e3]: alice
  - textbox "Password" [active] [ref=e5]: s3cret
  - 'textbox "Note: private" [ref=e9]': "yes: no"
  - textbox "Empty" [ref=e6]
  - combobox "Color" [ref=e10]:
    - option "Red" [selected]
  - iframe [ref=e12]:
    - textbox "Card number" [ref=f1e2]: 4242 4242
  - text: plain text
  - button "Go [ref=e99]" [ref=e11]`;

describe("normalizeNavigationUrl", () => {
  it("accepts http(s) and about:blank, adding a scheme to bare hosts", () => {
    expect(normalizeNavigationUrl("https://example.com/a?b=1").href).toBe(
      "https://example.com/a?b=1",
    );
    expect(normalizeNavigationUrl("  example.com/path ").href).toBe("https://example.com/path");
    expect(normalizeNavigationUrl("localhost:3000/x").href).toBe("http://localhost:3000/x");
    expect(normalizeNavigationUrl("127.0.0.1:8080").href).toBe("http://127.0.0.1:8080/");
    expect(normalizeNavigationUrl("HTTP://Example.com").href).toBe("http://example.com/");
    expect(normalizeNavigationUrl("about:blank").href).toBe("about:blank");
  });

  it.each([
    "file:///etc/passwd",
    "FILE:///etc/passwd",
    "chrome://settings",
    "chrome-extension://abc/page.html",
    "javascript:alert(1)",
    " JavaScript:alert(1)",
    "data:text/html,<script>alert(1)</script>",
    "view-source:https://example.com",
    "about:config",
    "ftp://example.com/file",
    "blob:https://example.com/uuid",
    "",
  ])("refuses %j", (url) => {
    expect(() => normalizeNavigationUrl(url)).toThrow(NavigationBlockedError);
  });
});

describe("snapshot helpers", () => {
  it("normalizes refs in the forms models tend to write", () => {
    expect(normalizeRef("e5")).toBe("e5");
    expect(normalizeRef(" ref=e5 ")).toBe("e5");
    expect(normalizeRef("[ref=e5]")).toBe("e5");
    expect(normalizeRef("@f1e2")).toBe("f1e2");
    expect(normalizeRef("button")).toBeUndefined();
    expect(normalizeRef("e5; drop")).toBeUndefined();
  });

  it("finds field refs that render a value", () => {
    expect(fieldRefsWithValues(SNAPSHOT)).toEqual(["e3", "e5", "e9", "f1e2"]);
  });

  it("masks the values of selected refs only", () => {
    const masked = maskFieldValues(SNAPSHOT, new Set(["e5", "e9", "f1e2"]));
    expect(masked).toContain('textbox "User" [ref=e3]: alice');
    expect(masked).toContain(`textbox "Password" [active] [ref=e5]: ${VALUE_MASK}`);
    expect(masked).toContain(`'textbox "Note: private" [ref=e9]': ${VALUE_MASK}`);
    expect(masked).toContain(`textbox "Card number" [ref=f1e2]: ${VALUE_MASK}`);
    expect(masked).not.toMatch(/s3cret|4242|yes: no/);
    expect(masked.split("\n")).toHaveLength(SNAPSHOT.split("\n").length);
  });

  it("describes refs by role and name, ignoring ref-like text inside names", () => {
    const refs = describeRefs(SNAPSHOT);
    expect(refs.get("e4")).toBe('link "Next page"');
    expect(refs.get("e11")).toBe('button "Go [ref=e99]"');
    expect(refs.has("e99")).toBe(false);
  });

  it("truncates at line boundaries with a notice and shortens long URLs", () => {
    const lines = Array.from({ length: 200 }, (_, i) => `- button "Button ${i}" [ref=e${i}]`);
    const out = formatSnapshot(lines.join("\n"), 1_000);
    expect(out.length).toBeLessThan(1_200);
    expect(out).toMatch(/\[\.\.\. snapshot truncated: showing \d+ of 200 lines/);
    for (const line of out.split("\n").slice(0, -1)) expect(line).toMatch(/\[ref=e\d+\]$/);

    const long = formatSnapshot(
      `- link "x" [ref=e1]:\n  - /url: https://example.com/${"a".repeat(400)}`,
    );
    expect(long).toMatch(/\/url: https:\/\/example\.com\/a+…$/);
    expect(long.length).toBeLessThan(200);
    expect(formatSnapshot("  \n")).toBe("(empty page)");
  });
});

describe("normalizeBrowserKey", () => {
  it.each([
    ["enter", "Enter"],
    ["Return", "Enter"],
    ["esc", "Escape"],
    ["ctrl+a", "Control+a"],
    ["cmd+shift+t", "Meta+Shift+t"],
    ["down", "ArrowDown"],
    ["PageDown", "PageDown"],
    ["f5", "F5"],
    ["mod+k", "ControlOrMeta+k"],
    ["Control++", "Control++"],
    ["a", "a"],
  ])("%s → %s", (input, expected) => {
    expect(normalizeBrowserKey(input)).toBe(expected);
  });

  it("rejects empty keys", () => {
    expect(() => normalizeBrowserKey("  ")).toThrow();
  });
});

describe("text helpers", () => {
  it("collapses whitespace but keeps paragraph breaks", () => {
    expect(collapseWhitespace("  Big   story \r\n\r\n\r\n\tFirst\u00a0 para  \n\n\n\nEnd ")).toBe(
      "Big story\n\nFirst para\n\nEnd",
    );
  });

  it("caps text with a notice", () => {
    expect(capText("abcdef", 10)).toBe("abcdef");
    expect(capText("abcdef", 3)).toBe("abc\n[... truncated: 3 more characters ...]");
  });
});

describe("resolveBrowserExecutable", () => {
  const deps = (existing: string[], platform: NodeJS.Platform = "darwin"): ResolveBrowserDeps => ({
    platform,
    env: {},
    home: "/home/user",
    exists: (path) => existing.includes(path),
    playwrightChromium: () => "/cache/ms-playwright/chromium/chrome",
  });
  const mac = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

  it("prefers an explicit executable, then the channel, then Playwright's Chromium", () => {
    expect(
      resolveBrowserExecutable(
        { executablePath: "/opt/custom/chrome" },
        deps(["/opt/custom/chrome", mac]),
      ),
    ).toEqual({
      executablePath: "/opt/custom/chrome",
      source: "config",
    });
    expect(resolveBrowserExecutable({ executablePath: "/missing" }, deps([mac]))).toEqual({
      executablePath: mac,
      source: "chrome",
    });
    expect(resolveBrowserExecutable({}, deps(["/cache/ms-playwright/chromium/chrome"]))).toEqual({
      executablePath: "/cache/ms-playwright/chromium/chrome",
      source: "playwright-chromium",
    });
    expect(resolveBrowserExecutable({}, deps([]))).toBeUndefined();
  });

  it("knows per-user macOS installs and Linux/Edge locations", () => {
    const userChrome = "/home/user/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
    expect(resolveBrowserExecutable({}, deps([userChrome]))?.executablePath).toBe(userChrome);
    expect(resolveBrowserExecutable({}, deps(["/opt/google/chrome/chrome"], "linux"))?.source).toBe(
      "chrome",
    );
    expect(
      resolveBrowserExecutable(
        { channel: "msedge" },
        deps(["/opt/microsoft/msedge/msedge"], "linux"),
      )?.source,
    ).toBe("msedge");
  });
});
