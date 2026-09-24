// Undo grouping, multiple selections, replace mode, marks through edits, multiline search, ex ranges and their errors, and <C-a> on big numbers. The expected states were recorded from the vectors' Chromium oracle (@replit/codemirror-vim 6.4.0 on CodeMirror 6).

import Testing

@testable import DailyDoListVim

@MainActor
@Suite struct EditorBehaviorTests {
  @Test("undo-cw-undoes-typing-only")
  func undoCwUndoesTypingOnly() {
    let t = VimTester(VimText("one two"), cursor: (0, 0))
    t.keys("c", "w", "X", "Y", "<Esc>")
    t.expect(doc: VimText("XY two"), selection: [[0, 1]], mode: .normal)
    #expect(t.register("\"")?.text == VimText("one"))
    #expect(t.register("-")?.text == VimText("one"))
    #expect(t.register(".")?.text == VimText("XY"))
    t.keys("u")
    t.expect(doc: VimText(" two"), selection: [[0, 0]], mode: .normal)
    #expect(t.register("\"")?.text == VimText("one"))
    #expect(t.register("-")?.text == VimText("one"))
    #expect(t.register(".")?.text == VimText("XY"))
    t.keys("u")
    t.expect(doc: VimText("one two"), selection: [[0, 0]], mode: .normal)
    #expect(t.register("\"")?.text == VimText("one"))
    #expect(t.register("-")?.text == VimText("one"))
    #expect(t.register(".")?.text == VimText("XY"))
  }

  @Test("undo-insert-with-cursor-move")
  func undoInsertWithCursorMove() {
    let t = VimTester(VimText("abc"), cursor: (0, 0))
    t.keys("i", "x", "<Right>", "y", "<Esc>")
    t.expect(doc: VimText("xyabc"), selection: [[0, 1]], mode: .normal)
    #expect(t.register(".")?.text == VimText("xy"))
    t.keys("u")
    t.expect(doc: VimText("abc"), selection: [[0, 0]], mode: .normal)
    #expect(t.register(".")?.text == VimText("xy"))
  }

  @Test("undo-dd-then-p")
  func undoDdThenP() {
    let t = VimTester(VimText("a\nb\nc"), cursor: (0, 0))
    t.keys("d", "d", "p")
    t.expect(doc: VimText("b\na\nc"), selection: [[1, 0]], mode: .normal)
    #expect(t.register("\"")?.text == VimText("a\n"))
    t.keys("u")
    t.expect(doc: VimText("b\nc"), selection: [[0, 0]], mode: .normal)
    #expect(t.register("\"")?.text == VimText("a\n"))
    t.keys("u")
    t.expect(doc: VimText("a\nb\nc"), selection: [[0, 0]], mode: .normal)
    #expect(t.register("\"")?.text == VimText("a\n"))
    t.keys("<C-r>")
    t.expect(doc: VimText("b\nc"), selection: [[0, 0]], mode: .normal)
    #expect(t.register("\"")?.text == VimText("a\n"))
  }

  @Test("undo-counted-insert")
  func undoCountedInsert() {
    let t = VimTester(VimText(""), cursor: (0, 0))
    t.keys("3", "i", "a", "b", "<Esc>")
    t.expect(doc: VimText("ababab"), selection: [[0, 5]], mode: .normal)
    #expect(t.register(".")?.text == VimText("ab"))
    t.keys("u")
    t.expect(doc: VimText(""), selection: [[0, 0]], mode: .normal)
    #expect(t.register(".")?.text == VimText("ab"))
  }

  @Test("undo-o-with-typing")
  func undoOWithTyping() {
    let t = VimTester(VimText("x"), cursor: (0, 0))
    t.keys("o", "y", "<BS>", "z", "<Esc>")
    t.expect(doc: VimText("x\nz"), selection: [[1, 0]], mode: .normal)
    #expect(t.register(".")?.text == VimText("y[object Object]z"))
    t.keys("u")
    t.expect(doc: VimText("x\n"), selection: [[1, 0]], mode: .normal)
    #expect(t.register(".")?.text == VimText("y[object Object]z"))
  }

