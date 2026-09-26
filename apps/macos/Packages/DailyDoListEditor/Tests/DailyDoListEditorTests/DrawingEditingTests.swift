import AppKit
import DailyDoListDrawing
import DailyDoListUITestSupport
import DailyDoListVim
import Testing

@testable import DailyDoListEditor

/// Editing a drawing in place: the canvas replaces the embed's box, takes the keyboard (vim
/// doesn't), reports every change to the host, grows with the drawing, takes new versions from
/// elsewhere, and ends with Escape or a click outside.
@Suite("Drawing embeds: editing in place")
@MainActor
struct DrawingEditingTests {
  static let text = DrawingInteractionTests.text

  func canvasEvent(
    _ canvas: DrawingCanvasView, _ type: NSEvent.EventType, _ point: CGPoint, window: NSWindow,
    clickCount: Int = 1
  ) -> NSEvent {
    NSEvent.mouseEvent(
      with: type, location: canvas.convert(point, to: nil), modifierFlags: [],
      timestamp: ProcessInfo.processInfo.systemUptime, windowNumber: window.windowNumber,
      context: nil, eventNumber: 0, clickCount: clickCount, pressure: 1)!
  }

  /// Draws with the current tool from `start` to `end` (canvas coordinates).
  func draw(_ editor: DrawingEditorHarness, from start: CGPoint, to end: CGPoint) throws {
    let canvas = try #require(editor.controller.drawingCanvas)
    canvas.mouseDown(with: canvasEvent(canvas, .leftMouseDown, start, window: editor.window))
    for step in 1...6 {
      let t = CGFloat(step) / 6
      let point = CGPoint(x: start.x + (end.x - start.x) * t, y: start.y + (end.y - start.y) * t)
      canvas.mouseDragged(
        with: canvasEvent(canvas, .leftMouseDragged, point, window: editor.window))
    }
    canvas.mouseUp(with: canvasEvent(canvas, .leftMouseUp, end, window: editor.window))
    editor.layout()
  }

  @Test func returnOnASelectedDrawingEditsItInPlace() throws {
    let editor = DrawingEditorHarness(text: Self.text, drawings: DrawingEmbedTests.plan)
    let box = try #require(editor.box(line: 1))
    editor.click(CGPoint(x: box.midX, y: box.midY))
    editor.press("<CR>")
    let canvas = try #require(editor.controller.drawingCanvas)
    #expect(canvas.mode == .editing)
    #expect(canvas.superview === editor.textView)
    #expect(editor.window.firstResponder === canvas)
    #expect(editor.controller.editingDrawingPath == "Excalidraw/Plan.excalidraw.md")
    let editingBox = try #require(editor.box(line: 1))
    #expect(canvas.frame == editingBox)
    #expect(editingBox.width == 240)
    #expect(editingBox.height >= EmbedGeometry.minEditingHeight)
    #expect(!canvas.showsToolbar)
    let toolbar = try #require(editor.controller.embeds.session?.toolbar)
    #expect(toolbar.superview === editor.textView)
    #expect(!toolbar.frame.intersects(canvas.frame))
    #expect(editor.text == Self.text)
  }

  @Test func aDoubleClickEditsInPlace() throws {
    let editor = DrawingEditorHarness(text: Self.text, drawings: DrawingEmbedTests.plan)
    let box = try #require(editor.box(line: 1))
    editor.click(CGPoint(x: box.midX, y: box.midY))
    editor.click(CGPoint(x: box.midX, y: box.midY), count: 2)
    #expect(editor.controller.isEditingDrawing)
  }

