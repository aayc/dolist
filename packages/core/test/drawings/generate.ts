/**
 * Writes the drawing fixtures' expectations (`<name>.expected.json`, and
 * `<name>.roundtrip.excalidraw.md` when writing the file back changes it) from `@ddl/core`.
 * Fixture inputs are written only when missing (or with `--inputs`): once committed they are the
 * contract, and the Swift engine replays the same files.
 *
 *   pnpm --filter @ddl/core drawings:fixtures [--inputs]
 */
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { compressToBase64 } from "../../src/drawings/lz-string";
import {
  DRAWING_NOTICE,
  type DrawingScene,
  emptyDrawingScene,
  serializeDrawingFile,
} from "../../src/index";
import { SceneBuilder } from "../../src/testing/drawing-scenes";
import {
  derive,
  EXPECTED_SUFFIX,
  type FixtureExpectation,
  type FixtureMeta,
  fixtureName,
  INPUT_SUFFIX,
  isInput,
  ROUND_TRIP_SUFFIX,
} from "./contract";

const DIR = join(dirname(fileURLToPath(import.meta.url)), "fixtures");
const PLUGIN_FRONTMATTER = "---\n\nexcalidraw-plugin: parsed\ntags: [excalidraw]\n\n---\n";
const PLUGIN_SOURCE = "https://github.com/zsviczian/obsidian-excalidraw-plugin/releases/tag/";

/** The plugin's `compress`: LZ-String base64 in 256-character lines separated by blank lines. */
function pluginCompress(json: string): string {
  const packed = compressToBase64(json);
  let out = "";
  for (let i = 0; i < packed.length; i += 256) out += `${packed.slice(i, i + 256)}\n\n`;
  return out.trim();
}

/** The plugin's `getMarkdownDrawingSection`. */
function pluginDrawingSection(scene: unknown, compressed: boolean): string {
  const json = typeof scene === "string" ? scene : JSON.stringify(scene, null, "\t");
  return compressed
    ? `## Drawing\n\`\`\`compressed-json\n${pluginCompress(json)}\n\`\`\`\n%%`
    : `## Drawing\n\`\`\`json\n${json}\n\`\`\`\n%%`;
}

function flowchart(): DrawingScene {
  return new SceneBuilder()
    .rect("client", 0, 0, 180, 80)
    .label("client", "tBrowser", "Browser")
    .rect("api", 320, 0, 180, 80)
    .label("api", "tApiNode", "API")
    .shape("ellipse", "db", 320, 200, 180, 90)
    .label("db", "tDbStore", "Database")
    .arrow("toApi", [180, 40], [320, 40], { start: "client", end: "api" })
    .label("toApi", "tHttpsLb", "HTTPS")
    .arrow("toDb", [410, 80], [410, 200], { start: "api", end: "db" })
    .text("tCaption", 0, 320, "Request path")
    .frame("backend", 300, -20, 220, 330, "Backend", ["api", "tApiNode", "db", "tDbStore", "toDb"])
    .build();
}

function freehand(): DrawingScene {
  return new SceneBuilder()
    .scribble("s1", 0, 0, 80)
    .scribble("s2", 100, 20, 60)
    .scribble("s3", 700, 500, 90)
    .line("ground", [
      [0, 400],
      [300, 420],
      [800, 400],
    ])
    .image("photo", 600, 0, 200, 150, "4f1c0e9a7b2d")
    .rect("old", 300, 200)
    .delete("old")
    .text("oldNote", 300, 300, "Scratch")
    .delete("oldNote")
    .build();
}

