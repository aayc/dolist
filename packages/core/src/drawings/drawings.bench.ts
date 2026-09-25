import { expect, test } from "vitest";
import { SceneBuilder } from "../testing/drawing-scenes";
import { describeDrawing } from "./describe";
import { parseDrawingFile, serializeDrawingFile } from "./file";

/**
 * Drawings are read when a note shows one and written on a debounced save, never per keystroke.
 * A 2 000-element drawing is a large one (a busy whiteboard). Budgets are p99 latency in ms; see
 * tasks.bench.ts for how they are checked.
 */
const env = (globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env;
const MULTIPLIER = Number(env?.BENCH_BUDGET_MULTIPLIER ?? 1) || 1;
const BUDGET_MS = {
  parse: 25 * MULTIPLIER,
  parseCompressed: 80 * MULTIPLIER,
  serialize: 40 * MULTIPLIER,
  describe: 15 * MULTIPLIER,
};

/** 2 000 elements: labeled boxes in a grid, arrows between them, strokes, notes and lines. */
function largeScene() {
  const builder = new SceneBuilder();
  for (let i = 0; i < 500; i++) {
    builder.rect(`r${i}`, (i % 25) * 240, Math.floor(i / 25) * 160, 160, 80);
    builder.label(`r${i}`, `t${i}`, `Service ${i}`);
  }
  for (let i = 0; i < 400; i++) {
    const x = (i % 25) * 240 + 160;
    const y = Math.floor(i / 25) * 160 + 40;
    builder.arrow(`a${i}`, [x, y], [x + 80, y], { start: `r${i}`, end: `r${i + 1}` });
  }
  for (let i = 0; i < 300; i++)
    builder.scribble(`s${i}`, (i % 30) * 200, 3400 + (i % 7) * 50, 60, 30);
  for (let i = 0; i < 200; i++)
    builder.text(`n${i}`, (i % 20) * 300, 3800 + Math.floor(i / 20) * 40, `Note ${i}`);
  for (let i = 0; i < 100; i++) {
    builder.line(`l${i}`, [
      [i * 60, 4300],
      [i * 60 + 40, 4340],
    ]);
  }
  return builder.build();
}

const SCENE = largeScene();
const JSON_FILE = serializeDrawingFile(SCENE);
const COMPRESSED_FILE = serializeDrawingFile(SCENE, undefined, { compressed: true });
const PARSED = parseDrawingFile(JSON_FILE);
const EDITED = structuredClone(PARSED.scene);
EDITED.elements[0]!.x = 12;

test("the large drawing has 2 000 elements", () => {
  expect(SCENE.elements).toHaveLength(2000);
  expect(PARSED.problems).toEqual([]);
});

test("parseDrawingFile: 2k elements, json", async ({ bench }) => {
  const result = await bench("parseDrawingFile: 2k elements, json", () => {
    parseDrawingFile(JSON_FILE);
  }).run();
  expect(result.latency.p99).toBeLessThan(BUDGET_MS.parse);
});

test("parseDrawingFile: 2k elements, compressed-json", async ({ bench }) => {
  const result = await bench("parseDrawingFile: 2k elements, compressed-json", () => {
    parseDrawingFile(COMPRESSED_FILE);
  }).run();
  expect(result.latency.p99).toBeLessThan(BUDGET_MS.parseCompressed);
});

test("serializeDrawingFile: 2k elements, with the previous file", async ({ bench }) => {
  const result = await bench("serializeDrawingFile: 2k elements, with the previous file", () => {
    serializeDrawingFile(EDITED, PARSED);
  }).run();
  expect(result.latency.p99).toBeLessThan(BUDGET_MS.serialize);
});

test("describeDrawing: 2k elements", async ({ bench }) => {
  const result = await bench("describeDrawing: 2k elements", () => {
    describeDrawing(PARSED.scene, { title: "Whiteboard" });
  }).run();
  expect(result.latency.p99).toBeLessThan(BUDGET_MS.describe);
});
