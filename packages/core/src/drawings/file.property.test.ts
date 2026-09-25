import { fc, test } from "@fast-check/vitest";
import { describe, expect } from "vitest";
import { parseDrawingFile, serializeDrawingFile } from "./file";
import { DRAWING_PLUGIN_SOURCE_PREFIX, DRAWING_SCENE_SOURCE, type DrawingScene } from "./types";

/**
 * Text that survives `## Text Elements` unchanged. Excluded, as they are for the plugin: a line
 * ending in something like a block reference (` ^abcdefgh`), a line that is a section heading the
 * text list ends at, leading line breaks (the separator eats them) and carriage returns.
 */
const safeText = fc
  .array(
    fc.oneof(
      fc.constantFrom(
        "a",
        "Z",
        " ",
        "\t",
        "\n",
        "#",
        "^",
        "%",
        "`",
        "-",
        "[",
        "]",
        "|",
        "é",
        "日",
        "🎉",
      ),
      fc.string({ unit: "grapheme", minLength: 1, maxLength: 1 }),
    ),
    { maxLength: 24 },
  )
  .map((chars) => chars.join(""))
  .filter(
    (text) =>
      !text.includes("\r") &&
      !text.startsWith("\n") &&
      text
        .split("\n")
        .every(
          (line) =>
            !/(^|\s)\^\S+[ \t]*$/.test(line) &&
            !/^##? (?:Element Links|Embedded [Ff]iles)[ \t]*$/.test(line),
        ),
  );

const number = fc
  .double({ noNaN: true, noDefaultInfinity: true, min: -1e5, max: 1e5 })
  .map((value) => value + 0);
const unknownFields = fc.dictionary(
  fc.string({ maxLength: 8 }).map((key) => `x_${key}`),
  fc.jsonValue({ maxDepth: 2 }),
  { maxKeys: 3 },
);
const withUnknown = <T extends object>(arb: fc.Arbitrary<T>) =>
  fc.tuple(arb, unknownFields).map(([value, extra]) => ({ ...value, ...extra }));

const element = withUnknown(
  fc.record(
    {
      id: fc.stringMatching(/^[A-Za-z0-9_-]{1,21}$/),
      type: fc.constantFrom(
        "rectangle",
        "ellipse",
        "diamond",
        "text",
        "arrow",
        "line",
        "freedraw",
        "image",
        "frame",
        "embeddable",
      ),
      x: number,
      y: number,
      width: number,
      height: number,
      isDeleted: fc.boolean(),
      containerId: fc.option(fc.stringMatching(/^[a-z]{1,4}$/), { nil: null }),
      text: safeText,
      originalText: safeText,
      rawText: safeText,
      points: fc.array(fc.tuple(number, number), { maxLength: 4 }),
    },
    { requiredKeys: ["id", "type"] },
  ),
);

const scene: fc.Arbitrary<DrawingScene> = fc
  .record({
    elements: fc.uniqueArray(element, { selector: (e) => e.id, maxLength: 10 }),
    appState: withUnknown(
      fc.record(
        { viewBackgroundColor: fc.constantFrom("#ffffff", "#1e1e1e"), gridSize: fc.constant(null) },
        { requiredKeys: [] },
      ),
    ),
    files: fc.dictionary(
      fc.stringMatching(/^[0-9a-f]{4,12}$/),
      withUnknown(
        fc.record({
          id: fc.string({ maxLength: 6 }),
          mimeType: fc.constant("image/png"),
          dataURL: fc.constant("data:image/png;base64,AA=="),
        }),
      ),
      { maxKeys: 2 },
    ),
    source: fc.option(
      fc.constantFrom("https://excalidraw.com", `${DRAWING_PLUGIN_SOURCE_PREFIX}2.1.0`),
      { nil: undefined },
    ),
    extra: unknownFields,
  })
  .map(({ extra, source, ...rest }) => ({
    type: "excalidraw",
    version: 2,
    ...(source === undefined ? {} : { source }),
    ...rest,
    ...extra,
  }));

/** Drops every `x_` field, like an editor that doesn't know them. */
function stripUnknown(value: DrawingScene): DrawingScene {
  const strip = <T extends Record<string, unknown>>(object: T): T =>
    Object.fromEntries(Object.entries(object).filter(([key]) => !key.startsWith("x_"))) as T;
  return {
    ...strip(value),
    elements: value.elements.map(strip),
    appState: strip(value.appState),
    files: Object.fromEntries(Object.entries(value.files).map(([id, file]) => [id, strip(file)])),
  };
}

function expectedScene(value: DrawingScene): unknown {
  const source =
    typeof value.source === "string" && value.source.startsWith(DRAWING_PLUGIN_SOURCE_PREFIX)
      ? value.source
      : DRAWING_SCENE_SOURCE;
  return JSON.parse(JSON.stringify({ ...value, source }));
}

describe("drawing files (properties)", () => {
  test.prop([scene])("parsing what we write gives back the scene", (value) => {
    const parsed = parseDrawingFile(serializeDrawingFile(value));
    expect(parsed.problems).toEqual([]);
    expect(parsed.readable).toBe(true);
    expect(parsed.scene).toEqual(expectedScene(value));
  });

  test.prop([scene])("serialize, parse and serialize again is a fixed point", (value) => {
    const first = serializeDrawingFile(value);
    const parsed = parseDrawingFile(first);
    expect(serializeDrawingFile(parsed.scene, first)).toBe(first);
    expect(serializeDrawingFile(parsed.scene, parsed)).toBe(first);
    expect(serializeDrawingFile(parsed.scene)).toBe(first);
  });

  test.prop([scene])("fields an editor drops survive when the previous file is given", (value) => {
    const first = serializeDrawingFile(value);
    expect(serializeDrawingFile(stripUnknown(value), first)).toBe(first);
  });

  test.prop([scene])("compressed and uncompressed files parse to the same scene", (value) => {
    const packed = parseDrawingFile(serializeDrawingFile(value, undefined, { compressed: true }));
    const plain = parseDrawingFile(serializeDrawingFile(value));
    expect(packed.compressed).toBe(true);
    expect(packed.problems).toEqual([]);
    expect(packed.scene).toEqual(plain.scene);
  });

  test.prop([scene, fc.nat(), fc.nat(), fc.string({ maxLength: 20 })])(
    "never throws on a damaged file",
    (value, at, length, insert) => {
      const text = serializeDrawingFile(value, undefined, { compressed: at % 2 === 0 });
      const start = at % (text.length + 1);
      const damaged = text.slice(0, start) + insert + text.slice(start + (length % 200));
      const parsed = parseDrawingFile(damaged);
      expect(parsed.readable).toBe(!parsed.problems.some((p) => p.severity === "error"));
      if (parsed.readable) expect(() => serializeDrawingFile(parsed.scene, parsed)).not.toThrow();
    },
  );
});
