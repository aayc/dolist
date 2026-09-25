import DailyDoListDrawing
import Foundation
import Testing

@testable import DailyDoListEditor

/// The embed edits, ported from the web editor's `embeds/embeds.test.ts` (same cases, same
/// results).
@Suite("Embed edits: move, resize, remove, insert, drop targets")
struct EmbedEditTests {
  static func embed(_ text: String, line: Int) -> EmbedLine {
    let ns = text as NSString
    let index = LineIndex(ns)
    let content = index.contentRange(ofLine: line, textLength: ns.length)
    return EmbedLine(
      line: line, content: content, spec: DrawingEmbed.parse(line: ns.substring(with: content))!)
  }

  static func move(
    _ text: String, line: Int, before: Int, _ placement: DrawingEmbed.Placement, caret: Int = 0
  ) -> (text: String, lineStart: Int, caret: Int)? {
    let ns = text as NSString
    guard
      let result = EmbedEdits.move(
        embed(text, line: line), before: before, placement: placement, in: ns,
        lineIndex: LineIndex(ns), selection: [NSRange(location: caret, length: 0)])
    else { return nil }
    return (result.edit.applied(to: text), result.lineStart, result.edit.selection[0].location)
  }

  static let doc = "one\n![[a.excalidraw|360|right-wrap]]\ntwo\nthree"

  @Test func movesTheLineDownBeforeTheLineItsDroppedAbove() throws {
    let moved = try #require(Self.move(Self.doc, line: 1, before: 3, .rightWrap))
    #expect(moved.text == "one\ntwo\n![[a.excalidraw|360|right-wrap]]\nthree")
    #expect((moved.text as NSString).substring(from: moved.lineStart).hasPrefix("![[a.excalidraw"))
  }

  @Test func movesItUpAndToTheOtherSide() throws {
    let moved = try #require(Self.move(Self.doc, line: 1, before: 0, .leftWrap))
    #expect(moved.text == "![[a.excalidraw|360|left-wrap]]\none\ntwo\nthree")
    #expect(moved.lineStart == 0)
  }

