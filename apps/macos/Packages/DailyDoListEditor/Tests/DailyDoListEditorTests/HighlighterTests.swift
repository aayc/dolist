import AppKit
import DailyDoListUITestSupport
import Testing

@testable import DailyDoListEditor

@Suite("Incremental highlighter")
@MainActor
struct HighlighterTests {
  /// A freshly (fully) styled copy of `text` with the same theme.
  private func fullyStyled(_ text: String, theme: EditorTheme) -> (
    NSTextStorage, MarkdownHighlighter
  ) {
    let storage = NSTextStorage(string: text)
    let highlighter = MarkdownHighlighter(storage: storage, theme: theme)
    highlighter.restyleAll()
    return (storage, highlighter)
  }

  /// First offset where the two storages' attributes differ, with a description.
  private func firstDifference(_ a: NSTextStorage, _ b: NSTextStorage) -> String? {
    guard a.string == b.string else { return "text differs" }
    var index = 0
    while index < a.length {
      var rangeA = NSRange()
      var rangeB = NSRange()
      let attributesA = a.attributes(at: index, effectiveRange: &rangeA) as NSDictionary
      let attributesB = b.attributes(at: index, effectiveRange: &rangeB) as NSDictionary
      if !attributesA.isEqual(to: attributesB as! [AnyHashable: Any]) {
        let line = (a.string as NSString).lineRange(for: NSRange(location: index, length: 0))
        return
          "offset \(index) in line \((a.string as NSString).substring(with: line).debugDescription): "
          + "\(attributesA) vs \(attributesB)"
      }
      index = min(rangeA.end, rangeB.end)
    }
    return nil
  }

  private static let snippets = [
    "# ", "## Heading ", "- [ ] task ", "- [x] done ", "* ", "1. ", "> ", "> > ", "**bold** ",
    "*it* ", "_u_ ",
    "`code` ", "``", "```", "```swift\n", "~~~\n", "\n```\n", "---", "---\n", "...\n",
    "[[Link|alias]] ",
    "[t](http://x.com) ", "<https://a.b> ", "https://e.com/a_b ", "#tag ", "==hi== ", "~~s~~ ",
    "\\*", "\t", "\n",
    "\n\n", "text ", "é", "[", "]", "(", ")", "|", "*", "_", "`", "~", "=", "#", "-", " ", "- [",
    "x] ",
  ]

  @Test(arguments: [UInt64(1), 2, 3])
  func incrementalStylingMatchesFullRetokenization(seed: UInt64) {
    var rng = SeededGenerator(seed: seed)
    let editor = EditorHarness(text: SampleNote.text)
    let controller = editor.controller
    let storage = controller.storage
    for step in 0..<500 {
      let length = storage.length
      let roll = Int.random(in: 0..<100, using: &rng)
      let location = Int.random(in: 0...length, using: &rng)
      let snippet = Self.snippets.randomElement(using: &rng)!
      let range: NSRange
      let replacement: String
      if roll < 45 || length == 0 {
        range = NSRange(location: location, length: 0)
        replacement = snippet
      } else if roll < 80 {
        range = NSRange(location: location, length: Int.random(in: 1...20, using: &rng)).clamped(
          to: length)
        replacement = ""
      } else {
        range = NSRange(location: location, length: Int.random(in: 1...12, using: &rng)).clamped(
          to: length)
        replacement = snippet
      }
      storage.replaceCharacters(in: range, with: replacement)

      let (reference, fresh) = fullyStyled(storage.string, theme: controller.theme)
      let highlighter = controller.highlighter
      let context = "seed \(seed) step \(step): \(storage.string.debugDescription)"
      guard highlighter.lineIndex == fresh.lineIndex, highlighter.lines == fresh.lines,
        highlighter.frontmatterEnd == fresh.frontmatterEnd
      else {
        Issue.record("line state diverged — \(context)")
        return
      }
      if let difference = firstDifference(storage, reference) {
        Issue.record("attributes diverged at \(difference) — \(context)")
        return
      }
    }
  }

  @Test func typingRestylesOnlyTheEditedLine() {
    let editor = EditorHarness(text: SampleNote.long(lines: 2000))
    editor.select(NSRange(location: editor.offset(of: "Research flights") + 3, length: 0))
    editor.type("x")
    #expect(editor.controller.highlighter.lastRestyledLineCount == 1)
  }

