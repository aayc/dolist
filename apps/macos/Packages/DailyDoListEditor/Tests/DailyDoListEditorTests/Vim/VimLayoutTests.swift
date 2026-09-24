import AppKit
import DailyDoListVim
import Testing

@testable import DailyDoListEditor

/// Vim's pixel-based commands in the app's own theme (the vectors pin them in plain 20 pt
/// lines): headings are taller than body lines, long lines wrap, the text has padding.
@MainActor
@Suite("Vim layout")
struct VimLayoutTests {
  static let note = (0..<200).map { index -> String in
    switch index % 10 {
    case 0: "# Heading \(index)"
    case 3:
      "A long paragraph that wraps across several lines of the readable column: \(String(repeating: "word ", count: 40))end \(index)"
    case 6: ""
    default: "- [ ] Task \(index)"
    }
  }.joined(separator: "\n")

  private func line(_ editor: VimEditorHarness) -> Int {
    editor.host.vimLineNumber(at: editor.cursor)
  }

  @Test func jAndKMoveOneLineAtATimeWhateverTheLineHeights() {
    let editor = VimEditorHarness(
      Self.note, configuration: EditorConfiguration(livePreview: true, vimMode: true))
    for expected in 1...60 {
      editor.press("j")
      #expect(line(editor) == expected)
    }
    for expected in (40...59).reversed() {
      editor.press("k")
      #expect(line(editor) == expected)
    }
  }

  @Test func gjMovesThroughAWrappedLine() {
    let editor = VimEditorHarness(
      Self.note, configuration: EditorConfiguration(livePreview: true, vimMode: true))
    editor.press("3", "G")
    #expect(line(editor) == 2)
    editor.press("g", "j")
    #expect(line(editor) == 3)
    let start = editor.cursor
    editor.press("g", "j")
    #expect(line(editor) == 3)
    #expect(editor.cursor > start)
    editor.press("g", "k")
    #expect(editor.cursor == start)
  }

  @Test func screenLinesAndScrollingStayOnScreen() {
    let editor = VimEditorHarness(
      Self.note, configuration: EditorConfiguration(livePreview: true, vimMode: true))
    let visible = { () -> ClosedRange<Int> in
      let rect = editor.textView.visibleRect
      let origin = editor.textView.textContainerOrigin
      let glyphs = editor.controller.layoutManager.glyphRange(
        forBoundingRect: rect.offsetBy(dx: -origin.x, dy: -origin.y),
        in: editor.controller.textContainer)
      let characters = editor.controller.layoutManager.characterRange(
        forGlyphRange: glyphs, actualGlyphRange: nil)
      return editor.host.vimLineNumber(
        at: characters.location)...editor.host.vimLineNumber(
          at: max(characters.location, characters.end - 1))
    }
    editor.press("<C-d>")
    #expect(line(editor) > 5)
    #expect(visible().contains(line(editor)))
    editor.press("<C-d>", "<C-d>")
    #expect(visible().contains(line(editor)))
    editor.press("L")
    #expect(visible().contains(line(editor)))
    editor.press("H")
    #expect(visible().contains(line(editor)))
    editor.press("z", "z")
    #expect(visible().contains(line(editor)))
    editor.press("G")
    #expect(line(editor) == 199)
    #expect(visible().contains(199))
    editor.press("g", "g")
    #expect(visible().contains(0))
  }
}
