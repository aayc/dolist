# DailyDoListDrawing

The Mac app's native drawing engine: Excalidraw scenes stored in the Obsidian Excalidraw
plugin's `.excalidraw.md` files, drawn with a port of Rough.js so they look the way Excalidraw
draws them, and edited in place in an AppKit canvas. Written from scratch for speed, with
Excalidraw's core tools and shortcuts. The web app embeds the real Excalidraw editor; both edit the
same files ([spec](../../../../docs/specs/drawings.md)).

## Targets

| Target | What | Platforms |
| --- | --- | --- |
| `DailyDoListDrawingModel` | The scene model, its JSON codec, the file format, LZ-String, embeds and file names. Foundation only. | macOS, iOS |
| `DailyDoListDrawing` | The Rough.js port, the CoreGraphics renderer, the editing state and tools (platform-neutral, in `Editor/`), and the AppKit canvas view with its tool bar (`View/`). Bundles Excalifont. | macOS |

## Architecture

```
.excalidraw.md ──ExcalidrawMarkdown.parse──▶ ExcalidrawScene ──SceneRenderer──▶ CGContext
       ▲                                        │    ▲
       └────── ExcalidrawMarkdown.serialize ◀───┘    │ every change (version++)
                                                     │
               DrawingCanvasView ──NSEvents──▶ DrawingEditor (tools, selection, binding, undo)
                 ├ StaticLayerCache: unchanged elements, cached as one bitmap
                 ├ live pass: elements being drawn, dragged, resized or typed into
                 ├ overlays: selection, handles, hover, marquee, binding highlight
                 ├ DrawingTextEditor: inline text in the element's font
                 └ DrawingToolbar (SwiftUI) + DrawingPropertiesPanel (popover)
```

- **Model** (`Model/`): `ExcalidrawElement` types every field of Excalidraw 0.18's schema that the
  engine draws or edits (common fields, text, lines and arrows, freehand strokes, frames) and
  keeps the rest in `preserved`: unknown fields and types, the order keys came in, and the raw
  value of any field it couldn't read or that was absent. `ElementCodec` writes an element back
  with its keys where they were and values it didn't change as they were, so an untouched scene
  is written back byte for byte. `JSONParser` keeps key order; `JSONWriter` is
  `JSON.stringify(value, null, "\t")`, numbers included (`JSNumberFormat`).