function arrows(): DrawingScene {
  return new SceneBuilder()
    .rect("a", 0, 0)
    .label("a", "aText", "Start")
    .shape("diamond", "b", 400, 0, 120, 120)
    .label("b", "bText", "Decide?")
    .rect("c", 400, 300)
    .label("c", "cText", "Done")
    .text("side", 800, 40, "Side note")
    .arrow("ab", [160, 40], [400, 60], { start: "a", end: "b" })
    .arrow("bc", [460, 120], [470, 300], { start: "b", end: "c", endArrowhead: "triangle" })
    .label("bc", "bcText", "yes")
    .arrow("back", [400, 330], [80, 80], {
      start: "c",
      end: "a",
      startArrowhead: "arrow",
      endArrowhead: null,
    })
    .arrow("both", [520, 60], [800, 50], { start: "b", end: "side", startArrowhead: "dot" })
    .arrow("plain", [160, 60], [400, 90], { start: "a", end: "b", endArrowhead: null })
    .arrow("loose", [170, 100], [395, 320])
    .arrow("halfway", [565, 350], [700, 600])
    .arrow("stray", [0, 700], [200, 700])
    .linear(
      "arrow",
      "elbow",
      [
        [560, 330],
        [700, 330],
        [700, 60],
        [800, 60],
      ],
      {
        start: "c",
        end: "side",
        extra: {
          elbowed: true,
          startBinding: { elementId: "c", focus: 0, gap: 5, fixedPoint: [1.0001, 0.5] },
          endBinding: { elementId: "side", focus: 0, gap: 5, fixedPoint: [-0.0001, 0.5] },
          fixedSegments: null,
          startIsSpecial: null,
          endIsSpecial: null,
        },
      },
    )
    .line("divider", [
      [0, 500],
      [300, 500],
    ])
    .build();
}

function containers(): DrawingScene {
  return new SceneBuilder()
    .rect("r", 0, 0, 200, 100)
    .label("r", "tBedPlan", "Plan the beds")
    .shape("ellipse", "e", 260, 0, 160, 100)
    .label("e", "tSeedsOr", "Order seeds before March", { text: "Order seeds\nbefore March" })
    .shape("diamond", "d", 480, 0, 140, 140)
    .label("d", "tFrostyQ", "Frost?")
    .text("tGardenN", 0, 200, "# Garden\nBeds: 4\nWater ^ daily")
    .text("tUnicode", 0, 320, "Überblick 🌱 日本")
    .arrow("ar", [200, 50], [260, 50], { start: "r", end: "e" })
    .label("ar", "tThenLbl", "then")
    .build();
}

/** A scene as the plugin saves it: 8-character ids for text and linked elements, `rawText`, its appState. */
function pluginScene(): DrawingScene {
  const scene = new SceneBuilder()
    .rect("Rb5mWq2X", 0, 0, 200, 90, {
      link: "[[Garden plan]]",
      futureField: { kind: "shadow", blur: 4 },
    })
    .label("Rb5mWq2X", "Kp3xY7aQ", "Beds", { rawText: "Beds" })
    .text("Tn4wE2rL", 0, 150, "Garden plan", { rawText: "[[Garden plan]]", hasTextLink: true })
    .image("Q8dLr2pWs0Xz4yBn6mVtC", 300, 0, 160, 120, "3f2a9c41d07e5b86a1c4f0e2d9b7a6c35e8f1d20")
    .other("embeddable", "Hc7Nq1ZsYk3Uw9Pf5RaLd", 500, 0, { link: "https://example.com/garden" })
    .arrow("Zp2Kd8Wq1Nf6Lm3Rt9YbE", [100, 90], [100, 150], { start: "Rb5mWq2X", end: "Tn4wE2rL" })
    .build({ source: `${PLUGIN_SOURCE}2.20.1` });
  return {
    ...scene,
    appState: {
      theme: "light",
      viewBackgroundColor: "#ffffff",
      currentItemStrokeColor: "#1e1e1e",
      currentItemBackgroundColor: "transparent",
      currentItemFillStyle: "solid",
      currentItemStrokeWidth: 2,
      currentItemStrokeStyle: "solid",
      currentItemRoughness: 1,
      currentItemOpacity: 100,
      currentItemFontFamily: 5,
      currentItemFontSize: 20,
      currentItemTextAlign: "left",
      currentItemStartArrowhead: null,
      currentItemEndArrowhead: "arrow",
      currentItemArrowType: "round",
      scrollX: 412.5,
      scrollY: 230,
      zoom: { value: 1 },
      currentItemRoundness: "round",
      gridSize: 20,
      gridStep: 5,
      gridModeEnabled: false,
      gridColor: { Bold: "rgba(217, 217, 217, 0.5)", Regular: "rgba(230, 230, 230, 0.5)" },
      currentStrokeOptions: null,
      frameRendering: { enabled: true, clip: true, name: true, outline: true },
      objectsSnapModeEnabled: false,
      activeTool: {
        type: "selection",
        customType: null,
        locked: false,
        fromSelection: false,
        lastActiveTool: null,
      },
    },
    // The plugin keeps vault images out of `files` and lists them under `## Embedded Files`.
    files: {},
  };
}

