import AppKit
import DailyDoListDrawing
import Testing

@testable import DailyDoListEditor

@Suite("Drawing embeds: live preview, floats and wrapping")
@MainActor
struct DrawingEmbedTests {
  static let plan: [String: EditorDrawingState] = [
    "Plan.excalidraw": .ready(TestDrawings.drawing())
  ]
  static let long = TestDrawings.paragraph + " " + TestDrawings.paragraph

  // MARK: Tokenizer

  @Test(arguments: [
    ("![[Plan.excalidraw]]", true),
    ("![[Plan.excalidraw|360|right-wrap]]", true),
    ("  ![[Excalidraw/Plan.excalidraw.md|left]]  ", true),
    ("![[Plan.excalidraw#Part|200x100]]", true),
    ("text ![[Plan.excalidraw]]", false),
    ("![[Plan.excalidraw]] and more", false),
    ("![[photo.png|300]]", false),
    ("[[Plan.excalidraw]]", false),
    ("> ![[Plan.excalidraw]]", false),
    ("- ![[Plan.excalidraw]]", false),
    ("# ![[Plan.excalidraw]]", false),
    ("![[Plan.excalidraw]] %%agent:t1%%", false),
  ])
  func findsDrawingEmbedsAloneOnTheirLine(line: String, isEmbed: Bool) {
    let (tokens, _) = MarkdownTokenizer.tokenizeLine(Array(line.utf16), state: .normal)
    #expect((tokens.embed != nil) == isEmbed, "\(line)")
    if isEmbed {
      #expect(tokens.markers == [SyntaxMarker(range: NSRange(0, line.utf16.count), kind: .embed)])
    }
  }

  @Test func embedLinesFollowEdits() {
    let editor = EditorHarness(text: "a\n![[Plan.excalidraw]]\nb\n![[Other.excalidraw|left]]")
    #expect(editor.controller.highlighter.embedLines == [1, 3])
    editor.select(NSRange(location: 0, length: 0))
    editor.type("new line\n")
    #expect(editor.controller.highlighter.embedLines == [2, 4])
    // Typing on an embed's line makes it text; deleting the typing makes it an embed again.
    let start = editor.offset(of: "![[Plan")
    editor.select(NSRange(location: start, length: 0))
    editor.type("x")
    #expect(editor.controller.highlighter.embedLines == [4])
    editor.backspace()
    #expect(editor.controller.highlighter.embedLines == [2, 4])
    editor.controller.setText("no embeds", resetUndo: true)
    #expect(editor.controller.highlighter.embedLines.isEmpty)
  }

  // MARK: Rows

