import { describe, expect, it } from "vitest";

/*
 * Shortcuts show as keycaps looked up from the command registry, never as text in a tooltip or a
 * control's name, and every tooltip goes through the tooltip layer (`data-tooltip`), not `title`.
 */

const sources: Record<string, string> = {
  ...import.meta.glob<string>(["../**/*.{ts,tsx}", "!../**/*.test.{ts,tsx}"], {
    query: "?raw",
    import: "default",
    eager: true,
  }),
  ...import.meta.glob<string>(
    ["../../../../packages/editor/src/**/*.ts", "!../../../../packages/editor/src/**/*.test.ts"],
    { query: "?raw", import: "default", eager: true },
  ),
};

/** Glyphs and spelled-out chords that only a shortcut would put in text. */
const SHORTCUT_TEXT = /[⌘⇧⌥⌃⎋↩⇥]|\b(?:Ctrl|Cmd|Alt|Shift|Meta)\+\S|\((?:Esc|Enter|Return|Tab)\)/;

/** A string literal (group 2) closed by the quote that opened it. */
const LITERAL = String.raw`(["'${"`"}])((?:(?!\1)[^\\]|\\.)*)\1`;

/** Tooltip texts and control names written in source: attributes, props and assignments. */
const TEXT_SITES = [
  String.raw`\bdata-tooltip=\{?\s*`,
  String.raw`\b(?:aria-)?label=\{?\s*`,
  String.raw`\bdataset\.tooltip\s*=\s*`,
  String.raw`\b(?:name|label|title|tooltip):\s*`,
  String.raw`\bTITLE\w*\s*=\s*`,
].map((site) => new RegExp(site + LITERAL, "g"));

function texts(source: string): string[] {
  return TEXT_SITES.flatMap((site) => [...source.matchAll(site)].map((m) => m[2] ?? ""));
}

describe("tooltip and control text", () => {
  it("finds the sources to check", () => {
    const files = Object.keys(sources);
    expect(files.some((f) => f.endsWith("components/IconButton.tsx"))).toBe(true);
    expect(files.some((f) => f.endsWith("annotations/widget.ts"))).toBe(true);
    expect(texts(sources["../commands/default-commands.ts"] ?? "")).toContain("New note");
  });

  it("never spells out a shortcut: keycaps come from the command registry", () => {
    const offenders = Object.entries(sources).flatMap(([file, source]) =>
      texts(source)
        .filter((text) => SHORTCUT_TEXT.test(text))
        .map((text) => `${file}: "${text}"`),
    );
    expect(offenders).toEqual([]);
  });

  it("catches the patterns it guards against", () => {
    const bad = [
      '<button data-tooltip="Close tab (⌘W)">',
      '<IconButton label="Open the agent inbox (Ctrl+Shift+A)" />',
      'glyph.dataset.tooltip = "Open today\'s note (⇧⌘D)";',
      '{ id: "x", name: "Close (Esc)" }',
    ];
    for (const source of bad) expect(texts(source).some((t) => SHORTCUT_TEXT.test(t))).toBe(true);
    expect(
      texts('<button data-tooltip="Toggle light/dark theme">').some((t) => SHORTCUT_TEXT.test(t)),
    ).toBe(false);
  });

  it("uses the tooltip layer instead of native title tooltips", () => {
    const offenders: string[] = [];
    for (const [file, source] of Object.entries(sources)) {
      for (const match of source.matchAll(/\stitle=/g)) {
        const tag = /^<([A-Za-z][\w.]*)/.exec(source.slice(source.lastIndexOf("<", match.index)));
        const name = tag?.[1] ?? "";
        // Components take `title` props; an iframe's title is its accessible name.
        if (/^[a-z]/.test(name) && name !== "iframe") offenders.push(`${file}: <${name} title>`);
      }
      if (/\.title\s*=(?!=)/.test(source) && !file.includes("/api/mock/")) {
        offenders.push(`${file}: .title =`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