function pluginFile(compressed: boolean): string {
  return [
    "---\n",
    "excalidraw-export-dark: false\n",
    "\nexcalidraw-plugin: parsed\n",
    "tags: [excalidraw]\n",
    "cssclasses: wide\n",
    "\n---\n",
    `${DRAWING_NOTICE}\n\n`,
    "Notes about the garden layout live here, above the drawing data.\n\n",
    "# Excalidraw Data\n\n## Text Elements\n",
    "Beds ^Kp3xY7aQ\n\n",
    "[[Garden plan]] ^Tn4wE2rL\n\n",
    "## Element Links\n",
    "Rb5mWq2X: [[Garden plan]]\n\n",
    "## Embedded Files\n",
    "3f2a9c41d07e5b86a1c4f0e2d9b7a6c35e8f1d20: [[seedling.png]]\n\n",
    "%%\n",
    pluginDrawingSection(pluginScene(), compressed),
  ].join("");
}

function pluginCommented(): string {
  const scene = new SceneBuilder()
    .rect("Bx4nT8qW", 0, 0, 260, 160)
    .text("Wt7bQ2nK", 20, 20, "Water the beds\nevery morning", {
      rawText: "Water the beds\nevery morning",
    })
    .text("Cp9xL4sM", 20, 100, "Compost", { rawText: "Compost" })
    .build({ source: `${PLUGIN_SOURCE}2.24.0` });
  return [
    PLUGIN_FRONTMATTER.replace("parsed", "raw"),
    `${DRAWING_NOTICE}\n\n`,
    "%%\n# Excalidraw Data\n\n## Text Elements\n",
    "\n^_dummy!_\n\n",
    "Water the beds\nevery morning ^Wt7bQ2nK\n\n",
    "Compost ^Cp9xL4sM\n\n",
    pluginDrawingSection(scene, false),
  ].join("");
}

function pluginBlank(): string {
  const blank = `{"type":"excalidraw","version":2,"source":"${PLUGIN_SOURCE}2.27.3","elements":[],"appState":{"gridSize":null,"viewBackgroundColor":"#ffffff"}}`;
  return `${PLUGIN_FRONTMATTER}${DRAWING_NOTICE}\n\n\n${pluginDrawingSection(blank, true)}`;
}

function malformed(): string {
  const text = serializeDrawingFile(flowchart());
  const start = text.indexOf("```json\n") + "```json\n".length;
  return `${text.slice(0, start + 120)}\n\`\`\`\n%%\n`;
}

function textSectionEdited(): string {
  const scene = new SceneBuilder()
    .rect("shed", 0, 0, 160, 80)
    .label("shed", "shedText", "Shed")
    .text("todo", 0, 120, "Buy seeds")
    .build();
  return serializeDrawingFile(scene).replace("Buy seeds ^todo", "Buy seeds and soil ^todo");
}