  @Test func anEmbedLineShowsItsDrawingFullWidth() throws {
    let editor = DrawingEditorHarness(
      text: "Intro\n![[Plan.excalidraw]]\nAfter", drawings: Self.plan)
    let box = try #require(editor.box(line: 1))
    let column = editor.controller.columnWidth
    #expect(abs(box.width - column) < 1)
    #expect(abs(box.minX - editor.textView.textContainerOrigin.x) < 0.5)
    let natural = try #require(editor.controller.embeds.naturalSize(of: TestDrawings.drawing()))
    #expect(abs(box.height - (column * natural.height / natural.width).rounded()) <= 1)
    // The line is the drawing's height, its syntax hidden; the next line starts below it.
    let fragment = editor.controller.fragmentRect(atCharacter: editor.offset(of: "![["))
    #expect(abs(fragment.height - (box.height + 2 * EmbedGeometry.rowMargin)) < 1)
    let embedLine = NSRange(location: editor.offset(of: "![["), length: 20)
    #expect(editor.lineRects(of: embedLine).isEmpty)
    let after = try #require(
      editor.lineRects(of: NSRange(location: editor.offset(of: "After"), length: 5)).first)
    #expect(after.minY >= box.maxY)
    #expect(editor.controller.renderedEmbeds(in: editor.textView.visibleRect).count == 1)
    #expect(editor.delegate.asked.contains("Plan.excalidraw"))
  }

  @Test(arguments: [
    ("left", DrawingEmbed.Placement.left), ("right", .right), ("center", .center),
  ])
  func alignedEmbedsTakeTheirDrawingsWidth(modifier: String, placement: DrawingEmbed.Placement)
    throws
  {
    let editor = DrawingEditorHarness(
      text: "Intro\n![[Plan.excalidraw|200|\(modifier)]]\nAfter", drawings: Self.plan)
    let box = try #require(editor.box(line: 1))
    let left = editor.textView.textContainerOrigin.x
    let column = editor.controller.columnWidth
    #expect(box.width == 200)
    let expectedX = left + EmbedGeometry.x(for: placement, width: 200, columnWidth: column)
    #expect(abs(box.minX - expectedX) < 0.5)
    #expect(editor.textContainerHasNoExclusions)
  }

  @Test func sizeModifiersSetTheBox() throws {
    let editor = DrawingEditorHarness(
      text: "![[Plan.excalidraw|300x90]]\n![[Plan.excalidraw|50%|left]]\nAfter",
      drawings: Self.plan)
    let fixed = try #require(editor.box(line: 0))
    #expect(fixed.width == 300 && fixed.height == 90)
    let half = try #require(editor.box(line: 1))
    #expect(abs(half.width - (editor.controller.columnWidth / 2).rounded()) <= 1)
  }

  @Test func theCaretOnTheLineShowsTheSyntax() throws {
    let text = "Intro\n![[Plan.excalidraw]]\nAfter"
    let editor = DrawingEditorHarness(
      text: text, caret: (text as NSString).range(of: "Plan").location, drawings: Self.plan)
    #expect(editor.box(line: 1) == nil)
    #expect(editor.controller.renderedEmbeds(in: editor.textView.visibleRect).isEmpty)
    let embedLine = NSRange(location: editor.offset(of: "![["), length: 20)
    #expect(!editor.lineRects(of: embedLine).isEmpty)
    // Moving the caret away draws it.
    editor.controller.setSelection([NSRange(location: editor.offset(of: "After"), length: 0)])
    editor.layout()
    #expect(editor.box(line: 1) != nil)
  }

  @Test func sourceModeShowsTheSyntax() {
    let editor = DrawingEditorHarness(
      text: "Intro\n![[Plan.excalidraw|240|right-wrap]]\nAfter", drawings: Self.plan,
      configuration: EditorConfiguration(livePreview: false))
    #expect(editor.box(line: 1) == nil)
    #expect(editor.textContainerHasNoExclusions)
    #expect(!editor.lineRects(of: NSRange(location: editor.offset(of: "![["), length: 10)).isEmpty)
  }

  @Test func aHostWithoutDrawingsKeepsEmbedsAsText() {
    let editor = DrawingEditorHarness(text: "Intro\n![[Plan.excalidraw]]\nAfter")
    #expect(editor.box(line: 1) == nil)
    #expect(!editor.lineRects(of: NSRange(location: editor.offset(of: "![["), length: 10)).isEmpty)
  }

  @Test func aDrawingThatLoadsLaterTakesItsSize() throws {
    let editor = DrawingEditorHarness(
      text: "Intro\n![[Plan.excalidraw|300]]\nAfter",
      drawings: ["Plan.excalidraw": .loading])
    let loading = try #require(editor.box(line: 1))
    #expect(loading.height == EmbedGeometry.placeholderHeight)
    editor.delegate.drawings = Self.plan
    editor.controller.drawingsDidChange()
    editor.layout()
    let loaded = try #require(editor.box(line: 1))
    let natural = try #require(editor.controller.embeds.naturalSize(of: TestDrawings.drawing()))
    #expect(abs(loaded.height - (300 * natural.height / natural.width).rounded()) <= 1)
    let after = try #require(
      editor.lineRects(of: NSRange(location: editor.offset(of: "After"), length: 5)).first)
    #expect(after.minY >= loaded.maxY)
  }

  @Test func missingAndUnreadableDrawingsKeepAPlaceholder() throws {
    let editor = DrawingEditorHarness(
      text: "![[Gone.excalidraw|200]]\n![[Broken.excalidraw|200]]\nAfter",
      drawings: ["Gone.excalidraw": .missing, "Broken.excalidraw": .unreadable])
    #expect(try #require(editor.box(line: 0)).height == EmbedGeometry.placeholderHeight)
    #expect(try #require(editor.box(line: 1)).height == EmbedGeometry.placeholderHeight)
  }

  // MARK: Floats

  @Test func textWrapsAroundARightFloat() throws {
    let text = "![[Plan.excalidraw|240|right-wrap]]\n\(Self.long)\n\nEnd"
    let editor = DrawingEditorHarness(text: text, drawings: Self.plan)
    let box = try #require(editor.box(line: 0))
    let right = editor.textView.textContainerOrigin.x + editor.controller.columnWidth
    #expect(box.width == 240)
    #expect(abs(box.maxX - right) < 0.5)
    #expect(editor.controller.textContainer.exclusionPaths.count == 1)
    let rects = editor.lineRects(
      of: NSRange(location: editor.offset(of: "Text flows"), length: (Self.long as NSString).length)
    )
    let beside = rects.filter { $0.maxY > box.minY && $0.minY < box.maxY }
    #expect(beside.count >= 3)
    for rect in beside {
      #expect(rect.maxX <= box.minX - EmbedGeometry.floatGap + 0.5, "\(rect) runs into \(box)")
    }
    // Past the float, the text has the whole column again.
    #expect(rects.contains { $0.minY >= box.maxY && $0.maxX > box.minX })
    // The paragraph starts next to the float, at its top.
    #expect(abs(rects[0].minY - (box.minY - EmbedGeometry.floatTop)) < 1)
  }

  @Test func textWrapsAroundALeftFloat() throws {
    let text = "Intro\n![[Plan.excalidraw|200|left-wrap]]\n\(Self.long)"
    let editor = DrawingEditorHarness(text: text, caret: 0, drawings: Self.plan)
    let box = try #require(editor.box(line: 1))
    #expect(abs(box.minX - editor.textView.textContainerOrigin.x) < 0.5)
    let rects = editor.lineRects(
      of: NSRange(location: editor.offset(of: "Text flows"), length: 200))
    let beside = rects.filter { $0.maxY > box.minY && $0.minY < box.maxY }
    #expect(!beside.isEmpty)
    for rect in beside { #expect(rect.minX >= box.maxX + EmbedGeometry.floatGap - 0.5) }
  }

  @Test func typingNextToAFloatNeverOverlapsItOrMovesIt() throws {
    let text = "![[Plan.excalidraw|240|right-wrap]]\n\(Self.long)"
    let editor = DrawingEditorHarness(text: text, drawings: Self.plan)
    let box = try #require(editor.box(line: 0))
    let updates = editor.controller.embeds.exclusionUpdates
    editor.controller.setSelection([NSRange(location: editor.offset(of: "every word"), length: 0)])
    for character in "more words typed right here " {
      editor.type(String(character))
      for rect in editor.lineRects(of: NSRange(location: 36, length: 120)) {
        #expect(!rect.intersects(box.insetBy(dx: -EmbedGeometry.floatGap + 1, dy: 0)))
      }
    }
    #expect(editor.text.contains("Obsidian: more words typed right here every word"))
    #expect(editor.controller.embeds.exclusionUpdates == updates, "floats recomputed while typing")
    #expect(try #require(editor.box(line: 0)) == box)
  }

  @Test func aLineAddedAboveMovesTheFloatWithIt() throws {
    let text = "Intro\n![[Plan.excalidraw|240|right-wrap]]\n\(Self.long)"
    let editor = DrawingEditorHarness(text: text, caret: 5, drawings: Self.plan)
    let before = try #require(editor.box(line: 1))
    editor.type("\n")
    let after = try #require(editor.box(line: 2))
    #expect(after.minY > before.minY + 10)
    let rects = editor.lineRects(
      of: NSRange(location: editor.offset(of: "Text flows"), length: 120))
    for rect in rects where rect.maxY > after.minY && rect.minY < after.maxY {
      #expect(rect.maxX <= after.minX - EmbedGeometry.floatGap + 0.5)
    }
  }

  @Test func consecutiveFloatsStackWithoutOverlapping() throws {
    let text =
      "![[Plan.excalidraw|240|right-wrap]]\n![[Plan.excalidraw|200|right-wrap]]\n\(Self.long)"
    let editor = DrawingEditorHarness(text: text, drawings: Self.plan)
    let first = try #require(editor.box(line: 0))
    let second = try #require(editor.box(line: 1))
    #expect(!first.intersects(second))
    #expect(second.minY >= first.maxY)
    #expect(editor.controller.textContainer.exclusionPaths.count == 2)
  }

  @Test func aRowAfterAFloatGoesBelowIt() throws {
    let text = "![[Plan.excalidraw|300|right-wrap]]\nshort\n![[Plan.excalidraw|400]]\nEnd"
    let editor = DrawingEditorHarness(text: text, drawings: Self.plan)
    let float = try #require(editor.box(line: 0))
    let row = try #require(editor.box(line: 2))
    #expect(row.minY >= float.maxY)
  }

  @Test func geometryFollowsTheWebEditor() {
    let spec = DrawingEmbed(target: "P.excalidraw", placement: .rightWrap)
    let natural = CGSize(width: 500, height: 250)
    #expect(
      EmbedGeometry.size(for: spec, natural: natural, columnWidth: 700)
        == CGSize(width: 500, height: 250))
    #expect(
      EmbedGeometry.size(for: spec, natural: nil, columnWidth: 700)
        == CGSize(width: 360, height: 160))
    let full = DrawingEmbed(target: "P.excalidraw")
    #expect(
      EmbedGeometry.size(for: full, natural: natural, columnWidth: 700)
        == CGSize(width: 700, height: 350))
    let wide = DrawingEmbed(target: "P.excalidraw", width: 900, height: 300, placement: .left)
    #expect(
      EmbedGeometry.size(for: wide, natural: natural, columnWidth: 600)
        == CGSize(width: 600, height: 200))
    #expect(EmbedGeometry.x(for: .center, width: 200, columnWidth: 600) == 200)
    #expect(EmbedGeometry.x(for: .rightWrap, width: 200, columnWidth: 600) == 400)
  }
}

extension DrawingEditorHarness {
  var textContainerHasNoExclusions: Bool { controller.textContainer.exclusionPaths.isEmpty }
}
