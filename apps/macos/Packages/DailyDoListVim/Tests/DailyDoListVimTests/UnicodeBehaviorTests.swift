// Unicode behavior: UTF-16 columns across emoji, combining marks, CJK and case mapping. The expected states were recorded from the vectors' Chromium oracle (@replit/codemirror-vim 6.4.0 on CodeMirror 6).

import Testing

@testable import DailyDoListVim

@MainActor
@Suite struct UnicodeBehaviorTests {
  @Test("x-on-emoji")
  func xOnEmoji() {
    let t = VimTester(VimText("😀a"), cursor: (0, 0))
    t.keys("x")
    t.expect(doc: VimText("a"), selection: [[0, 0]], mode: .normal)
    #expect(t.register("\"")?.text == VimText("😀"))
    #expect(t.register("-")?.text == VimText("😀"))
    t.keys("x")
    t.expect(doc: VimText(""), selection: [[0, 0]], mode: .normal)
    #expect(t.register("\"")?.text == VimText("a"))
    #expect(t.register("-")?.text == VimText("a"))
  }

  @Test("l-over-emoji")
  func lOverEmoji() {
    let t = VimTester(VimText("a😀b"), cursor: (0, 0))
    t.keys("l")
    t.expect(doc: VimText("a😀b"), selection: [[0, 1]], mode: .normal)
    t.keys("l")
    t.expect(doc: VimText("a😀b"), selection: [[0, 3]], mode: .normal)
    t.keys("h")
    t.expect(doc: VimText("a😀b"), selection: [[0, 1]], mode: .normal)
  }

  @Test("l-over-combining")
  func lOverCombining() {
    let t = VimTester(VimText("e\u{301}x"), cursor: (0, 0))
    t.keys("l")
    t.expect(doc: VimText("e\u{301}x"), selection: [[0, 1]], mode: .normal)
    t.keys("x")
    t.expect(doc: VimText("ex"), selection: [[0, 1]], mode: .normal)
    #expect(t.register("\"")?.text == VimText("\u{301}"))
    #expect(t.register("-")?.text == VimText("\u{301}"))
  }

  @Test("w-cjk")
  func wCjk() {
    let t = VimTester(VimText("日本語 テキスト 漢字x"), cursor: (0, 0))
    t.keys("w")
    t.expect(doc: VimText("日本語 テキスト 漢字x"), selection: [[0, 4]], mode: .normal)
    t.keys("e")
    t.expect(doc: VimText("日本語 テキスト 漢字x"), selection: [[0, 7]], mode: .normal)
    t.keys("w")
    t.expect(doc: VimText("日本語 テキスト 漢字x"), selection: [[0, 9]], mode: .normal)
    t.keys("b")
    t.expect(doc: VimText("日本語 テキスト 漢字x"), selection: [[0, 4]], mode: .normal)
  }

  @Test("r-on-emoji")
  func rOnEmoji() {
    let t = VimTester(VimText("😀a"), cursor: (0, 0))
    t.keys("r", "x")
    t.expect(doc: VimText("xa"), selection: [[0, 1]], mode: .normal)
  }

  @Test("tilde-sharp-s")
  func tildeSharpS() {
    let t = VimTester(VimText("ßa"), cursor: (0, 0))
    t.keys("~")
    t.expect(doc: VimText("SSa"), selection: [[0, 1]], mode: .normal)
  }

  @Test("gU-strasse")
  func guStrasse() {
    let t = VimTester(VimText("straße"), cursor: (0, 0))
    t.keys("g", "U", "i", "w")
    t.expect(doc: VimText("STRASSE"), selection: [[0, 0]], mode: .normal)
  }

  @Test("f-emoji")
  func fEmoji() {
    let t = VimTester(VimText("ab😀cd"), cursor: (0, 0))
    t.keys("f", "😀")
    t.expect(doc: VimText("ab😀cd"), selection: [[0, 4]], mode: .normal)
    t.keys("x")
    t.expect(doc: VimText("ab😀d"), selection: [[0, 4]], mode: .normal)
    #expect(t.register("\"")?.text == VimText("c"))
    #expect(t.register("-")?.text == VimText("c"))
  }

  @Test("dollar-emoji")
  func dollarEmoji() {
    let t = VimTester(VimText("a😀"), cursor: (0, 0))
    t.keys("$")
    t.expect(doc: VimText("a😀"), selection: [[0, 1]], mode: .normal)
  }

  @Test("diw-accents")
  func diwAccents() {
    let t = VimTester(VimText("héllo wörld"), cursor: (0, 7))
    t.keys("d", "i", "w")
    t.expect(doc: VimText("héllo "), selection: [[0, 5]], mode: .normal)
    #expect(t.register("\"")?.text == VimText("wörld"))
    #expect(t.register("-")?.text == VimText("wörld"))
  }

  @Test("star-accents")
  func starAccents() {
    let t = VimTester(VimText("héllo x héllo"), cursor: (0, 0))
    t.keys("*")
    t.expect(doc: VimText("héllo x héllo"), selection: [[0, 8]], mode: .normal)
    #expect(t.register("/")?.text == VimText("\\bhéllo\\b"))
  }

