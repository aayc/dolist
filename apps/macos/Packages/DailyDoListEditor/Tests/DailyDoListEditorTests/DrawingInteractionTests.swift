import AppKit
import DailyDoListDrawing
import Testing

@testable import DailyDoListEditor

/// Selecting, moving, resizing, removing and inserting drawings, driven with real mouse and key
/// events; the results are ordinary, undoable edits of the note.
@Suite("Drawing embeds: select, move, resize, delete, insert")
@MainActor
struct DrawingInteractionTests {
  static let plan = DrawingEmbedTests.plan
  static let text =
    "Intro\n![[Plan.excalidraw|240|right-wrap]]\n\(DrawingEmbedTests.long)\nC\nD\nE"

  func makeEditor(_ text: String = Self.text) -> DrawingEditorHarness {
    DrawingEditorHarness(text: text, drawings: Self.plan)
  }

  @Test func aClickSelectsTheDrawingWithoutMovingTheCaret() throws {
    let editor = makeEditor()
    let caret = editor.selection
    let box = try #require(editor.box(line: 1))
    editor.click(CGPoint(x: box.midX, y: box.midY))
    #expect(editor.controller.selectedDrawingLine == 1)
    #expect(editor.selection == caret)
    #expect(!editor.controller.textViewDrawsInsertionPoint(editor.textView))
    editor.press("<Esc>")
    #expect(editor.controller.selectedDrawingLine == nil)
    #expect(editor.controller.textViewDrawsInsertionPoint(editor.textView))
    #expect(editor.text == Self.text)
  }

  @Test func clickingTextDeselects() throws {
    let editor = makeEditor()
    let box = try #require(editor.box(line: 1))
    editor.click(CGPoint(x: box.midX, y: box.midY))
    editor.click(CGPoint(x: editor.textView.textContainerOrigin.x + 20, y: 10))
    #expect(editor.controller.selectedDrawingLine == nil)
  }

