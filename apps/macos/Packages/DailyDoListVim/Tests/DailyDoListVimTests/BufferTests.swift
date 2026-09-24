import Testing

@testable import DailyDoListVim

/// `VimTextBuffer`, the reference host: line bookkeeping, the fixed layout the vectors were
/// recorded in, scrolling and panels.
@MainActor
@Suite struct BufferTests {
  @Test func linesAndOffsets() throws {
    let t = VimTester("one\ntwo\nthree")
    #expect(t.buffer.vimLength == 13)
    #expect(t.buffer.vimLineStart(2) == 8)
    // An offset at a line break belongs to the line it ends.
    #expect(t.buffer.vimLineNumber(at: 3) == 0)
    #expect(t.buffer.vimLineNumber(at: 4) == 1)
    #expect(t.buffer.vimLineNumber(at: 13) == 2)
    try t.cm.replaceRange("A\nB\n", VimPosition(line: 1, ch: 0))
    #expect(t.buffer.lineCount == 5)
    #expect(t.buffer.vimLineStart(4) == 12)
    #expect(t.buffer.vimLine(3) == "two")
    try t.cm.replaceRange("", VimPosition(line: 0, ch: 1), VimPosition(line: 3, ch: 1))
    #expect(t.text == "owo\nthree")
    #expect(t.buffer.vimLineNumber(at: 4) == 1)
  }

  @Test func lineBreaksAreNormalized() {
    let buffer = VimTextBuffer("a\r\nb\rc")
    #expect(buffer.text == "a\nb\nc")
    #expect(buffer.lineCount == 3)
  }

  @Test func coordinatesFollowTheOracleLayout() throws {
    let t = VimTester("\tab\ncd")
    // Text boxes are 18 px tall, centered in 20 px lines; tabs advance to 4-column stops.
    let rect = try #require(t.buffer.vimCoords(at: 2, side: 1))
    #expect(rect.top == 1 && rect.bottom == 19)
    #expect(rect.left == 5 * t.buffer.charWidth)
    #expect(t.buffer.vimCoords(at: 5, side: 1)?.top == 21)
    // A point in the middle of a character resolves before it; past the middle, after it.
    let tab = 4 * t.buffer.charWidth
    #expect(t.buffer.vimOffset(at: VimPoint(x: tab / 2, y: 10)) == 0)
    #expect(t.buffer.vimOffset(at: VimPoint(x: tab / 2 + 0.01, y: 10)) == 1)
    #expect(t.buffer.vimOffset(at: VimPoint(x: 999, y: 30)) == 6)
  }

  @Test func scrollingKeepsTheCursorVisible() {
    let t = VimTester((0..<100).map { "line \($0)" }.joined(separator: "\n"))
    #expect(t.buffer.scrollTop == 0)
    t.cm.setCursor(30, 0)
    t.buffer.measure()
    // CodeMirror scrolls the text box just into view, 5 px from the edge.
    #expect(t.buffer.scrollTop == 30 * 20 + 19 - 400 + 5)
    #expect(t.buffer.firstVisibleLine == 11)
    t.cm.setCursor(2, 0)
    t.buffer.measure()
    #expect(t.buffer.scrollTop == 2 * 20 + 1 - 5)
    t.buffer.scroll(toLine: 1_000)
    #expect(t.buffer.scrollTop == 100 * 20 - 400)
  }

  @Test func shorterContentClampsTheScrollPosition() {
    let t = VimTester((0..<50).map { "line \($0)" }.joined(separator: "\n"))
    t.buffer.scroll(toLine: 30)
    t.keys("g", "g", "d", "G")
    #expect(t.buffer.scrollTop == 0)
  }

  @Test func panelsReachTheHost() {
    let t = VimTester("abc")
    t.keys(":")
    #expect(t.buffer.panel?.kind == .prompt)
    #expect(t.buffer.panel?.text == ":")
    t.keys("<Esc>")
    #expect(t.buffer.panel == nil)
    t.keys(":", "n", "o", "p", "e", "<CR>")
    #expect(t.buffer.panel?.kind == .message)
    #expect(t.buffer.notifications.last == "Not an editor command \":nope\"")
    t.keys("q", "a")
    #expect(t.buffer.panel?.kind == .status)
    #expect(t.buffer.panel?.text == "recording @a")
    t.keys("q")
    #expect(t.buffer.panel == nil)
  }

  @Test func longMessagesWaitForAKey() {
    let t = VimTester("abc")
    t.keys("y", "l", ":", "r", "e", "g", "<CR>")
    #expect(t.buffer.panel?.isLong == true)
    t.keys("<CR>")
    #expect(t.buffer.panel == nil)
    #expect(t.selection == [[0, 0]])
  }

  @Test func nativeEditsAreTypingInTheHistory() {
    let t = VimTester("")
    t.keys("i")
    for key in ["a", "b", "<CR>", "c"] { #expect(t.buffer.performNativeEdit(for: key)) }
    #expect(!t.buffer.performNativeEdit(for: "<Left>"))
    t.keys("<Esc>", "u")
    #expect(t.text == "")
  }

  @Test func readOnlyBuffersRejectEdits() {
    let t = VimTester("abc")
    t.buffer.isReadOnly = true
    t.keys("i")
    #expect(!t.buffer.performNativeEdit(for: "x"))
    #expect(t.text == "abc")
  }
}