  @Test("undo-dot-repeat")
  func undoDotRepeat() {
    let t = VimTester(VimText("a b c"), cursor: (0, 0))
    t.keys("d", "w", ".")
    t.expect(doc: VimText("c"), selection: [[0, 0]], mode: .normal)
    #expect(t.register("\"")?.text == VimText("b "))
    #expect(t.register("-")?.text == VimText("b "))
    t.keys("u")
    t.expect(doc: VimText("b c"), selection: [[0, 0]], mode: .normal)
    #expect(t.register("\"")?.text == VimText("b "))
    #expect(t.register("-")?.text == VimText("b "))
    t.keys("u")
    t.expect(doc: VimText("a b c"), selection: [[0, 0]], mode: .normal)
    #expect(t.register("\"")?.text == VimText("b "))
    #expect(t.register("-")?.text == VimText("b "))
  }

  @Test("undo-visual-block-insert")
  func undoVisualBlockInsert() {
    let t = VimTester(VimText("ab\ncd\nef"), cursor: (0, 0))
    t.keys("<C-v>", "j", "j", "I", "-", "<Esc>")
    t.expect(doc: VimText("-ab\n-cd\n-ef"), selection: [[0, 0]], mode: .normal)
    #expect(t.register(".")?.text == VimText("-"))
    t.keys("u")
    t.expect(doc: VimText("ab\ncd\nef"), selection: [[0, 0]], mode: .normal)
    #expect(t.register(".")?.text == VimText("-"))
  }

  @Test("undo-join-and-replace")
  func undoJoinAndReplace() {
    let t = VimTester(VimText("a\nb"), cursor: (0, 0))
    t.keys("J", "r", "X")
    t.expect(doc: VimText("aXb"), selection: [[0, 1]], mode: .normal)
    t.keys("u")
    t.expect(doc: VimText("a b"), selection: [[0, 1]], mode: .normal)
    t.keys("u")
    t.expect(doc: VimText("a\nb"), selection: [[0, 0]], mode: .normal)
  }

  @Test("undo-redo-substitute")
  func undoRedoSubstitute() {
    let t = VimTester(VimText("aa\naa"), cursor: (0, 0))
    t.session.lastMessage = nil
    t.keys(":", "%", "s", "/", "a", "/", "b", "/", "g", "<CR>")
    t.expect(doc: VimText("bb\nbb"), selection: [[1, 1]], mode: .normal)
    #expect(t.session.lastMessage == "Found 4 matches for pattern: /a/im (set nopcre to use Vim regexps)")
    #expect(t.register("/")?.text == VimText("a/g"))
    t.keys("u")
    t.expect(doc: VimText("aa\naa"), selection: [[0, 0]], mode: .normal)
    #expect(t.register("/")?.text == VimText("a/g"))
    t.keys("<C-r>")
    t.expect(doc: VimText("bb\nbb"), selection: [[0, 0]], mode: .normal)
    #expect(t.register("/")?.text == VimText("a/g"))
  }

  @Test("multi-selection-insert")
  func multiSelectionInsert() {
    let t = VimTester(VimText("ab\ncd"), cursor: (0, 1))
    t.keys("<C-v>", "j", "c", "X", "<Esc>")
    t.expect(doc: VimText("aX\ncX"), selection: [[0, 1]], mode: .normal)
    #expect(t.register("\"")?.text == VimText("b\nd"))
    #expect(t.register(".")?.text == VimText("X"))
  }

  @Test("multi-selection-A")
  func multiSelectionA() {
    let t = VimTester(VimText("ab\ncdef\ng"), cursor: (0, 0))
    t.keys("<C-v>", "j", "j", "$", "A", "!", "<Esc>")
    t.expect(doc: VimText("ab!\ncdef!\ng!"), selection: [[0, 2]], mode: .normal)
    #expect(t.register(".")?.text == VimText("!"))
  }