const FIXTURES: Record<string, { about: string; make: () => string; sameSceneAs?: string }> = {
  "ours-flowchart": {
    about:
      "Written by serializeDrawingFile: labeled shapes, bound arrows (one labeled), free text, a frame.",
    make: () => serializeDrawingFile(flowchart()),
  },
  "ours-empty": {
    about: "An empty drawing as serializeDrawingFile writes a new one.",
    make: () => serializeDrawingFile(emptyDrawingScene()),
  },
  "ours-freehand": {
    about:
      "Freehand strokes in two corners, a line, an image with its file, and deleted elements (ignored).",
    make: () => serializeDrawingFile(freehand()),
  },
  "ours-arrows": {
    about:
      "Arrows bound at both ends, reversed, double-headed and headless; unbound arrows near shapes or nothing; an elbow arrow; a line.",
    make: () => serializeDrawingFile(arrows()),
  },
  "ours-containers": {
    about:
      "Text in a rectangle, an ellipse (wrapped: text differs from originalText) and a diamond; an arrow label; `#` and `^` in text; non-ASCII text.",
    make: () => serializeDrawingFile(containers()),
  },
  "plugin-json": {
    about:
      "As the Obsidian plugin saves with compression off: extra frontmatter keys, text above the data, 8-character ids, rawText, Element Links, Embedded Files, the plugin's appState, an unknown element type and field, no final newline.",
    make: () => pluginFile(false),
  },
  "plugin-compressed": {
    about:
      "plugin-json saved with compression on (the plugin's default): compressed-json in 256-character lines.",
    make: () => pluginFile(true),
    sameSceneAs: `plugin-json${INPUT_SUFFIX}`,
  },
  "plugin-blank": {
    about:
      "A new drawing as the plugin creates it: no data sections, compressed, no files key, no final newline.",
    make: pluginBlank,
  },
  "plugin-commented": {
    about:
      "Text elements commented out with %% (and no %% before Drawing), raw text mode, the plugin's dummy entry, a multi-line text.",
    make: pluginCommented,
  },
  malformed: {
    about: "The scene's JSON is cut off: unreadable, described as empty, never written back.",
    make: malformed,
  },
  "text-section-edited": {
    about:
      "A Text Elements entry edited by hand (in Obsidian's markdown view): the entry wins over the scene, as in the plugin.",
    make: textSectionEdited,
  },
};

const writeInputs = process.argv.includes("--inputs");
for (const [name, fixture] of Object.entries(FIXTURES)) {
  const path = join(DIR, `${name}${INPUT_SUFFIX}`);
  if (writeInputs || !existsSync(path)) writeFileSync(path, fixture.make());
}

const written: string[] = [];
for (const file of readdirSync(DIR).filter(isInput).sort()) {
  const name = fixtureName(file);
  const expectedPath = join(DIR, `${name}${EXPECTED_SUFFIX}`);
  const existing = existsSync(expectedPath)
    ? (JSON.parse(readFileSync(expectedPath, "utf8")) as FixtureExpectation)
    : undefined;
  const meta: FixtureMeta = {
    about: existing?.about ?? FIXTURES[name]?.about ?? "",
    title: existing?.title ?? name,
    ...((existing?.sameSceneAs ?? FIXTURES[name]?.sameSceneAs)
      ? { sameSceneAs: existing?.sameSceneAs ?? FIXTURES[name]?.sameSceneAs }
      : {}),
  };
  const { expectation, roundTripText } = derive(name, readFileSync(join(DIR, file), "utf8"), meta);
  writeFileSync(expectedPath, `${JSON.stringify(expectation, null, 2)}\n`);
  written.push(expectedPath);
  const roundTripPath = join(DIR, `${name}${ROUND_TRIP_SUFFIX}`);
  if (expectation.roundTrip === `${name}${ROUND_TRIP_SUFFIX}` && roundTripText !== null) {
    writeFileSync(roundTripPath, roundTripText);
  } else {
    rmSync(roundTripPath, { force: true });
  }
}
execFileSync("pnpm", ["exec", "biome", "format", "--write", ...written], { stdio: "inherit" });
console.log(`Wrote the expectations of ${written.length} drawing fixtures.`);