  /// Regression: typing attributes with another paragraph style (e.g. a list line's hanging indent)
  /// made the storage re-fix the rest of the paragraph, widening each keystroke's edit to the next
  /// line.
  @Test(arguments: [
    "- [ ] Research flights\n- [x] Book dinner 🍝\nend", "\t- nested item\n- next\nend",
    "> - quoted\n> more\nend",
    "1. First ordered\n2. second\nend",
  ])
  func typingInAnyLineRestylesJustThatLine(text: String) {
    let editor = EditorHarness(text: text)
    editor.select(NSRange(location: 4, length: 0))
    editor.type("x")
    #expect(editor.controller.highlighter.lastRestyledLineCount == 1)
    editor.select(NSRange(location: editor.offset(of: "\n"), length: 0))
    editor.type("y")
    #expect(editor.controller.highlighter.lastRestyledLineCount == 1)
  }

  @Test func openingAFenceRestylesUntilTheStatesResynchronize() {
    let editor = EditorHarness("intro|\n- [ ] a\n**b**\n```\ncode\n```\nafter")
    editor.select(NSRange(location: 0, length: 0))
    editor.type("```\n")
    // "```", "intro", "- [ ] a", "**b**", "```", "code", "```", "after": the old closing fence now
    // closes the new block and the old opening fence runs to the end.
    let highlighter = editor.controller.highlighter
    #expect(editor.marked == "```\n|intro\n- [ ] a\n**b**\n```\ncode\n```\nafter")
    #expect(highlighter.kind(ofLine: 0) == .codeFenceOpen)
    #expect(highlighter.kind(ofLine: 2) == .code)
    #expect(highlighter.kind(ofLine: 4) == .codeFenceClose)
    #expect(highlighter.kind(ofLine: 5) == .paragraph)
    #expect(highlighter.kind(ofLine: 6) == .codeFenceOpen)
    #expect(highlighter.kind(ofLine: 7) == .code)
    let storage = editor.controller.storage
    let task = editor.offset(of: "- [ ] a")
    #expect(storage.attribute(.ddlMarker, at: task, effectiveRange: nil) == nil)
    #expect(storage.attribute(.ddlCodeBlock, at: task, effectiveRange: nil) != nil)
  }

  @Test func frontmatterAppearsAndDisappearsIncrementally() {
    let editor = EditorHarness("---\ntitle: x\n|\n# H")
    let highlighter = editor.controller.highlighter
    #expect(highlighter.frontmatterEnd == nil)
    #expect(highlighter.kind(ofLine: 0) == .horizontalRule)
    editor.type("---")
    #expect(highlighter.frontmatterEnd == 2)
    #expect(highlighter.kind(ofLine: 1) == .frontmatter)
    #expect(highlighter.kind(ofLine: 3) == .heading(level: 1))
    editor.backspace()
    #expect(highlighter.frontmatterEnd == nil)
    #expect(highlighter.kind(ofLine: 1) == .paragraph)
  }

  @Test func linksCarryTheirTargets() throws {
    let editor = EditorHarness(text: "See [[Note#Part|alias]] and [x](https://example.com)")
    let storage = editor.controller.storage
    let wiki = try #require(
      storage.attribute(.ddlLink, at: editor.offset(of: "alias"), effectiveRange: nil)
        as? LinkAttribute)
    #expect(wiki.target == .wiki(target: "Note", subpath: "Part", alias: "alias", isEmbed: false))
    let url = try #require(
      storage.attribute(.ddlLink, at: editor.offset(of: "x]"), effectiveRange: nil)
        as? LinkAttribute)
    #expect(url.target == .url("https://example.com"))
  }

  @Test func completedTasksAreStruckThroughAndMuted() throws {
    let editor = EditorHarness(text: "- [x] done task\n- [-] dropped")
    let storage = editor.controller.storage
    let done = editor.offset(of: "done task")
    #expect(
      storage.attribute(.strikethroughStyle, at: done, effectiveRange: nil) as? Int
        == NSUnderlineStyle.single.rawValue)
    #expect(
      storage.attribute(.foregroundColor, at: done, effectiveRange: nil) as? NSColor
        == EditorColors.secondaryText)
    let dropped = editor.offset(of: "dropped")
    #expect(
      storage.attribute(.foregroundColor, at: dropped, effectiveRange: nil) as? NSColor
        == EditorColors.tertiaryText)
    #expect(storage.attribute(.strikethroughStyle, at: 0, effectiveRange: nil) == nil)
  }

  @Test func fontSizeChangeRestylesEverything() throws {
    let editor = EditorHarness(text: "# Title\nbody")
    var configuration = editor.controller.configuration
    configuration.fontSize = 20
    editor.controller.configure(configuration)
    let storage = editor.controller.storage
    let heading = try #require(storage.attribute(.font, at: 3, effectiveRange: nil) as? NSFont)
    #expect(heading.pointSize == 32)
    let body = try #require(
      storage.attribute(.font, at: editor.offset(of: "body"), effectiveRange: nil) as? NSFont)
    #expect(body.pointSize == 20)
  }
}