  @Test func deleteRemovesTheEmbedsLineAsOneUndoableEdit() throws {
    let editor = makeEditor()
    let box = try #require(editor.box(line: 1))
    editor.click(CGPoint(x: box.midX, y: box.midY))
    editor.press("<BS>")
    #expect(
      editor.text
        == Self.text.replacingOccurrences(of: "![[Plan.excalidraw|240|right-wrap]]\n", with: ""))
    #expect(editor.delegate.textChanges == 1)
    #expect(editor.controller.selectedDrawingLine == nil)
    #expect(editor.controller.textContainer.exclusionPaths.isEmpty)
    editor.undo()
    #expect(editor.text == Self.text)
    // Undo selects the restored line (its syntax shows); with the caret elsewhere it's drawn.
    editor.controller.setSelection([NSRange(location: 0, length: 0)])
    editor.layout()
    #expect(editor.box(line: 1) != nil)
  }

  @Test func arrowsPutTheCaretOnTheNextOrPreviousLine() throws {
    let editor = makeEditor()
    let box = try #require(editor.box(line: 1))
    editor.click(CGPoint(x: box.midX, y: box.midY))
    editor.press("<Down>")
    #expect(editor.selection.location == editor.offset(of: "Text flows"))
    #expect(editor.controller.selectedDrawingLine == nil)
    editor.controller.setSelection([NSRange(location: (Self.text as NSString).length, length: 0)])
    editor.layout()
    editor.click(CGPoint(x: box.midX, y: box.midY))
    editor.press("<Up>")
    #expect(editor.selection.location == 5)
  }

  @Test func typingWhileSelectedGoesToTheNote() throws {
    let editor = makeEditor()
    editor.undoManager.groupsByEvent = true
    let box = try #require(editor.box(line: 1))
    editor.click(CGPoint(x: box.midX, y: box.midY))
    editor.press("x")
    #expect(editor.controller.selectedDrawingLine == nil)
    #expect(editor.text == Self.text + "x")
  }

  @Test func draggingMovesTheEmbedToTheLineAndSideItsDroppedOn() throws {
    let editor = makeEditor()
    let box = try #require(editor.box(line: 1))
    let d = try #require(
      editor.lineRects(of: NSRange(location: editor.offset(of: "\nD") + 1, length: 1)).first)
    let left = editor.textView.textContainerOrigin.x
    var during: EmbedInteraction?
    editor.drag(
      from: CGPoint(x: box.midX, y: box.midY), to: CGPoint(x: left + 30, y: d.minY + 2)
    ) {
      during = editor.controller.embeds.interaction
    }
    #expect(during?.mode == .move)
    #expect(during?.target?.placement == .leftWrap)
    #expect(
      editor.text
        == "Intro\n\(DrawingEmbedTests.long)\nC\n![[Plan.excalidraw|240|left-wrap]]\nD\nE")
    #expect(editor.controller.selectedDrawingLine == 3)
    #expect(editor.delegate.textChanges == 1)
    editor.undo()
    #expect(editor.text == Self.text)
  }

  @Test func droppingInTheMiddleMakesItFullWidth() throws {
    let editor = makeEditor()
    let box = try #require(editor.box(line: 1))
    let intro = try #require(editor.lineRects(of: NSRange(location: 0, length: 5)).first)
    let middle = editor.textView.textContainerOrigin.x + editor.controller.columnWidth / 2
    editor.drag(from: CGPoint(x: box.midX, y: box.midY), to: CGPoint(x: middle, y: intro.minY + 2))
    #expect(editor.text.hasPrefix("![[Plan.excalidraw]]\nIntro\n"))
  }

  @Test func draggingTheCornerResizesIt() throws {
    let editor = makeEditor()
    let box = try #require(editor.box(line: 1))
    editor.click(CGPoint(x: box.midX, y: box.midY))
    let corner = EmbedHandle.resizeStart.rect(in: box)
    var width: CGFloat?
    editor.drag(
      from: CGPoint(x: corner.midX, y: corner.midY),
      to: CGPoint(x: corner.midX - 60, y: corner.midY + 5)
    ) {
      editor.layout()
      width = editor.box(line: 1)?.width
    }
    #expect(width == 300, "the box follows the pointer while resizing")
    #expect(editor.text.contains("![[Plan.excalidraw|300|right-wrap]]"))
    #expect(try #require(editor.box(line: 1)).width == 300)
    #expect(editor.controller.selectedDrawingLine == 1)
    editor.undo()
    #expect(editor.text == Self.text)
  }

  @Test func theHandlesHaveTooltips() throws {
    let editor = makeEditor()
    let box = try #require(editor.box(line: 1))
    editor.click(CGPoint(x: box.midX, y: box.midY))
    let grip = EmbedHandle.grip.rect(in: box)
    let corner = EmbedHandle.resizeStart.rect(in: box)
    #expect(
      editor.controller.textView(editor.textView, toolTipAt: CGPoint(x: grip.midX, y: grip.midY))
        == "Drag to move")
    #expect(
      editor.controller.textView(
        editor.textView, toolTipAt: CGPoint(x: corner.midX, y: corner.midY))
        == "Drag to resize")
    // Only the corner that moves: a right float has no bottom-right handle.
    let end = EmbedHandle.resizeEnd.rect(in: box)
    #expect(editor.controller.embedHandle(at: CGPoint(x: end.midX, y: end.midY)) == nil)
  }

  @Test func aReadOnlyEditorSelectsButDoesntEdit() throws {
    let editor = DrawingEditorHarness(
      text: Self.text, drawings: Self.plan, configuration: EditorConfiguration(isEditable: false))
    let box = try #require(editor.box(line: 1))
    editor.click(CGPoint(x: box.midX, y: box.midY))
    editor.press("<BS>")
    editor.drag(
      from: CGPoint(x: box.midX, y: box.midY), to: CGPoint(x: box.midX - 300, y: box.maxY + 100))
    #expect(editor.text == Self.text)
    #expect(!editor.controller.beginEditingDrawing(atLine: 1))
  }

  @Test func insertingAnEmbedAtTheCaretsLine() {
    let blank = EditorHarness("Line one\n|\nLine three")
    var line: Int?
    blank.command { line = $0.insertDrawingEmbed("![[D.excalidraw|360|right-wrap]]") }
    #expect(line == 1)
    #expect(blank.marked == "Line one\n![[D.excalidraw|360|right-wrap]]\n|\nLine three")
    blank.undo()
    #expect(blank.text == "Line one\n\nLine three")

    let text = EditorHarness("Line |one")
    text.command { line = $0.insertDrawingEmbed("![[D.excalidraw|360|right-wrap]]") }
    #expect(line == 0)
    #expect(text.marked == "![[D.excalidraw|360|right-wrap]]\nLine |one")

    let readOnly = EditorHarness("x|", configuration: EditorConfiguration(isEditable: false))
    #expect(readOnly.controller.insertDrawingEmbed("![[D.excalidraw]]") == nil)
  }

  @Test func theContextMenuAsksTheHostForItsItems() throws {
    let editor = makeEditor()
    let event = editor.mouse(.rightMouseDown, at: CGPoint(x: 60, y: 10))
    _ = editor.textView.menu(for: event)
    #expect(editor.delegate.menus.count == 1)
  }
}
