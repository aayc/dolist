import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseDrawingFile, serializeDrawingFile } from "../../src/index";
import {
  derive,
  EXPECTED_SUFFIX,
  type FixtureExpectation,
  fixtureName,
  isInput,
  ROUND_TRIP_SUFFIX,
} from "./contract";

const DIR = join(dirname(fileURLToPath(import.meta.url)), "fixtures");
const files = readdirSync(DIR).sort();
const inputs = files.filter(isInput);
const read = (file: string) => readFileSync(join(DIR, file), "utf8");

describe("drawing fixtures", () => {
  it("pairs every fixture with its expectation, and every round-trip file with its fixture", () => {
    expect(inputs.length).toBeGreaterThan(0);
    const expected = files
      .filter((file) => file.endsWith(EXPECTED_SUFFIX))
      .map((file) => file.slice(0, -EXPECTED_SUFFIX.length));
    expect(expected).toEqual(inputs.map(fixtureName));
    for (const file of files.filter((f) => f.endsWith(ROUND_TRIP_SUFFIX))) {
      const name = file.slice(0, -ROUND_TRIP_SUFFIX.length);
      const expectation = JSON.parse(read(`${name}${EXPECTED_SUFFIX}`)) as FixtureExpectation;
      expect(expectation.roundTrip).toBe(file);
    }
  });

  describe.each(inputs)("%s", (file) => {
    const name = fixtureName(file);
    const text = read(file);
    const expected = JSON.parse(read(`${name}${EXPECTED_SUFFIX}`)) as FixtureExpectation;
    const { expectation, roundTripText } = derive(name, text, expected);

    it("parses to the expected summary", () => {
      expect(expectation.parse).toEqual(expected.parse);
    });

    it("has the expected description", () => {
      expect(expectation.description).toBe(expected.description);
    });

    it("writes back to the expected file", () => {
      expect(expectation.roundTrip).toBe(expected.roundTrip);
      if (expected.roundTrip !== null) expect(roundTripText).toBe(read(expected.roundTrip));
    });

    it("writes its round trip back unchanged", () => {
      if (roundTripText === null) {
        expect(() => serializeDrawingFile(parseDrawingFile(text).scene, text)).toThrow();
        return;
      }
      const again = parseDrawingFile(roundTripText);
      expect(serializeDrawingFile(again.scene, again)).toBe(roundTripText);
      expect(again.scene).toEqual(parseDrawingFile(text).scene);
    });

    if (expected.sameSceneAs !== undefined) {
      it(`parses to the same scene as ${expected.sameSceneAs}`, () => {
        expect(parseDrawingFile(text).scene).toEqual(
          parseDrawingFile(read(expected.sameSceneAs!)).scene,
        );
      });
    }
  });
});