  @Test("insert-emoji")
  func insertEmoji() {
    let t = VimTester(VimText("ab"), cursor: (0, 1))
    t.keys("i", "😀", "<Esc>")
    t.expect(doc: VimText("a😀b"), selection: [[0, 2]], mode: .normal)
    #expect(t.register(".")?.text == VimText("😀"))
    t.keys(".")
    t.expect(doc: js("a\\uD83D😀\\uDE00b"), selection: [[0, 3]], mode: .normal)
    #expect(t.register(".")?.text == VimText("😀"))
  }

  @Test("yank-put-emoji")
  func yankPutEmoji() {
    let t = VimTester(VimText("😀x"), cursor: (0, 0))
    t.session.lastMessage = nil
    t.keys("y", "l")
    t.expect(doc: VimText("😀x"), selection: [[0, 0]], mode: .normal)
    #expect(t.session.lastMessage == "1 lines yanked")
    #expect(t.register("\"")?.text == VimText("😀"))
    #expect(t.register("0")?.text == VimText("😀"))
    t.keys("p")
    t.expect(doc: js("\\uD83D😀\\uDE00x"), selection: [[0, 2]], mode: .normal)
    #expect(t.register("\"")?.text == VimText("😀"))
    #expect(t.register("0")?.text == VimText("😀"))
  }

  @Test("w-emoji-words")
  func wEmojiWords() {
    let t = VimTester(VimText("a😀b c"), cursor: (0, 0))
    t.keys("w")
    t.expect(doc: VimText("a😀b c"), selection: [[0, 1]], mode: .normal)
    t.keys("w")
    t.expect(doc: VimText("a😀b c"), selection: [[0, 3]], mode: .normal)
  }

  @Test("e-greek")
  func eGreek() {
    let t = VimTester(VimText("αβγ δε"), cursor: (0, 0))
    t.keys("e")
    t.expect(doc: VimText("αβγ δε"), selection: [[0, 2]], mode: .normal)
    t.keys("w")
    t.expect(doc: VimText("αβγ δε"), selection: [[0, 4]], mode: .normal)
  }

  @Test("tilde-emoji-then-letter")
  func tildeEmojiThenLetter() {
    let t = VimTester(VimText("😀b"), cursor: (0, 0))
    t.keys("~")
    t.expect(doc: VimText("😀b"), selection: [[0, 1]], mode: .normal)
    t.keys("~")
    t.expect(doc: VimText("😀b"), selection: [[0, 2]], mode: .normal)
  }

  @Test("search-emoji")
  func searchEmoji() {
    let t = VimTester(VimText("x 😀 y 😀"), cursor: (0, 0))
    t.keys("/", "😀", "<CR>")
    t.expect(doc: VimText("x 😀 y 😀"), selection: [[0, 2]], mode: .normal)
    #expect(t.register("/")?.text == VimText("😀"))
    t.keys("n")
    t.expect(doc: VimText("x 😀 y 😀"), selection: [[0, 7]], mode: .normal)
    #expect(t.register("/")?.text == VimText("😀"))
  }

  @Test("visual-block-cjk")
  func visualBlockCjk() {
    let t = VimTester(VimText("日本語\nabc"), cursor: (0, 0))
    t.keys("<C-v>", "j", "l", "d")
    t.expect(doc: VimText("語\nc"), selection: [[0, 0]], mode: .normal)
    #expect(t.register("\"")?.text == VimText("日本\nab"))
  }

  @Test("r-astral-on-ascii")
  func rAstralOnAscii() {
    let t = VimTester(VimText("ab"), cursor: (0, 0))
    t.keys("r", "😀")
    t.expect(doc: js("\\uDE00b"), selection: [[0, 0]], mode: .normal)
  }

  @Test("r-astral-on-emoji")
  func rAstralOnEmoji() {
    let t = VimTester(VimText("😀b"), cursor: (0, 0))
    t.keys("r", "😀")
    t.expect(doc: js("\\uDE00b"), selection: [[0, 1]], mode: .normal)
  }

  @Test("count-r-astral")
  func countRAstral() {
    let t = VimTester(VimText("abc"), cursor: (0, 0))
    t.keys("2", "r", "😀")
    t.expect(doc: js("\\uDE00\\uDE00c"), selection: [[0, 1]], mode: .normal)
  }

  @Test("visual-r-astral")
  func visualRAstral() {
    let t = VimTester(VimText("a😀b"), cursor: (0, 0))
    t.keys("v", "l", "l", "r", "é")
    t.expect(doc: VimText("ééé"), selection: [[0, 0]], mode: .normal)
  }

  @Test("block-r-astral")
  func blockRAstral() {
    let t = VimTester(VimText("a😀\nbc"), cursor: (0, 0))
    t.keys("<C-v>", "j", "l", "r", "😀")
    t.expect(doc: js("\\uDE00\\uDE00\\uDE00\n\\uDE00\\uDE00"), selection: [[0, 0]], mode: .normal)
  }
}
