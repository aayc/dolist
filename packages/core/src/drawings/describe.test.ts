import { describe, expect, it } from "vitest";
import { SceneBuilder } from "../testing/drawing-scenes";
import { DRAWING_DESCRIPTION_MAX_LENGTH, describeDrawing } from "./describe";
import { type DrawingScene, emptyDrawingScene } from "./types";

const describeAs = (builder: SceneBuilder, title = "Test") =>
  describeDrawing(builder.build(), { title });

describe("describeDrawing", () => {
  it("describes an empty drawing", () => {
    expect(describeDrawing(emptyDrawingScene(), { title: "Blank" })).toBe(
      "Drawing “Blank” (empty)",
    );
    const onlyDeleted = new SceneBuilder().rect("r", 0, 0).delete("r");
    expect(describeAs(onlyDeleted, "Blank")).toBe("Drawing “Blank” (empty)");
  });

  it("names shapes by their labels and arrows by what they connect", () => {
    const scene = new SceneBuilder()
      .rect("api", 0, 0)
      .label("api", "apiText", "API")
      .rect("db", 400, 0)
      .label("db", "dbText", "DB")
      .arrow("a1", [160, 40], [400, 40], { start: "api", end: "db" })
      .label("a1", "a1Text", "SQL")
      .shape("ellipse", "cache", 400, 200, 120, 80)
      .arrow("a2", [460, 80], [460, 190], { start: "db" })
      .text("draft", 0, 250, "Draft");
    expect(describeAs(scene, "System")).toBe(
      [
        "Drawing “System” (560×280 px, 9 elements)",
        "Text: “Draft”",
        "Shapes: rectangle “API”, rectangle “DB”, 1 unlabeled ellipse",
        "Arrows: “API” → “DB” labeled “SQL”, arrow from “DB” to near an ellipse",
      ].join("\n"),
    );
  });

  it("follows arrowheads for the direction", () => {
    const scene = new SceneBuilder()
      .rect("a", 0, 0)
      .label("a", "at", "A")
      .rect("b", 400, 0)
      .label("b", "bt", "B")
      .arrow("back", [160, 20], [400, 20], {
        start: "a",
        end: "b",
        startArrowhead: "arrow",
        endArrowhead: null,
      })
      .arrow("both", [160, 40], [400, 40], { start: "a", end: "b", startArrowhead: "triangle" })
      .arrow("none", [160, 60], [400, 60], { start: "a", end: "b", endArrowhead: null });
    expect(describeAs(scene).split("\n")[2]).toBe("Arrows: “B” → “A”, “A” ↔ “B”, “A” — “B”");
  });

  it("describes unbound arrows by what their ends are near, if anything", () => {
    const scene = new SceneBuilder()
      .rect("box", 0, 0, 100, 100)
      .label("box", "boxText", "Inbox")
      .text("note", 600, 0, "Later")
      .arrow("near", [110, 50], [590, 10])
      .arrow("half", [130, 60], [400, 300])
      .arrow("lost", [300, 500], [400, 500]);
    expect(describeAs(scene).split("\n")[3]).toBe(
      "Arrows: arrow from near “Inbox” to near “Later”, arrow from near “Inbox”, arrow",
    );
  });

  it("prefers the smallest element an arrow ends inside", () => {
    const scene = new SceneBuilder()
      .frame("f", 0, 0, 1000, 1000, "Everything", [])
      .rect("outer", 100, 100, 600, 600)
      .label("outer", "outerText", "Outer")
      .rect("inner", 200, 200, 100, 100)
      .label("inner", "innerText", "Inner")
      .arrow("a", [900, 900], [250, 250]);
    expect(describeAs(scene)).toContain("Arrows: arrow to near “Inner”");
  });

  it("counts lines and freehand strokes with where they are", () => {
    const scene = new SceneBuilder()
      .rect("r", 0, 0, 900, 900)
      .scribble("s1", 10, 10)
      .scribble("s2", 80, 20)
      .scribble("s3", 800, 820)
      .line("l1", [
        [300, 450],
        [600, 450],
      ]);
    const text = describeAs(scene);
    expect(text).toContain("Lines: 1 line, center");
    expect(text).toContain("Freehand: 3 freehand strokes: 2 top left, 1 bottom right");
    const alone = new SceneBuilder().scribble("s1", 0, 0).scribble("s2", 10, 10);
    expect(describeAs(alone)).toContain("Freehand: 2 freehand strokes, center");
  });

  it("lists frames with what they hold", () => {
    const scene = new SceneBuilder()
      .rect("api", 20, 20)
      .label("api", "apiText", "API")
      .shape("diamond", "d", 20, 150, 60, 60)
      .text("t", 100, 150, "Owner: platform")
      .arrow("a", [100, 100], [100, 140])
      .scribble("s", 150, 150)
      .frame("backend", 0, 0, 300, 300, "Backend", ["api", "apiText", "d", "t", "a", "s"])
      .frame("empty", 400, 0, 100, 100, null, []);
    expect(describeAs(scene).split("\n").at(-1)).toBe(
      "Frames: frame “Backend” with rectangle “API”, “Owner: platform”, 1 unlabeled diamond, 1 arrow, 1 freehand stroke; frame (empty)",
    );
  });

  it("counts images and element types it doesn't know", () => {
    const scene = new SceneBuilder()
      .image("img", 0, 0, 100, 100, "f1")
      .other("embeddable", "e1", 200, 0)
      .other("embeddable", "e2", 400, 0)
      .other("iframe", "i1", 600, 0);
    expect(describeAs(scene)).toBe(
      [
        "Drawing “Test” (700×100 px, 4 elements)",
        "Images: 1 image",
        "Other: 2 embeddables, 1 iframe",
      ].join("\n"),
    );
  });

  it("treats a label whose container was deleted as free text", () => {
    const scene = new SceneBuilder().rect("r", 0, 0).label("r", "rt", "Orphan").delete("r");
    expect(describeAs(scene)).toContain("Text: “Orphan”");
  });

  it("flattens whitespace and clips long labels", () => {
    const long = "word ".repeat(30);
    const scene = new SceneBuilder()
      .text("t1", 0, 0, "  Two\n\tlines\u00a0here  ")
      .rect("r", 0, 100)
      .label("r", "rt", long);
    const text = describeAs(scene, "  My\ndrawing ");
    expect(text.split("\n")[0]).toMatch(/^Drawing “My drawing” /);
    expect(text).toContain("Text: “Two lines here”");
    expect(text).toContain(`Shapes: rectangle “${"word ".repeat(11)}word…”`);
  });

  it("stays within the limit and says it was shortened", () => {
    const builder = new SceneBuilder();
    for (let i = 0; i < 400; i++) {
      builder.rect(`r${i}`, (i % 20) * 200, Math.floor(i / 20) * 120);
      builder.label(`r${i}`, `t${i}`, `Service number ${i}`);
    }
    for (let i = 0; i < 50; i++) builder.scribble(`s${i}`, i * 30, 5000);
    const text = describeAs(builder, "Big");
    expect(Array.from(text).length).toBeLessThanOrEqual(DRAWING_DESCRIPTION_MAX_LENGTH);
    expect(text).toMatch(/\n\(Shortened: not every item is listed\.\)$/);
    expect(text).toMatch(/Shapes: rectangle “Service number 0”, .*, … and \d+ more\n/);
    expect(text).toContain("Freehand: 50 freehand strokes: 43 bottom left, 7 bottom\n");
    expect(
      describeDrawing(builder.build(), { title: "Big", maxLength: 300 }).length,
    ).toBeLessThanOrEqual(300);
  });

  it("gives the same text for the same scene, whatever the key order", () => {
    const scene = new SceneBuilder()
      .rect("a", 0, 0)
      .label("a", "at", "A")
      .arrow("x", [160, 40], [300, 40], { start: "a" })
      .build();
    const reordered = {
      ...scene,
      elements: scene.elements.map((e) => Object.fromEntries(Object.entries(e).reverse())),
    } as typeof scene;
    expect(describeDrawing(reordered, { title: "T" })).toBe(describeDrawing(scene, { title: "T" }));
  });

  it("tolerates elements with missing or odd fields", () => {
    const scene = {
      ...emptyDrawingScene(),
      elements: [
        { id: "a", type: "rectangle" },
        { id: "b", type: "arrow", points: "nope", startBinding: { elementId: 3 } },
        { id: "c", type: "freedraw", points: [[1, "x"], null, [Number.NaN, 2]] },
        { id: "d", type: "text", containerId: "d", text: 42 },
        { id: "e", type: "frame", name: 7, x: "1" },
      ],
    } as unknown as DrawingScene;
    expect(describeDrawing(scene, { title: "Odd" })).toBe(
      [
        "Drawing “Odd” (1×2 px, 5 elements)",
        "Shapes: 1 unlabeled rectangle",
        "Arrows: arrow",
        "Freehand: 1 freehand stroke, center",
        "Frames: frame (empty)",
      ].join("\n"),
    );
  });
});
