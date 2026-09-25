/**
 * The fixture contract shared with the Swift drawing engine (see README.md): what a fixture's
 * `.expected.json` holds, and how it is derived from the fixture with `@ddl/core`.
 */
import {
  describeDrawing,
  type ParsedDrawingFile,
  parseDrawingFile,
  serializeDrawingFile,
} from "../../src/index";

export const INPUT_SUFFIX = ".excalidraw.md";
export const ROUND_TRIP_SUFFIX = ".roundtrip.excalidraw.md";
export const EXPECTED_SUFFIX = ".expected.json";

/** Written by hand (or kept from the existing file) rather than derived. */
export interface FixtureMeta {
  about: string;
  /** Passed to `describeDrawing`. */
  title: string;
  /** Another fixture whose parsed scene this one's must equal. */
  sameSceneAs?: string;
}

export interface ParseSummary {
  readable: boolean;
  compressed: boolean;
  problems: Array<{ code: string; severity: string }>;
  frontmatter: Record<string, string>;
  sections: string[];
  textElements: Array<{ id: string; text: string }>;
  elements: Array<{ id: string; type: string; isDeleted?: true }>;
  /** Live text elements' `text` after parsing (an edited Text Elements entry wins). */
  texts: Array<{ id: string; text: string }>;
  files: string[];
}

export interface FixtureExpectation extends FixtureMeta {
  parse: ParseSummary;
  description: string;
  /** The file holding `serializeDrawingFile(scene, previous)`; this fixture when unchanged; null when unreadable. */
  roundTrip: string | null;
}

export function isInput(file: string): boolean {
  return file.endsWith(INPUT_SUFFIX) && !file.endsWith(ROUND_TRIP_SUFFIX);
}

export function fixtureName(file: string): string {
  return file.slice(0, -INPUT_SUFFIX.length);
}

export function summarize(parsed: ParsedDrawingFile): ParseSummary {
  return {
    readable: parsed.readable,
    compressed: parsed.compressed,
    problems: parsed.problems.map(({ code, severity }) => ({ code, severity })),
    frontmatter: { ...parsed.frontmatter.entries },
    sections: parsed.sections.map((section) => section.heading),
    textElements: parsed.textElements,
    elements: parsed.scene.elements.map((element) => ({
      id: element.id,
      type: element.type,
      ...(element.isDeleted === true ? { isDeleted: true as const } : {}),
    })),
    texts: parsed.scene.elements
      .filter((element) => element.type === "text" && element.isDeleted !== true)
      .map((element) => ({
        id: element.id,
        text: typeof element.text === "string" ? element.text : "",
      })),
    files: Object.keys(parsed.scene.files),
  };
}

export function derive(
  name: string,
  text: string,
  meta: FixtureMeta,
): { expectation: FixtureExpectation; roundTripText: string | null } {
  const parsed = parseDrawingFile(text);
  const roundTripText = parsed.readable ? serializeDrawingFile(parsed.scene, parsed) : null;
  const roundTrip =
    roundTripText === null
      ? null
      : roundTripText === text
        ? `${name}${INPUT_SUFFIX}`
        : `${name}${ROUND_TRIP_SUFFIX}`;
  return {
    expectation: {
      about: meta.about,
      title: meta.title,
      ...(meta.sameSceneAs === undefined ? {} : { sameSceneAs: meta.sameSceneAs }),
      parse: summarize(parsed),
      description: describeDrawing(parsed.scene, { title: meta.title }),
      roundTrip,
    },
    roundTripText,
  };
}
