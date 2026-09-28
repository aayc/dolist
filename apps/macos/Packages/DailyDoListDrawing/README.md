# DailyDoListDrawing

The Mac and iPhone apps' shared native drawing engine: Excalidraw scenes stored in the Obsidian Excalidraw
plugin's `.excalidraw.md` files, drawn with a port of Rough.js so they look the way Excalidraw
draws them, and edited in AppKit or UIKit canvases. Written from scratch for speed, with
Excalidraw's core tools and shortcuts. The web app embeds the real Excalidraw editor; both edit the
same files ([spec](../../../../docs/specs/drawings.md)).

## Targets

| Target | What | Platforms |
| --- | --- | --- |
| `DailyDoListDrawingModel` | The scene model, its JSON codec, the file format, LZ-String, embeds and file names. Foundation only. | macOS, iOS |
| `DailyDoListDrawingCore` | Rough.js, CoreGraphics/CoreText rendering, shared editing tools, geometry, history and Excalifont resources. | macOS, iOS |
| `DailyDoListDrawing` | AppKit canvas and toolbar; re-exports the shared core to preserve existing imports. | macOS |
| `DailyDoListMobileDrawing` | UIKit touch canvas, inline text editor and SwiftUI controls. | iOS |

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
- **Rendering**: embedded raster images decode through ImageIO (no network access); frames draw
  an outline and name; every arrowhead Excalidraw has (arrow, bar, dot, circle, circle outline, triangle,
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
`appState`, the `files` map (including untouched file metadata), `customData`, the plugin's `rawText`
(which follows edited text), links, locks, group ids, frame ids and fractional indices. In the
file: the frontmatter, the notice and any markdown above the data, `## Element Links`,
`## Embedded Files`, unknown sections, and what follows the drawing.

**Deferred**: extended SVG image features, exact upstream elbow-route geometry fixtures and Mac arrangement controls. Shared frame/point/grid commands are available on both platforms;
the expanded inspector is currently native iPhone UI.

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

// A save that found the file changed elsewhere: elements and per-key scene settings.
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
- **Renderer**: pixel checks of every element type in both themes (also written to
  `.build/drawing-snapshots/`, never committed), the dark canvas, solid fills and determinism;
  previews cached by content hash.
- **Tools**: the editor driven with pointer and key sequences (drawing, square and centered
  shapes, moving, resizing with handles, marquee and shift-click, hit tolerances, a bound arrow
  that follows its shape, lines drawn click by click, angle snapping, freehand, text and labels,
  undo and redo, delete and duplicate, the eraser, styles, Excalidraw's shortcuts, Escape).
- **Canvas**: the view driven with real `NSEvent`s (drawing, moving, resizing and undoing with
  the mouse and keys, a bound arrow, typing text in place, labeling on double-click, Escape,
  panning and zooming, display mode) and snapshots of the editing canvas with its tool bar.
- **Performance**: budgets above.
- **iPhone imports and library** (`DailyDoListMobileDrawingTests`): superseded and cancelled photo
  loads, the exact request-size boundary and legacy library migration run here without UIKit; the
  iPhone app's test bundle also compiles this folder and adds the UIKit cases.

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

## iPhone integration and parity checklist

`DailyDoListMobileDrawing` exposes `MobileDrawingController(scene:environment:)` and
`MobileDrawingView(controller:)`. The controller's `onChange` receives each committed scene;
its document owner handles debouncing, file serialization, saves, offline state and conflict merges.
Use `replaceScene(_:keepHistory:)` for external updates and `finishEditing()` before leaving.
`isEditing = false` makes a preview. `MobileDrawingCanvas(controller:theme:background:)` embeds
only the canvas; `MobileDrawingCanvasView` is the UIKit API. Both platforms share the same
`DrawingEditor` and `DrawingPreviewCache`. Mac resource packaging already copies all SwiftPM
bundles; the font now lives in `DailyDoListDrawing_DailyDoListDrawingCore.bundle`.

One finger uses the active tool; two fingers pan and pinch. The hand tool also pans with one
finger. Selection handles have a 44-point hit diameter. The actions menu supplies multi-select,
constraints, drawing from center, duplication, deletion, text/label editing and completing a
multi-point line. A second finger interrupts a live gesture by restoring the last committed
scene, without saving or adding undo. The inspector edits the shared `ElementStyle`.

The inventory below comes from the pinned Excalidraw 0.18.1 source in its package source maps:
`shapes.tsx`, `components/Actions.tsx`, `App.getContextMenuItems`, `actions/actionFrame.ts`,
`actions/actionProperties.tsx`, and library controls. The app wrapper in
`apps/web/src/features/drawings/DrawingEditor.tsx` disables export/load/save-as-image/save-to-file
and AI, supplies only canvas background, clear and help in the main menu, but leaves context-menu
copy-as-PNG/SVG available. These remaining controls are separate acceptance work, not implied by
rendering an imported scene. The pinned package references `changeStrokeShape` in Actions, but
registers no implementation; its action manager returns null, so there is no exposed freehand stroke-shape control.

- [x] Shared model/editor/renderer extraction, unchanged Mac public import and baseline tests.
- [x] Native core ten tools, selection/marquee, move/resize, bound labels, text, styles, eraser,
  undo/redo with tombstones, and unknown JSON/file preservation through the shared codec.
- [x] Touch navigation, interruption rollback, explicit multi-select/constraints and 44-point controls.
- [ ] Runtime iPhone computer-use verification of every tool, keyboard, rotation, dark mode and save/reopen.
- [x] Raster images: embedded file decode/render, photo/file insertion and replacement, crop and flip.
- [x] Bounded static SVG shapes, transforms, clipping and embedded raster image decode.
- [ ] Extended SVG: arc paths, text, CSS, gradients, filters and external resources remain unsupported;
  original embedded bytes stay intact and the renderer shows a placeholder.
- [x] Shared transform commands and native mobile menus: rotation, four layer commands, grouping/ungrouping, lock/unlock-all,
  horizontal/vertical flip, six alignment and two distribution controls.
- [x] Clipboard: copy/cut/paste with bound labels, frames, groups and file references; copy/paste styles; copy as PNG.
- [x] Clipboard: vector SVG export (rough paths and text glyphs, local PNG bytes for image elements).
- [x] Frames: create, rename, wrap selection, select children, remove children and visibility.
- [x] Lines/arrows: insert/delete points, draggable midpoints, elbow creation/editing and straight/round/elbow controls.
- [x] Elbow routing around bound endpoint shapes, fixed-segment movement/release and fixed endpoint bindings.
- [ ] Exact upstream elbow-route geometry for overlap and equal-cost route choices is not fixture-certified.
- [x] Text: vertical alignment, bind/unbind/wrap text in container and automatic-width control.
- [x] Precision: visible grid, snap construction/movement to grid, snap movement to object edges/centers.
- [x] Precision: object snapping while constructing and resizing axis-aligned selections.
  Rotated resizing keeps grid snapping in local axes.
- [x] Canvas: background, clear, zoom to selection/reset zoom, view/zen mode, text search, statistics and help.
- [x] Links: edit/open links and copy element link with host-provided navigation policy.
- [x] Library: save selection, insert/delete items and import/export library files; external browse
  requires host navigation policy and never silently fetches or publishes drawings.
- [x] Native object accessibility actions, hardware shortcuts and all built-in font-family choices.
- [x] Inline selected-font preview and native touch rotation handle (one undo step).
- [ ] Integrated VoiceOver/hardware-keyboard runtime verification.
- [x] Extra tools: embeddable URL cards and transient laser pointer. Mermaid generation is deliberately
  unavailable in the web wrapper (`excalidraw-assets.ts` substitutes an explanatory stub); AI is disabled.

The first mobile checkpoint compiles against the iOS SDK; runtime verification belongs to the
integrated app. Unchecked features remain explicit implementation work.

The second checkpoint adds raster images and arrangement commands. Image decoding is local,
bounded to 32 MB input and 4096 pixels per side, with a 64 MB decoded-image cache. iOS imports
normalize orientation and store PNG so web clients can render the same bytes. Replacing an image
creates a new file ID; old files stay for undo and tombstones. Crop, transforms and arrangement
commands produce ordinary element versions and participate in the shared undo history. Grouped
objects align and distribute as units. Imported SVG bytes remain preserved but are not yet decoded.

The third checkpoint adds shared frame creation/wrapping/membership, renaming, selecting/releasing
children and a native frame-visibility switch; line/arrow point insertion/deletion with midpoint
handles; straight/round/orthogonal elbow controls; grid construction/movement and object-edge/center
movement snapping. Grid settings persist in `appState`, including undo; canvas background changes
now participate in history as well. Frame resizing changes membership without scaling children.
The mobile actions menu opens **Frames, points and snapping**. Mac gets the frame tool and shared
command APIs without changing its existing interaction policy. Elbow obstacle routing and the other
unchecked controls remain explicit follow-up work.

The fourth checkpoint adds Excalidraw clipboard transfer (including PNG images), style transfer,
and a device-local shape library with import/export, insertion and deletion. Transfers remap
element/group identities and internal bindings; colliding image file IDs get new IDs without
overwriting existing bytes. Unknown element, binding, file and library-item metadata survives.
Pasted elements use normal undo/tombstones. JSON transfer is bounded to 32 MB and 10,000 elements;
libraries to 1,000 items. Failed imports leave the drawing/library untouched.

`MobileDrawingController.onOpenLink` must be connected to the app's navigation policy;
`elementLink` supplies a deep link for a drawing element ID. Without these callbacks, the relevant
buttons are disabled. `library` defaults to a memory-only library; the host injects one
persistent library into every controller (see [Imports and the shape library](#imports-and-the-shape-library)).
Library access is explicit user interaction and never a remote request. The **Copy, library and
links** action opens these controls. Integrated runtime checks remain pending.

The fifth checkpoint exposes text binding, vertical alignment and automatic width; canvas
background/clear/search/statistics/help; view/zen modes; selection/reset zoom; all built-in font IDs
(using the documented device font fallbacks); VoiceOver object actions and hardware keyboard
commands. Shapes remain native accessibility elements; text entry keeps UIKit's standard input.
Escape now rolls back an interrupted pointer gesture, matching touch cancellation.

`MobileDrawingController.hasActiveInteraction` reports pointer gestures, text editing and
multi-point lines. `onInteractionEnd` runs on the next main-actor turn and rechecks idle state,
including after a selection-only gesture, so the document host can defer incoming scene rebases.
The host must recheck its session identity and pending revision in that callback. `finishEditing()`
flushes UIKit marked/text input and commits the visible pointer position before background saves.
The shared editor exposes the same activity state and explicit `commitInteraction()`; existing
Mac `finishInteraction()` behavior remains available. Focused text/history/interaction tests and
unsigned iOS compilation cover this checkpoint; integrated runtime checks remain with the app.

`SceneMerge` compares each top-level `appState` key against the saved base. Local-only changes
(including background, grid settings and removed keys) survive; a concurrent remote change wins
that key. Missing keys differ from JSON null, and object key reordering is not a change. Nested
values merge as whole values. Unknown scene fields and embedded-file merge behavior are preserved.
The pure TypeScript reference is `mergeDrawingAppState` in `@ddl/core`.

SVG copy exports rough geometry and glyph outlines as paths, preserving rotation, opacity, frame
clipping and arrow-label gaps; raster image elements embed normalized local PNG bytes. It does not
export active links or resources. Static SVG image import/rendering accepts basic shapes, M/L/H/V/
C/S/Q/T/Z paths, transforms, presentation styles, clipping and embedded raster images, with a 2 MB
source limit, 10,000 nodes, 64 nesting levels, bounded path tokens and 4096-pixel raster bounds.
Unknown or active constructs reject the whole SVG, preserving the original drawing file bytes.
The parser never resolves entities, external resources, CSS or scripts; unsupported extended SVG
remains an explicit parity gap. Accepted file imports retain original SVG bytes rather than replacing
them with a raster. Regression tests cover rejection, transforms/clipping, vector text export and
embedded image transfer. Visual runtime parity still requires the integrated app pass.

The latest touch checkpoint adds construction and axis-aligned resize snapping to object edges
and centers; a rotation handle with 15-degree constraints and one undo step; the selected-font
preview; native URL-card creation; and a laser trail that expires after 0.8 seconds without changing
the scene, save state or history. Selecting a normal tool exits laser mode. URL cards retain standard
`embeddable` elements plus a bound URL label; their content opens only through the host's explicit
link action. They do not create a hidden browser or automatically fetch remote pages. This is the
native card adapter for web embeds. Source-map inspection confirms `changeStrokeShape` has no
registered action in pinned Excalidraw 0.18.1, so it is not an exposed control to reproduce.

Elbows now use a bounded rectilinear visibility graph around their two bound endpoint shapes, matching
the scope of the pinned web router. Midpoint drags move and fix an elbow segment; inspector commands
fix, release, nudge or reroute it. Fixed coordinates survive endpoint moves and origin normalization,
including unknown segment metadata. Native bindings record normalized `fixedPoint` values. The
router preserves the previous orthogonal route when overlapping containers provide no valid path.
It is deterministic, but exact upstream tie-breaking/overlap geometry is not covered by shared
fixtures and remains explicitly uncertified. Geometry, binding, fixed-segment and gesture-undo tests
cover the native behavior.

Holding Option restores pending erasures; grouped shapes are erased/restored together. A native
**Restore pending erasure** button clears the sweep before release. Held Shift/Option/Command/Control
flags now reach pointer actions as well as discrete keyboard commands. Inspectors observe
`committedRevision`, refreshing after edits and remote replacements without observing each pointer
sample. Final shared regression: 126 tests before the final eraser addition; the focused final
interaction/elbow pass covers 27 tests. The iOS target and UIKit tests compile unsigned. App-owned
runtime checks and the remaining explicit compatibility limits above still apply.

### Imports and the shape library

Photo, file, paste, library and style imports commit through `DrawingEditor.validatedImport`: the
import runs on a disposable editor, its exact resulting scene is validated, and only then is it
published as one undo step. A refusal changes nothing: scene, files, selection, history and saves
stay as they were. An interaction in progress (a gesture, a text edit, a line drawn click by click)
refuses a late import rather than being ended by it; explicit synchronous commands (paste, library
insertion, paste style) first finish the interaction, as other commands do.

The validation is the document owner's `MobileDrawingController.importContext`: a
`DrawingImportContext` holding the drawing's current file (frontmatter, other sections, text
elements) and its conditional base version. It serializes the candidate as the next sync will and
measures `JSONEncoder.daemon.encode(WriteNoteRequest(...))`, the daemon client's own codec with its
escaping, against the daemon's request body limit (`WIRE_LIMITS.bodyBytes`, 5 MiB, inclusive).
That is why `DailyDoListMobileDrawing` depends on `DailyDoListModels`. A 4 MiB PNG already exceeds
the limit after base64 and JSON encoding. The check costs one serialization of the drawing per
import, on the main actor.

A photo load is bound to a `DrawingImageImportSession.Request`: the image it replaces and the
insertion point are frozen when the user picks, a new request cancels the previous one, and a
completion applies only while its request is current, because photo providers may finish after
their task was cancelled. When the bytes arrive the controller rechecks edit authority (not read
only or in view mode, the replaced image still present and unlocked). The photo and file pickers
keep separate requests, so a late callback from one never applies to the other's target.

`MobileDrawingLibrary` persists through an injected `Storage`: `load` and `save` of one serialized
`.excalidrawlib`, which `save` replaces atomically and durably. It reads on first use (the library
screen, or the first change), not at launch. `Storage.memory()` keeps nothing on disk. The iPhone
app injects one library backed by a file in its managed storage root (`MobileProtectedFile`).
Earlier versions kept the library in `UserDefaults` (`drawing.library.v1`); `LegacyStorage` moves
it, removing the legacy bytes only after storage returns exactly those bytes after saving them.
Any failure keeps them and shows their shapes (insertable and exportable, not changeable) with the
error, and the next use retries. A protected copy that differs from the legacy one is never
overwritten: both are kept and reported until **Reset**, which empties both. Additions stay within
what the library can read back: 1,000 items, 32 MB, 10,000 elements per item.