  @Test("multi-selection-yank-block-put")
  func multiSelectionYankBlockPut() {
    let t = VimTester(VimText("abc\ndef"), cursor: (0, 0))
    t.session.lastMessage = nil
    t.keys("<C-v>", "j", "l", "y")
    t.expect(doc: VimText("abc\ndef"), selection: [[0, 0]], mode: .normal)
    #expect(t.session.lastMessage == "1 lines yanked")
    #expect(t.register("\"")?.text == VimText("ab\nde"))
    #expect(t.register("0")?.text == VimText("ab\nde"))
    t.keys("$", "p")
    t.expect(doc: VimText("abcab\ndefde"), selection: [[0, 3]], mode: .normal)
    #expect(t.register("\"")?.text == VimText("ab\nde"))
    #expect(t.register("0")?.text == VimText("ab\nde"))
  }

  @Test("multi-selection-dot")
  func multiSelectionDot() {
    let t = VimTester(VimText("abc\ndef\nghi"), cursor: (0, 0))
    t.keys("<C-v>", "j", "I", "#", "<Esc>")
    t.expect(doc: VimText("#abc\n#def\nghi"), selection: [[0, 0]], mode: .normal)
    #expect(t.register(".")?.text == VimText("#"))
    t.keys("j", "j", ".")
    t.expect(doc: VimText("#abc\n#def\n#ghi#"), selection: [[2, 0]], mode: .normal)
    #expect(t.register(".")?.text == VimText("#"))
  }

  @Test("replace-mode-overwrite-and-bs")
  func replaceModeOverwriteAndBs() {
    let t = VimTester(VimText("abcd"), cursor: (0, 1))
    t.keys("R", "x", "y")
    t.expect(doc: VimText("axyd"), selection: [[0, 3]], mode: .replace)
    t.keys("<BS>")
    t.expect(doc: VimText("axyd"), selection: [[0, 2]], mode: .replace)
    t.keys("z", "w", "q", "<Esc>")
    t.expect(doc: VimText("axzwq"), selection: [[0, 4]], mode: .normal)
    #expect(t.register(".")?.text == VimText("q"))
  }

  @Test("replace-mode-line-end-and-newline")
  func replaceModeLineEndAndNewline() {
    let t = VimTester(VimText("ab\ncd"), cursor: (0, 1))
    t.keys("R", "x", "y", "z", "<CR>", "w", "<Esc>")
    t.expect(doc: VimText("axyz\nw\ncd"), selection: [[1, 0]], mode: .normal)
    #expect(t.register(".")?.text == VimText("w"))
    t.keys("u")
    t.expect(doc: VimText("ab\ncd"), selection: [[0, 1]], mode: .normal)
    #expect(t.register(".")?.text == VimText("w"))
  }

  @Test("replace-mode-count")
  func replaceModeCount() {
    let t = VimTester(VimText("abcdef"), cursor: (0, 0))
    t.keys("2", "R", "x", "y", "<Esc>")
    t.expect(doc: VimText("xyydef"), selection: [[0, 2]], mode: .normal)
    #expect(t.register(".")?.text == VimText("y"))
  }

  @Test("mark-follows-edits")
  func markFollowsEdits() {
    let t = VimTester(VimText("one\ntwo\nthree"), cursor: (2, 2))
    t.keys("m", "a", "g", "g", "O", "new", "<Esc>")
    t.expect(doc: VimText("new\none\ntwo\nthree"), selection: [[0, 2]], mode: .normal)
    #expect(t.register(".")?.text == VimText("new"))
    t.keys("`", "a")
    t.expect(doc: VimText("new\none\ntwo\nthree"), selection: [[3, 2]], mode: .normal)
    #expect(t.register(".")?.text == VimText("new"))
    t.keys("g", "g", "d", "d", "'", "a")
    t.expect(doc: VimText("one\ntwo\nthree"), selection: [[2, 0]], mode: .normal)
    #expect(t.register("\"")?.text == VimText("new\n"))
    #expect(t.register(".")?.text == VimText("new"))
  }

