import AppKit
import DailyDoListDrawing
import Testing

@testable import DailyDoListEditor

/// Notes with drawings rendered offscreen, light and dark, written to `.build/editor-snapshots/`
/// for review (never committed), with pixel checks that the drawings are drawn where their boxes
/// are and the text stays out of them.
@Suite("Drawing snapshots")
@MainActor
struct DrawingSnapshotTests {
  static let note = """
    # Kitchen remodel
    ![[Plan.excalidraw|260|right-wrap]]
    The drawing floats on the right and this paragraph wraps around it, line after line, the way \
    Obsidian's live preview does it. Typing here never runs into the drawing: every line is \
    shortened while the float is next to it, then the text takes the whole column again.

    - [ ] Measure the counter
    - [ ] Pick tiles
    ![[Flow.excalidraw]]
    ![[Plan.excalidraw|200|left-wrap]]
    A drawing on the left works the same way: the text starts after it and wraps until the float \
    ends below, which takes a few lines of text at this width.
    End of the note.
    """

  static var drawings: [String: EditorDrawingState] {
    [
      "Plan.excalidraw": .ready(TestDrawings.drawing()),
      "Flow.excalidraw": .ready(
        TestDrawings.drawing(
          "Excalidraw/Flow.excalidraw.md",
          scene: TestDrawings.scene(width: 600, height: 160, seed: 7)
        )),
    ]
  }

  @Test(arguments: [("light", NSAppearance.Name.aqua), ("dark", NSAppearance.Name.darkAqua)])
  func rendersDrawingsInANote(name: String, appearance: NSAppearance.Name) throws {
    let editor = DrawingEditorHarness(
      text: Self.note, drawings: Self.drawings, size: NSSize(width: 760, height: 1100),
      appearance: appearance)
    let rep = editor.snapshot()
    try write(rep, "drawings-\(name).png")
    let scale = CGFloat(rep.pixelsWide) / editor.textView.visibleRect.width
    let background = try #require(
      rep.colorAt(x: 4, y: 4)?.usingColorSpace(.sRGB))
    for line in [1, 6, 7] {
      let box = try #require(editor.box(line: line), "line \(line) isn't drawn")
      #expect(
        distinctColors(in: box, rep: rep, scale: scale, excluding: background) > 3,
        "the drawing on line \(line) is blank")
    }
  }

  @Test func rendersASelectedDrawingWithItsHandles() throws {
    let editor = DrawingEditorHarness(text: Self.note, drawings: Self.drawings)
    let box = try #require(editor.box(line: 1))
    editor.click(CGPoint(x: box.midX, y: box.midY))
    #expect(editor.controller.selectedDrawingLine == 1)
    try write(editor.snapshot(), "drawings-selected.png")
  }

  @Test func placeholdersKeepTheirWordsInsideTheBox() throws {
    let text = """
      ![[A drawing with a rather long name.excalidraw|150|right-wrap]]

      ![[Broken.excalidraw|150|right-wrap]]
      The caret's line.
      """
    let editor = DrawingEditorHarness(
      text: text,
      drawings: [
        "A drawing with a rather long name.excalidraw": .missing,
        "Broken.excalidraw": .unreadable,
      ])
    let rep = editor.snapshot()
    try write(rep, "drawings-placeholders.png")
    let scale = CGFloat(rep.pixelsWide) / editor.textView.visibleRect.width
    let background = try #require(rep.colorAt(x: 4, y: 4)?.usingColorSpace(.sRGB))
    for line in [0, 2] {
      let box = try #require(editor.box(line: line), "line \(line) isn't drawn")
      #expect(
        distinctColors(in: box, rep: rep, scale: scale, excluding: background) > 2,
        "no words on line \(line)")
      let outside = CGRect(x: box.minX - 40, y: box.minY, width: 36, height: box.height)
      #expect(
        distinctColors(in: outside, rep: rep, scale: scale, excluding: background) == 0,
        "the words on line \(line) spill out of the box")
    }
  }

  private func write(_ rep: NSBitmapImageRep, _ name: String) throws {
    let png = try #require(rep.representation(using: .png, properties: [:]))
    try FileManager.default.createDirectory(
      at: RenderSnapshotTests.outputDirectory, withIntermediateDirectories: true)
    try png.write(to: RenderSnapshotTests.outputDirectory.appendingPathComponent(name))
  }

  private func distinctColors(
    in rect: CGRect, rep: NSBitmapImageRep, scale: CGFloat, excluding background: NSColor
  ) -> Int {
    var colors = Set<UInt32>()
    let visible = rect
    for y in stride(from: visible.minY + 2, to: visible.maxY - 2, by: 3) {
      for x in stride(from: visible.minX + 2, to: visible.maxX - 2, by: 3) {
        guard let color = rep.colorAt(x: Int(x * scale), y: Int(y * scale))?.usingColorSpace(.sRGB)
        else { continue }
        if abs(color.redComponent - background.redComponent) < 0.02
          && abs(color.greenComponent - background.greenComponent) < 0.02
          && abs(color.blueComponent - background.blueComponent) < 0.02
        {
          continue
        }
        colors.insert(
          UInt32(color.redComponent * 255) << 16 | UInt32(color.greenComponent * 255) << 8
            | UInt32(color.blueComponent * 255))
      }
    }
    return colors.count
  }
}