  @Test func movesItAfterTheLastLineAndFromTheLastLine() throws {
    let end = try #require(Self.move(Self.doc, line: 1, before: 4, .rightWrap))
    #expect(end.text == "one\ntwo\nthree\n![[a.excalidraw|360|right-wrap]]")
    #expect(
      (end.text as NSString).substring(from: end.lineStart) == "![[a.excalidraw|360|right-wrap]]")
    let back = try #require(Self.move(end.text, line: 3, before: 1, .rightWrap))
    #expect(back.text == Self.doc)
  }

  @Test func droppedNextToItsOwnLineOnlyChangesThePlacement() throws {
    #expect(Self.move(Self.doc, line: 1, before: 1, .rightWrap) == nil)
    #expect(Self.move(Self.doc, line: 1, before: 2, .rightWrap) == nil)
    let moved = try #require(Self.move(Self.doc, line: 1, before: 2, .leftWrap))
    #expect(moved.text == "one\n![[a.excalidraw|360|left-wrap]]\ntwo\nthree")
  }

  @Test func fullWidthDropsTheSizeAndKeepsAStyleThatIsntAPlacement() throws {
    let full = try #require(
      Self.move("![[a.excalidraw|360x200|right-wrap]]\nx", line: 0, before: 1, .full))
    #expect(full.text == "![[a.excalidraw]]\nx")
    let styled = try #require(Self.move("![[a.excalidraw|360|dark]]\nx", line: 0, before: 2, .full))
    #expect(styled.text == "x\n![[a.excalidraw|dark]]")
  }

  @Test func keepsTheCaretOnTheTextItWasOn() throws {
    let caret = (Self.doc as NSString).range(of: "three").location + 2
    let moved = try #require(Self.move(Self.doc, line: 1, before: 0, .leftWrap, caret: caret))
    #expect(
      (moved.text as NSString).substring(with: NSRange(location: moved.caret - 2, length: 5))
        == "three")
  }

  @Test func resizeSetsTheWidthKeepingThePlacementAndScalingAGivenHeight() throws {
    func resize(_ text: String, _ width: CGFloat) -> String? {
      EmbedEdits.resize(
        Self.embed(text, line: 0), width: width, in: text as NSString, selection: []
      )
      .map { $0.edit.applied(to: text) }
    }
    #expect(resize("![[a.excalidraw|360|right-wrap]]", 280.4) == "![[a.excalidraw|280|right-wrap]]")
    #expect(resize("![[a.excalidraw|300x200|left]]", 450) == "![[a.excalidraw|450x300|left]]")
    #expect(resize("![[a.excalidraw|360|right-wrap]]", 360) == nil)
    #expect(resize("![[a.excalidraw|50%]]", 2) == "![[a.excalidraw|48]]")
  }

  @Test func removesTheEmbedsLineWithOneLineBreakWhereverItIs() {
    func remove(_ text: String, line: Int) -> String {
      EmbedEdits.remove(Self.embed(text, line: line), in: text as NSString, selection: []).applied(
        to: text)
    }
    #expect(remove("a\n![[x.excalidraw]]\nb", line: 1) == "a\nb")
    #expect(remove("a\n![[x.excalidraw]]", line: 1) == "a")
    #expect(remove("![[x.excalidraw]]", line: 0) == "")
  }

  @Test func insertGoesAboveALineWithTextAndTakesABlankLine() {
    func insert(_ text: String, caret: Int) -> (text: String, lineStart: Int, caret: Int) {
      let result = EmbedEdits.insert(
        "![[a.excalidraw|360|right-wrap]]", in: text as NSString, caret: caret,
        selection: [NSRange(location: caret, length: 0)])
      return (result.edit.applied(to: text), result.lineStart, result.edit.selection[0].location)
    }
    let above = insert("first\nsecond line", caret: 9)
    #expect(above.text == "first\n![[a.excalidraw|360|right-wrap]]\nsecond line")
    #expect(above.lineStart == 6)
    #expect(
      TextLines(above.text as NSString).string(
        TextLines(above.text as NSString).line(containing: above.caret)) == "second line")
    let atStart = insert("first\nsecond", caret: 6)
    #expect(
      TextLines(atStart.text as NSString).string(
        TextLines(atStart.text as NSString).line(containing: atStart.caret)) == "second")
    let blank = insert("first\n\nlast", caret: 6)
    #expect(blank.text == "first\n![[a.excalidraw|360|right-wrap]]\n\nlast")
    #expect(LineIndex(blank.text as NSString).line(containing: blank.caret) == 2)
  }

  @Test func dropTargetsGoBetweenLinesAndFloatInTheOuterThirds() {
    let lineAt = { (y: CGFloat) -> EmbedEdits.LineBox in
      let index = min(max(Int((y / 20).rounded(.down)), 0), 9)
      return EmbedEdits.LineBox(
        index: index, top: CGFloat(index) * 20, bottom: CGFloat(index) * 20 + 20)
    }
    func target(_ x: CGFloat, _ y: CGFloat) -> EmbedDropTarget {
      EmbedEdits.dropTarget(
        at: CGPoint(x: x, y: y), lineAt: lineAt, lineCount: 10, left: 100, right: 700)
    }
    #expect(target(400, 45) == EmbedDropTarget(before: 2, placement: .full, y: 40))
    #expect(target(400, 55).before == 3 && target(400, 55).y == 60)
    #expect(target(150, 5).placement == .leftWrap)
    #expect(target(299, 5).placement == .leftWrap)
    #expect(target(301, 5).placement == .full)
    #expect(target(650, 5).placement == .rightWrap)
    #expect(target(400, -50).before == 0)
    #expect(target(400, 5000).before == 10)
  }
}