  @Test("mark-deleted-line")
  func markDeletedLine() {
    let t = VimTester(VimText("a\nb\nc"), cursor: (1, 0))
    t.keys("m", "a", "d", "d", "g", "g")
    t.expect(doc: VimText("a\nc"), selection: [[0, 0]], mode: .normal)
    #expect(t.register("\"")?.text == VimText("b\n"))
    t.keys("'", "a")
    t.expect(doc: VimText("a\nc"), selection: [[1, 0]], mode: .normal)
    #expect(t.register("\"")?.text == VimText("b\n"))
  }

  @Test("search-multiline")
  func searchMultiline() {
    let t = VimTester(VimText("ab\ncd\nab\nce"), cursor: (0, 0))
    t.keys("/", "b", "\\", "n", "c", "<CR>")
    t.expect(doc: VimText("ab\ncd\nab\nce"), selection: [[0, 1]], mode: .normal)
    #expect(t.register("/")?.text == VimText("b\\nc"))
    t.keys("n")
    t.expect(doc: VimText("ab\ncd\nab\nce"), selection: [[2, 1]], mode: .normal)
    #expect(t.register("/")?.text == VimText("b\\nc"))
    t.keys("n")
    t.expect(doc: VimText("ab\ncd\nab\nce"), selection: [[0, 1]], mode: .normal)
    #expect(t.register("/")?.text == VimText("b\\nc"))
  }

  @Test("search-whitespace-spans-lines")
  func searchWhitespaceSpansLines() {
    let t = VimTester(VimText("x y\nz  w"), cursor: (0, 0))
    t.session.lastMessage = nil
    t.keys("/", "y", "\\", "s", "\\", "+", "z", "<CR>")
    t.expect(doc: VimText("x y\nz  w"), selection: [[0, 0]], mode: .normal)
    #expect(t.session.lastMessage == "No match found /y\\s\\+z/im (set nopcre to use Vim regexps)")
    #expect(t.register("/")?.text == VimText("y\\s\\+z"))
  }

  @Test("search-backward-wraps")
  func searchBackwardWraps() {
    let t = VimTester(VimText("foo bar\nbaz foo"), cursor: (0, 4))
    t.keys("?", "f", "o", "o", "<CR>")
    t.expect(doc: VimText("foo bar\nbaz foo"), selection: [[0, 0]], mode: .normal)
    #expect(t.register("/")?.text == VimText("foo"))
    t.keys("n")
    t.expect(doc: VimText("foo bar\nbaz foo"), selection: [[1, 4]], mode: .normal)
    #expect(t.register("/")?.text == VimText("foo"))
    t.keys("N")
    t.expect(doc: VimText("foo bar\nbaz foo"), selection: [[0, 0]], mode: .normal)
    #expect(t.register("/")?.text == VimText("foo"))
  }

  @Test("search-offset-and-count")
  func searchOffsetAndCount() {
    let t = VimTester(VimText("a1 a2 a3 a4"), cursor: (0, 0))
    t.keys("2", "/", "a", "<CR>")
    t.expect(doc: VimText("a1 a2 a3 a4"), selection: [[0, 6]], mode: .normal)
    #expect(t.register("/")?.text == VimText("a"))
    t.keys("N")
    t.expect(doc: VimText("a1 a2 a3 a4"), selection: [[0, 3]], mode: .normal)
    #expect(t.register("/")?.text == VimText("a"))
  }

  @Test("ex-range-delete")
  func exRangeDelete() {
    let t = VimTester(VimText("1\n2\n3\n4\n5"), cursor: (0, 0))
    t.keys(":", "2", ",", "4", "d", "<CR>")
    t.expect(doc: VimText("1\n5"), selection: [[0, 0]], mode: .normal)
    #expect(t.register("\"")?.text == VimText("2\n3\n4\n"))
  }