- **File format** (`File/`): `ExcalidrawMarkdown` follows `@ddl/core`'s `file.ts`, the reference
  implementation, exactly (see [Testing](#testing)). It reads `json` and
  `compressed-json` (LZ-String base64, `LZString`, a port of lz-string 1.5.0) and writes `json`;
  `## Text Elements` is the truth when reading (the plugin's rule) and is regenerated when
  writing; everything else is kept from the previous file. Parsing never throws: problems are
  reported and an unreadable file refuses to be written over (`DrawingUnreadableError`).
  `DrawingEmbed` reads and writes `![[Name.excalidraw|360|right-wrap]]` like `embed.ts`;
  `DrawingFileName` names new drawings like the plugin (`Excalidraw/Drawing 2026-09-25
  11.52.33.excalidraw.md`).
- **Rough.js** (`Rough/`): a port of Rough.js 4.6.4 (the version Excalidraw 0.18 uses) with
  hachure-fill, points-on-curve and points-on-path: lines, linear paths, polygons, rectangles,
  ellipses, curves and SVG paths; hachure, cross-hatch, zigzag, dashed, zigzag-line, dots and
  solid fills. It keeps Rough.js's seeded generator (`Math.imul(48271, seed)`), its options object
  semantics (the random generator is shared by copies, like `Object.assign`), JavaScript's
  rounding, stable sorts and the order of every random draw, so the same `seed`, `roughness` and
  options give the same strokes.
- **Renderer** (`Render/`): `ExcalidrawShapes` ports Excalidraw's `Shape.ts` (rough options with
  adjusted sloppiness, dashes and widths per stroke style, rounded rectangles and diamonds as
  paths, closed lines filled, arrowheads), `FreedrawOutline` ports perfect-freehand 1.2.0 with
  Excalidraw's options, `TextLayout` sets text with Excalidraw's font metrics and alignment, and
  `SceneRenderer` draws like Excalidraw's static scene: z-order, labels after their containers and
  cleared out of arrows, children clipped to their frames, opacity, rotation around the center.
  Dark mode applies Excalidraw's `invert(93%) hue-rotate(180deg)` to each color.
- **Editor** (`Editor/`): `DrawingEditor` is the editing state behind the canvas, platform-neutral:
  it takes pointer events in scene coordinates and keys, and reports changes. Arrow binding ports
  Excalidraw's `binding.ts` (focus and gap, `updateBoundPoint`).
- **View** (`View/`): `DrawingCanvasView` (AppKit) hosts it all.

## What's supported

- **Tools**: selection, rectangle, diamond, ellipse, arrow, line, freehand, text, eraser, hand.
  Shapes by dragging (shift makes squares and circles, option draws from the center); lines and
  arrows by dragging or click by click (Enter, Escape, a double click or the last point again
  finishes; clicking the first point closes a line; shift snaps to 15°); freehand strokes with
  perfect-freehand's pressure-less smoothing; text by clicking (edited inline; Escape or ⌘Return
  ends); a label for a shape or an arrow by double-clicking it (or Enter); the eraser removes what
  it touches on release.
- **Selection**: click, shift-click, marquee (shift adds), groups select together; move (option
  duplicates; shift keeps an axis), resize with 8 handles (shift keeps proportions, option from
  the center, rotated elements resize in their own frame, text scales from corners and rewraps
  from the sides, several elements scale together), drag a line's or arrow's points, arrow keys
  nudge 1 (shift 5), delete, duplicate (⌘D, 10 down and right).
- **Arrows bind** to rectangles, diamonds, ellipses, text, images and frames when an end is drawn
  on or near them (the shape is highlighted), and follow when the shape moves or resizes; moving
  an arrow away alone detaches it. An end released on or near the outline sits 5 outside it
  (`FIXED_BINDING_DISTANCE`, as `bindPointToSnapToElementOutline` places it), leaving
  Excalidraw's small gap before the tip.
- **Properties** (the popover; also applied to the selection): stroke and background colors from
  Excalidraw's palette (quick picks and a row of shades), fill (hachure, cross-hatch, solid),
  stroke width (thin, bold, extra bold), stroke style (solid, dashed, dotted), sloppiness
  (architect, artist, cartoonist), edges (sharp, round), arrowheads (none, arrow, triangle, bar,
  dot, circle, diamond), font size, opacity.
- **Undo and redo** (⌘Z, ⇧⌘Z, ⌘Y): one step per gesture or command.
- **Shortcuts** (Excalidraw's): V or 1 selection, R or 2 rectangle, D or 3 diamond, O or 4
  ellipse, A or 5 arrow, L or 6 line, P, X or 7 draw, T or 8 text, E or 0 eraser, H hand, Q keeps
  the tool, Delete, ⌘D, ⌘A, ⌘Z, ⇧⌘Z, arrows, Enter, Escape. Space-drag, scrolling and the hand
  tool pan; pinch and ⌘-scroll zoom (10%–3000%). The tool bar's tooltips show each tool's keys
  (`DrawingTool.shortcut`, the one table).
- **Rendering**: every element type in full except images (a placeholder) and frames (outline and
  name); every arrowhead Excalidraw has (arrow, bar, dot, circle, circle outline, triangle,
  triangle outline, diamond, diamond outline, crow's feet); elbow arrows as rounded runs; unknown
  types as a dashed box.
- **Versions**: every change bumps `version`, `versionNonce` and `updated` like Excalidraw's
  `mutateElement`, so merges with web edits prefer the newer one. Undo and redo bump them too, and
  undoing a creation (or deleting) leaves a tombstone (`isDeleted: true`) rather than removing
  the element. New elements get the plugin's 8-character ids, a random seed, `version` 1 and a
  fractional `index` after their neighbors (rocicorp/fractional-indexing, ported).

## What's preserved

Everything read is written back: unknown element types (drawn as a dashed box, never modified
unless moved as part of a selection), unknown fields of elements, bindings, the scene and its
`appState`, the `files` map (images aren't loaded yet), `customData`, the plugin's `rawText`
(which follows edited text), links, locks, group ids, frame ids and fractional indices. In the
file: the frontmatter, the notice and any markdown above the data, `## Element Links`,
`## Embedded Files`, unknown sections, and what follows the drawing.

**Deferred**: loading images from `files`, rotating with a handle (angles are kept and drawn),
editing elbow arrows (drawn, kept), creating frames, z-order commands, copy and paste,
grid and snapping, the linear element editor's midpoints, and the eraser's undo-while-dragging.

## API for the editor integration

```swift
let document = ExcalidrawMarkdown.parse(text)          // never throws; check document.readable
let canvas = DrawingCanvasView(scene: document.scene, mode: .display, theme: .dark)
canvas.onChange = { scene in                            // every committed change; debounce the save
  let text = try ExcalidrawMarkdown.serialize(scene, previous: document)
}
canvas.onEndEditing = { canvas.mode = .display }        // Escape with nothing selected
canvas.mode = .editing                                  // edit in place (tool bar, keys, pointer)
canvas.preferredHeight(forWidth: 360)                   // or canvas.preferredSize at zoom 1
canvas.setScene(newScene)                               // the file changed on disk
canvas.background = .transparent                        // or .scene (default), .color("#fff")
canvas.showsToolbar = false                             // place the tool bar yourself:
host.addSubview(canvas.makeToolbarView())               // it follows the canvas's editor

// A save that found the file changed elsewhere: both sides' work, element by element.
let merged = SceneMerge.merge(base: sceneAsRead, local: canvas.scene, remote: theirs.scene)

// Inline previews, cached by content hash:
let previews = DrawingPreviewCache()
let image = previews.image(for: scene, contentHash: hashOfTheFile, width: 360, displayScale: 2,
                           theme: .dark)

// New drawings and embeds:
let path = DrawingFileName.uniquePath(forName: DrawingFileName.name(at: Date())) { exists($0) }
let embed = DrawingEmbed.newDrawing(target: "Drawing 2026-09-25 11.52.33.excalidraw").markdown
let file = ExcalidrawMarkdown.newFile(for: ExcalidrawScene())
```

In display mode the canvas draws the scene fitted to its bounds and passes mouse, key and scroll
events on (the host selects, moves and resizes the embed). In editing mode it becomes first
responder when clicked. `DrawingImage.render(_:scale:theme:background:)` renders a bitmap with
Excalidraw's export padding.

## Fonts

`Resources/Fonts/Excalifont-Regular.woff2` is the official Excalifont (OFL-1.1, unmodified; its
license is `Excalifont-OFL.txt` next to it and inside the font). It draws Excalifont (5), Virgil (1)
and Obsidian's custom font (4). Helvetica (2) draws in Helvetica, Cascadia (3) and Comic Shanns
(8) in Menlo, Nunito (6) in Avenir Next, Lilita One (7) in Arial Rounded, Liberation Sans (9) in
Arial. Text is positioned with Excalidraw's metrics for each family whatever font draws it. The
font is found next to the app's resources or the binary, never through `Bundle.module` (which
traps outside a SwiftPM build).

## Performance

A 2,000-element drawing (fills, arrows, freehand strokes, text) in a 1200 × 800 canvas at 2×,
about 300 elements on screen:

| | Test build (debug) | Release |
| --- | --- | --- |
| Pan frame (cached layer blitted) | 3.8 ms | 2.2 ms |
| Freehand frame (a point added + redraw) | 4.1 ms | 2.1 ms |
| Drag frame (a shape moved + redraw) | 5.0 ms | 2.7 ms |
| Static layer render (view + 50% margins) | 53 ms | 49 ms |
| Shape generation, all 2,000, cold | 255 ms | 30 ms |
| Parse / write a 1.6 MB file | 195 / 237 ms | 110 / 98 ms |
| Nudge + commit (undo diff) | 9.8 ms | 1.9 ms |

How: shapes are generated once per element and reused until something that changes the shape
changes (moving doesn't: shapes are in element coordinates; `ElementRenderCache`, keyed by
version and nonce, then by the shape's inputs). Elements that aren't changing are drawn into one
bitmap a margin larger than the view (`StaticLayerCache`), redrawn only when they change, the zoom
or theme changes or the view moves past the margin; frames blit it and draw the few live
elements on top. Colors are parsed and themed once (`DrawingColorCache`). Undo stores element
diffs. The static layer is redrawn when a gesture starts and ends (the moving elements leave and
rejoin it); tiling it would remove that hitch.

`Tests/…/Performance/PerformanceTests.swift` asserts budgets in the test build (frames under
16.7 ms), scaled by `PERF_BUDGET_MULTIPLIER` (4 in CI), and prints `PERF` lines.

## Testing

`apps/macos/scripts/test.sh DailyDoListDrawing`. Fixtures are read from the source tree.

- **Model and codec**: JSON parsing and writing (JavaScript number formatting and escaping),
  byte-for-byte round trips with unknown types and fields, absent and unreadable fields,
  version bumps, ids, fractional indices (checked against the JavaScript library), and merging
  two versions of a scene (`SceneMergeTests`: newer versions, nonce ties, tombstones and
  removals, order, files).
- **File format**: this package's plugin-style fixtures (`fixtures/`: both plugin layouts,
  compressed and not, the blank template, unknown sections, frontmatter and fields), problems,
  embeds and file names; LZ-String against samples the JavaScript library compressed.
- **Shared fixtures**: `SharedFixtureTests` replays every fixture of
  `packages/core/test/drawings/fixtures` (parse summary, byte-exact round trip,
  stability, same scenes). It runs when the fixtures are in the checkout, or with
  `DRAWING_FIXTURES_DIR` set to a folder of them.
- **Rough.js parity**: `fixtures/rough-parity.jsonl` holds 24 op sets generated by Rough.js 4.6.4
  itself (every shape, fill style and sloppiness level, Excalidraw's rounded paths); the port
  matches within 1e-7. Generated once with node from the npm package; the tooling isn't kept.
- **Renderer snapshots** (written to `.build/drawing-snapshots/` for review, never committed):
  every element type in both themes, the plugin fixture, sloppiness levels, stroke styles and
  widths, every arrowhead; pixel checks for blank renders, the dark canvas, solid fills and
  determinism; previews cached by content hash.
- **Tools**: the editor driven with pointer and key sequences (drawing, square and centered
  shapes, moving, resizing with handles, marquee and shift-click, hit tolerances, a bound arrow
  that follows its shape, lines drawn click by click, angle snapping, freehand, text and labels,
  undo and redo, delete and duplicate, the eraser, styles, Excalidraw's shortcuts, Escape).
- **Canvas**: the view driven with real `NSEvent`s (drawing, moving, resizing and undoing with
  the mouse and keys, a bound arrow, typing text in place, labeling on double-click, Escape,
  panning and zooming, display mode) and snapshots of the editing canvas with its tool bar.
- **Performance**: budgets above.

## Sources and licenses

Behavior and look follow [Excalidraw](https://github.com/excalidraw/excalidraw) 0.18.1 (MIT),
read from its published package: `scene/Shape.ts` (rough options, shapes, arrowheads),
`renderer/renderElement.ts` (drawing, text, transforms), `element/binding.ts` and `distance.ts`
(binding), `element/textElement.ts` and `textWrapping.ts` (labels, wrapping),
`element/newElement.ts` (field order and defaults), `colors.ts` and open-color 1.9.1 (the
palette), `fonts/FontMetadata.ts` (metrics), `constants.ts` (defaults, shortcuts). Ported with
their licenses noted in the source: [Rough.js](https://github.com/rough-stuff/rough) 4.6.4,
hachure-fill 0.5.2, points-on-curve 0.2.0, points-on-path 0.2.1 (MIT, Preet Shihn);
[perfect-freehand](https://github.com/steveruizok/perfect-freehand) 1.2.0 (MIT, Stephen Ruiz);
[lz-string](https://github.com/pieroxy/lz-string) 1.5.0 (MIT, pieroxy);
[fractional-indexing](https://github.com/rocicorp/fractional-indexing) 3.2.0 (CC0). The file
format follows the [Obsidian Excalidraw plugin](https://github.com/zsviczian/obsidian-excalidraw-plugin)
(`ExcalidrawData.ts`, `excalidrawMarkdownParsing.ts`) through `@ddl/core`. Excalifont is OFL-1.1.
