import { fc, test } from "@fast-check/vitest";
import { describe, expect, it } from "vitest";
import { parseWikiLinks } from "../markdown/wikilinks";
import {
  DRAWING_PLACEMENTS,
  type DrawingEmbedSpec,
  drawingLinkTarget,
  findDrawingEmbeds,
  formatDrawingEmbed,
  isDrawingTarget,
  parseDrawingEmbed,
} from "./embed";

function parse(text: string, options?: { drawing?: boolean }) {
  const [link] = parseWikiLinks(text);
  const embed = link ? parseDrawingEmbed(link, options) : null;
  if (!embed) return null;
  const { from: _from, to: _to, ...spec } = embed;
  return spec;
}

describe("parseDrawingEmbed", () => {
  it.each<[string, Partial<DrawingEmbedSpec>]>([
    ["![[Plan.excalidraw]]", {}],
    ["![[Plan.excalidraw|360]]", { width: 360 }],
    ["![[Plan.excalidraw|360x240]]", { width: 360, height: 240 }],
    ["![[Plan.excalidraw|x240]]", { height: 240 }],
    ["![[Plan.excalidraw|50%]]", { widthPercent: 50 }],
    ["![[Plan.excalidraw|50%x200]]", { widthPercent: 50, height: 200 }],
    ["![[Plan.excalidraw|right-wrap]]", { placement: "right-wrap" }],
    ["![[Plan.excalidraw|360|right-wrap]]", { width: 360, placement: "right-wrap" }],
    ["![[Plan.excalidraw|360|left-wrap]]", { width: 360, placement: "left-wrap" }],
    ["![[Plan.excalidraw|360|left]]", { width: 360, placement: "left" }],
    ["![[Plan.excalidraw|360|right]]", { width: 360, placement: "right" }],
    ["![[Plan.excalidraw|360|center]]", { width: 360, placement: "center" }],
    ["![[Plan.excalidraw|My plan|360]]", { alias: "My plan", width: 360 }],
    ["![[Plan.excalidraw|My plan|left]]", { alias: "My plan", placement: "left" }],
    [
      "![[Plan.excalidraw|My plan|360x240|right-wrap]]",
      { alias: "My plan", width: 360, height: 240, placement: "right-wrap" },
    ],
    ["![[Plan.excalidraw|My plan|x|center]]", { alias: "My plan", placement: "center" }],
    ["![[Plan.excalidraw|a|360|b|right]]", { alias: "a", width: 360, placement: "right" }],
    ["![[Plan.excalidraw|360|dark]]", { width: 360, style: "dark" }],
    ["![[Plan.excalidraw|Right-Wrap]]", { style: "Right-Wrap" }],
    ["![[Plan.excalidraw| 360 | right-wrap ]]", { width: 360, placement: "right-wrap" }],
    ["![[Plan.excalidraw|0360]]", { style: "0360" }],
    ["![[Plan.excalidraw|0%]]", { style: "0%" }],
    ["![[Plan.excalidraw|0]]", { width: 0 }],
    ["![[Excalidraw/Plan.excalidraw.md#^group=abc|200]]", { subpath: "^group=abc", width: 200 }],
  ])("reads %s like the plugin", (text, expected) => {
    const target = parseWikiLinks(text)[0]!.target;
    expect(parse(text)).toEqual({ target, placement: "full", ...expected });
  });

  it("only takes embeds of drawings", () => {
    expect(parse("[[Plan.excalidraw|360]]")).toBeNull();
    expect(parse("![[Plan|360]]")).toBeNull();
    expect(parse("![[photo.png|360]]")).toBeNull();
    expect(parse("![[Plan|360|left]]", { drawing: true })).toEqual({
      target: "Plan",
      width: 360,
      placement: "left",
    });
  });

  it("finds every drawing embed in a note, with offsets", () => {
    const text =
      "Intro ![[a.excalidraw|300|right-wrap]] and [[b.excalidraw]]\n![[c.excalidraw.md]] ![[d.png]]";
    const embeds = findDrawingEmbeds(text);
    expect(embeds.map((e) => text.slice(e.from, e.to))).toEqual([
      "![[a.excalidraw|300|right-wrap]]",
      "![[c.excalidraw.md]]",
    ]);
  });
});

describe("formatDrawingEmbed", () => {
  it("writes the parts in the order the plugin reads them", () => {
    const target = "Drawing 2026-09-25 11.52.33.excalidraw";
    expect(formatDrawingEmbed({ target, width: 360, placement: "right-wrap" })).toBe(
      `![[${target}|360|right-wrap]]`,
    );
    expect(formatDrawingEmbed({ target, placement: "full" })).toBe(`![[${target}]]`);
    expect(formatDrawingEmbed({ target, placement: "left" })).toBe(`![[${target}|left]]`);
    expect(formatDrawingEmbed({ target, width: 360.4, height: 239.6, placement: "full" })).toBe(
      `![[${target}|360x240]]`,
    );
    expect(
      formatDrawingEmbed({ target, alias: "Plan", widthPercent: 50, placement: "center" }),
    ).toBe(`![[${target}|Plan|50%|center]]`);
    expect(
      formatDrawingEmbed({ target, subpath: "^frame=f1", height: 90, placement: "full" }),
    ).toBe(`![[${target}#^frame=f1|x90]]`);
    expect(formatDrawingEmbed({ target, width: 300, placement: "full", style: "dark" })).toBe(
      `![[${target}|300|dark]]`,
    );
  });

  const spec = fc
    .record(
      {
        target: fc.constantFrom(
          "Plan.excalidraw",
          "Excalidraw/Drawing 2026-09-25 11.52.33.excalidraw",
        ),
        subpath: fc.constantFrom("^group=abc", "^frame=f1"),
        alias: fc.constantFrom("My plan", "Überblick"),
        width: fc.integer({ min: 1, max: 4000 }),
        height: fc.integer({ min: 1, max: 4000 }),
        placement: fc.constantFrom(...DRAWING_PLACEMENTS),
      },
      { requiredKeys: ["target", "placement"] },
    )
    // The plugin reads a lone alias as a style, so an alias needs a size to be one.
    .filter(
      (embed) =>
        embed.alias === undefined || embed.width !== undefined || embed.height !== undefined,
    );

  test.prop([spec])("parses what it writes back to the same embed", (embed) => {
    expect(parse(formatDrawingEmbed(embed))).toEqual(embed);
  });

  test.prop([spec])("writes what it parses back to the same text", (embed) => {
    const text = formatDrawingEmbed(embed);
    expect(formatDrawingEmbed(parse(text)!)).toBe(text);
  });
});

describe("drawing link targets", () => {
  it("recognizes drawing targets", () => {
    expect(isDrawingTarget("Plan.excalidraw")).toBe(true);
    expect(isDrawingTarget("Excalidraw/Plan.excalidraw.md")).toBe(true);
    expect(isDrawingTarget("Plan.EXCALIDRAW")).toBe(true);
    expect(isDrawingTarget("Plan.md")).toBe(false);
  });

  it("links by file name unless another file has the same name", () => {
    const path = "Excalidraw/Drawing 2026-09-25 11.52.33.excalidraw.md";
    expect(drawingLinkTarget(path, [path, "Daily/2026-09-25.md"])).toBe(
      "Drawing 2026-09-25 11.52.33.excalidraw",
    );
    expect(drawingLinkTarget("Excalidraw/Plan.excalidraw.md", ["Old/plan.excalidraw.md"])).toBe(
      "Excalidraw/Plan.excalidraw",
    );
  });
});