  @Test("ex-range-relative-yank-put")
  func exRangeRelativeYankPut() {
    let t = VimTester(VimText("a\nb\nc\nd"), cursor: (1, 0))
    t.session.lastMessage = nil
    t.keys(":", ".", ",", "+", "1", "y", "<CR>")
    t.expect(doc: VimText("a\nb\nc\nd"), selection: [[1, 0]], mode: .normal)
    #expect(t.session.lastMessage == "2 lines yanked into \"0")
    #expect(t.register("\"")?.text == VimText("b\nc\n"))
    #expect(t.register("0")?.text == VimText("b\nc\n"))
    t.keys(":", "$", "p", "u", "<CR>")
    t.expect(doc: VimText("a\nb\nc\nd\nb\nc"), selection: [[4, 0]], mode: .normal)
    #expect(t.register("\"")?.text == VimText("b\nc\n"))
    #expect(t.register("0")?.text == VimText("b\nc\n"))
  }

  @Test("ex-range-marks-substitute")
  func exRangeMarksSubstitute() {
    let t = VimTester(VimText("x\nx\nx\nx"), cursor: (1, 0))
    t.keys("m", "a", "j", "m", "b")
    t.expect(doc: VimText("x\nx\nx\nx"), selection: [[2, 0]], mode: .normal)
    t.session.lastMessage = nil
    t.keys(":", "'", "a", ",", "'", "b", "s", "/", "x", "/", "y", "/", "<CR>")
    t.expect(doc: VimText("x\ny\ny\nx"), selection: [[2, 0]], mode: .normal)
    #expect(t.session.lastMessage == "Found 3 matches for pattern: /x/im (set nopcre to use Vim regexps)")
    #expect(t.register("/")?.text == VimText("x"))
  }

  @Test("ex-range-pattern")
  func exRangePattern() {
    let t = VimTester(VimText("a\nfoo\nb\nfoo"), cursor: (0, 0))
    t.keys(":", "/", "f", "o", "o", "/", "d", "<CR>")
    t.expect(doc: VimText("a\nb\nfoo"), selection: [[0, 0]], mode: .normal)
    #expect(t.register("\"")?.text == VimText("foo\n"))
  }

  @Test("ex-global-and-vglobal")
  func exGlobalAndVglobal() {
    let t = VimTester(VimText("a1\nb2\na3\nb4"), cursor: (0, 0))
    t.keys(":", "g", "/", "a", "/", "d", "<CR>")
    t.expect(doc: VimText("b2\nb4"), selection: [[0, 0]], mode: .normal)
    #expect(t.register("\"")?.text == VimText("a3\n"))
    #expect(t.register("/")?.text == VimText("a"))
    t.keys("u")
    t.expect(doc: VimText("a1\nb2\na3\nb4"), selection: [[0, 0]], mode: .normal)
    #expect(t.register("\"")?.text == VimText("a3\n"))
    #expect(t.register("/")?.text == VimText("a"))
    t.keys(":", "v", "/", "a", "/", "d", "<CR>")
    t.expect(doc: VimText("a1\na3"), selection: [[0, 0]], mode: .normal)
    #expect(t.register("\"")?.text == VimText("\nb4\n"))
    #expect(t.register("/")?.text == VimText("a"))
  }

  @Test("ex-sort-numeric-reverse")
  func exSortNumericReverse() {
    let t = VimTester(VimText("x10\nx9\nx100\nx2"), cursor: (0, 0))
    t.keys(":", "s", "o", "r", "t", "!", " ", "n", "<CR>")
    t.expect(doc: VimText("x100\nx10\nx9\nx2"), selection: [[0, 0]], mode: .normal)
  }

  @Test("ex-normal-on-range")
  func exNormalOnRange() {
    let t = VimTester(VimText("a\nb\nc"), cursor: (0, 0))
    t.keys(":", "%", "n", "o", "r", "m", " ", "A", ";", "<CR>")
    t.expect(doc: VimText("a;\nb;\nc;"), selection: [[2, 2]], mode: .normal)
  }