  @Test func drawingReportsEveryChangeAndEscapeEndsEditing() throws {
    let editor = DrawingEditorHarness(text: Self.text, drawings: DrawingEmbedTests.plan)
    #expect(editor.controller.beginEditingDrawing(atLine: 1))
    editor.press("r")
    let canvas = try #require(editor.controller.drawingCanvas)
    #expect(canvas.editor.tool == .rectangle)
    try draw(editor, from: CGPoint(x: 20, y: 150), to: CGPoint(x: 90, y: 200))
    let edit = try #require(editor.delegate.edits.last)
    #expect(edit.path == "Excalidraw/Plan.excalidraw.md")
    #expect(edit.scene.visibleElements.count == 3)
    #expect(edit.contentHash == DrawingContentHash.hash(edit.scene))
    #expect(editor.text == Self.text, "drawing never edits the note")
    // The new rectangle is selected: the first Escape deselects it, the second ends editing.
    editor.press("<Esc>")
    editor.press("<Esc>")
    #expect(!editor.controller.isEditingDrawing)
    #expect(canvas.superview == nil)
    #expect(editor.delegate.endedEditing == ["Excalidraw/Plan.excalidraw.md"])
    #expect(editor.controller.selectedDrawingLine == 1)
    #expect(editor.window.firstResponder === editor.textView)
    // The preview shows the new version.
    #expect(
      editor.controller.drawingState(for: "Plan.excalidraw")?.drawing?.contentHash
        == edit.contentHash)
  }

  @Test func aClickOutsideEndsEditing() throws {
    let editor = DrawingEditorHarness(text: Self.text, drawings: DrawingEmbedTests.plan)
    #expect(editor.controller.beginEditingDrawing(atLine: 1))
    editor.click(CGPoint(x: editor.textView.textContainerOrigin.x + 10, y: 8))
    #expect(!editor.controller.isEditingDrawing)
    #expect(editor.controller.selectedDrawingLine == nil)
    #expect(editor.delegate.endedEditing.count == 1)
  }

  @Test func vimDoesntTakeKeysWhileADrawingIsEdited() throws {
    let editor = DrawingEditorHarness(
      text: Self.text, drawings: DrawingEmbedTests.plan,
      configuration: EditorConfiguration(vimMode: true))
    let vim = Vim(scheduler: ManualVimScheduler(), isMac: true)
    editor.controller.vim = vim
    #expect(editor.controller.vimSession?.mode == .normal)
    #expect(editor.controller.beginEditingDrawing(atLine: 1))
    for key in ["r", "i", "d", "d", ":", "x", "o", "<CR>"] { editor.press(key) }
    let canvas = try #require(editor.controller.drawingCanvas)
    #expect(canvas.editor.tool == .ellipse, "the canvas took r, d and o")
    #expect(editor.text == Self.text)
    #expect(editor.controller.vimSession?.mode == .normal)
    #expect(editor.controller.vimSession?.activePrompt == nil)
    // Back in the note, vim has the keys again.
    editor.press("<Esc>")
    editor.press("<Esc>")
    #expect(!editor.controller.isEditingDrawing)
    editor.press("i")
    #expect(editor.controller.vimSession?.mode == .insert)
  }

  @Test func theBoxGrowsWhileDrawing() throws {
    let editor = DrawingEditorHarness(text: Self.text, drawings: DrawingEmbedTests.plan)
    #expect(editor.controller.beginEditingDrawing(atLine: 1))
    let before = try #require(editor.box(line: 1))
    editor.press("r")
    try draw(
      editor, from: CGPoint(x: 20, y: before.height - 40),
      to: CGPoint(x: 120, y: before.height + 120))
    let after = try #require(editor.box(line: 1))
    #expect(after.height > before.height + 100)
    #expect(try #require(editor.controller.drawingCanvas).frame == after)
    // The text wraps around the taller box.
    let rects = editor.lineRects(
      of: NSRange(location: editor.offset(of: "Text flows"), length: 300))
    for rect in rects where rect.maxY > after.minY && rect.minY < after.maxY {
      #expect(rect.maxX <= after.minX - EmbedGeometry.floatGap + 0.5)
    }
  }

  @Test func aNewVersionFromElsewhereReplacesTheCanvasScene() throws {
    let editor = DrawingEditorHarness(text: Self.text, drawings: DrawingEmbedTests.plan)
    #expect(editor.controller.beginEditingDrawing(atLine: 1))
    var scene = TestDrawings.scene()
    var extra = ExcalidrawElement(id: "remote", type: .diamond)
    extra.x = 40
    extra.y = 40
    extra.width = 60
    extra.height = 60
    scene.elements.append(extra)
    editor.delegate.drawings["Plan.excalidraw"] = .ready(TestDrawings.drawing(scene: scene))
    editor.controller.drawingsDidChange()
    let canvas = try #require(editor.controller.drawingCanvas)
    #expect(canvas.scene.element(id: "remote") != nil)
    #expect(editor.controller.isEditingDrawing)
  }

  @Test func editingEndsWhenTheEmbedsLineGoesAway() async throws {
    let editor = DrawingEditorHarness(text: Self.text, drawings: DrawingEmbedTests.plan)
    #expect(editor.controller.beginEditingDrawing(atLine: 1))
    let line = (Self.text as NSString).range(of: "![[Plan.excalidraw|240|right-wrap]]\n")
    editor.controller.applyRemoteChanges([EditorTextChange(range: line, text: "")])
    editor.layout()
    for _ in 0..<5 where editor.controller.isEditingDrawing { await Task.yield() }
    #expect(!editor.controller.isEditingDrawing)
    #expect(editor.delegate.endedEditing == ["Excalidraw/Plan.excalidraw.md"])
  }

  @Test func switchingNotesEndsEditing() throws {
    let editor = DrawingEditorHarness(text: Self.text, drawings: DrawingEmbedTests.plan)
    #expect(editor.controller.beginEditingDrawing(atLine: 1))
    editor.controller.setText("Another note", resetUndo: true)
    #expect(!editor.controller.isEditingDrawing)
    #expect(editor.delegate.endedEditing == ["Excalidraw/Plan.excalidraw.md"])
    #expect(editor.textView.subviews.allSatisfy { !($0 is DrawingCanvasView) })
  }

  @Test(arguments: [("light", NSAppearance.Name.aqua), ("dark", NSAppearance.Name.darkAqua)])
  func rendersADrawingBeingEdited(name: String, appearance: NSAppearance.Name) throws {
    let editor = DrawingEditorHarness(
      text: Self.text, drawings: DrawingEmbedTests.plan, appearance: appearance)
    #expect(editor.controller.beginEditingDrawing(atLine: 1))
    try editor.snapshot().writePNG(
      "drawings-editing-\(name)", in: RenderSnapshotTests.outputDirectory)
  }
}