  @Test("ex-substitute-count-and-flags")
  func exSubstituteCountAndFlags() {
    let t = VimTester(VimText("aaa\naaa\naaa"), cursor: (0, 0))
    t.session.lastMessage = nil
    t.keys(":", "s", "/", "a", "/", "b", "/", "g", " ", "2", "<CR>")
    t.expect(doc: VimText("bbb\nbbb\naaa"), selection: [[1, 2]], mode: .normal)
    #expect(t.session.lastMessage == "Found 7 matches for pattern: /a/im (set nopcre to use Vim regexps)")
    #expect(t.register("/")?.text == VimText("a/g"))
  }

  @Test("ex-bad-range-message")
  func exBadRangeMessage() {
    let t = VimTester(VimText("a"), cursor: (0, 0))
    t.keys(":", "5", "d", "<CR>")
    t.expect(doc: VimText("a"), selection: [[0, 0]], mode: .normal)
    #expect(t.register("\"")?.text == VimText("\n"))
  }

  @Test("ex-unknown-command-message")
  func exUnknownCommandMessage() {
    let t = VimTester(VimText("a"), cursor: (0, 0))
    t.session.lastMessage = nil
    t.keys(":", "f", "r", "o", "b", "<CR>")
    t.expect(doc: VimText("a"), selection: [[0, 0]], mode: .normal)
    #expect(t.session.lastMessage == "Not an editor command \":frob\"")
  }

  @Test("undo-typing-group-broken-by-cursor-move")
  func undoTypingGroupBrokenByCursorMove() {
    let t = VimTester(VimText(""), cursor: (0, 0))
    t.keys("i", "a", "b")
    t.expect(doc: VimText("ab"), selection: [[0, 2]], mode: .insert)
    t.buffer.setCursor(line: 0, ch: 0)
    t.expect(doc: VimText("ab"), selection: [[0, 0]], mode: .insert)
    t.keys("c", "d", "<Esc>")
    t.expect(doc: VimText("cdab"), selection: [[0, 1]], mode: .normal)
    #expect(t.register(".")?.text == VimText("cd"))
    t.keys("u")
    t.expect(doc: VimText("ab"), selection: [[0, 0]], mode: .normal)
    #expect(t.register(".")?.text == VimText("cd"))
    t.keys("u")
    t.expect(doc: VimText(""), selection: [[0, 0]], mode: .normal)
    #expect(t.register(".")?.text == VimText("cd"))
  }

  @Test("undo-typing-with-backspace")
  func undoTypingWithBackspace() {
    let t = VimTester(VimText(""), cursor: (0, 0))
    t.keys("i", "a", "b", "<BS>", "c", "<Esc>")
    t.expect(doc: VimText("ac"), selection: [[0, 1]], mode: .normal)
    #expect(t.register(".")?.text == VimText("ab[object Object]c"))
    t.keys("u")
    t.expect(doc: VimText(""), selection: [[0, 0]], mode: .normal)
    #expect(t.register(".")?.text == VimText("ab[object Object]c"))
  }

  @Test("ex-unset-mark")
  func exUnsetMark() {
    let t = VimTester(VimText("a\nb"), cursor: (0, 0))
    t.session.lastMessage = nil
    t.keys(":", "'", "z", "d", "<CR>")
    t.expect(doc: VimText("a\nb"), selection: [[0, 0]], mode: .normal)
    #expect(t.session.lastMessage == "Error: Mark not set")
  }

  @Test("ex-reversed-range")
  func exReversedRange() {
    let t = VimTester(VimText("1\n2\n3\n4\n5"), cursor: (0, 0))
    t.session.lastMessage = nil
    t.keys(":", "4", ",", "2", "d", "<CR>")
    t.expect(doc: VimText("1\n2\n3\n4\n5"), selection: [[0, 0]], mode: .normal)
    #expect(t.session.lastMessage == "RangeError: Invalid change range 6 to 4 (in doc of length 9)")
    #expect(t.session.activePrompt?.text == ":")
    #expect(t.session.activePrompt?.value == VimText("4,2d"))
  }

  @Test("ex-range-beyond-end")
  func exRangeBeyondEnd() {
    let t = VimTester(VimText("1\n2\n3"), cursor: (0, 0))
    t.keys(":", "$", "+", "5", "d", "<CR>")
    t.expect(doc: VimText("1\n2\n3"), selection: [[0, 0]], mode: .normal)
    #expect(t.register("\"")?.text == VimText("\n"))
  }

  @Test("ex-pattern-no-match")
  func exPatternNoMatch() {
    let t = VimTester(VimText("a\nb"), cursor: (0, 0))
    t.session.lastMessage = nil
    t.keys(":", "/", "z", "z", "/", "d", "<CR>")
    t.expect(doc: VimText("a\nb"), selection: [[0, 0]], mode: .normal)
    #expect(t.session.lastMessage == "Error: Pattern not found/zz/")
  }

  @Test("ex-last-search-range")
  func exLastSearchRange() {
    let t = VimTester(VimText("x\nfoo\ny\nfoo"), cursor: (0, 0))
    t.keys("/", "f", "o", "o", "<CR>")
    t.expect(doc: VimText("x\nfoo\ny\nfoo"), selection: [[1, 0]], mode: .normal)
    #expect(t.register("/")?.text == VimText("foo"))
    t.session.lastMessage = nil
    t.keys(":", "\\", "/", "d", "<CR>")
    t.expect(doc: VimText("x\nfoo\ny\nfoo"), selection: [[1, 0]], mode: .normal)
    #expect(t.session.lastMessage == "Not an editor command \":\\/d\"")
    #expect(t.register("/")?.text == VimText("foo"))
  }

  @Test("ex-registers-long-message")
  func exRegistersLongMessage() {
    let t = VimTester(VimText("abc"), cursor: (0, 0))
    t.session.lastMessage = nil
    t.keys("y", "w")
    t.expect(doc: VimText("abc"), selection: [[0, 0]], mode: .normal)
    #expect(t.session.lastMessage == "1 lines yanked")
    #expect(t.register("\"")?.text == VimText("abc"))
    #expect(t.register("0")?.text == VimText("abc"))
    t.session.lastMessage = nil
    t.keys(":", "r", "e", "g", "<CR>")
    t.expect(doc: VimText("abc"), selection: [[0, 0]], mode: .normal)
    #expect(t.session.lastMessage == "----------Registers----------\n\n\"0    abc\n\"\"    abc\n")
    #expect(t.register("\"")?.text == VimText("abc"))
    #expect(t.register("0")?.text == VimText("abc"))
    t.keys("<CR>")
    t.expect(doc: VimText("abc"), selection: [[0, 0]], mode: .normal)
    #expect(t.register("\"")?.text == VimText("abc"))
    #expect(t.register("0")?.text == VimText("abc"))
  }

  @Test("increment-big-number")
  func incrementBigNumber() {
    let t = VimTester(VimText("99999999999999999999"), cursor: (0, 0))
    t.keys("<C-a>")
    t.expect(doc: VimText("100000000000000000000"), selection: [[0, 20]], mode: .normal)
  }

  @Test("increment-hex-and-binary")
  func incrementHexAndBinary() {
    let t = VimTester(VimText("0xff 0b101 -7"), cursor: (0, 0))
    t.keys("<C-a>")
    t.expect(doc: VimText("0x100 0b101 -7"), selection: [[0, 4]], mode: .normal)
    t.keys("w", "<C-a>")
    t.expect(doc: VimText("0x100 0b110 -7"), selection: [[0, 10]], mode: .normal)
    t.keys("w", "w", "5", "<C-a>")
    t.expect(doc: VimText("0x100 0b110 -2"), selection: [[0, 13]], mode: .normal)
  }
}
