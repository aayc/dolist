import Foundation
import Testing

@testable import DailyDoListAgent

/// Chunked parsing renders exactly what parsing the whole text renders (so a message typing out
/// never reflows when it finishes), and half-typed markdown is tolerated.
@MainActor
@Suite("Markdown chunks")
struct MarkdownChunkTests {
  nonisolated static let documents: [String] = [
    "Hello **world**.\n\nA second paragraph with `code` and a [link](https://example.com).",
    "Steps:\n\n1. Open the page\n2. Pick a time\n\n3. Confirm\n\nDone.",
    "3. Starts at three\n4. Then four\n\nAfter the list.",
    "1. one\n\n1. lazy numbering\n\n1. still counts\n\nEnd",
    "- a\n- b\n\n  continuation of b\n\n- c\n\nParagraph after.",
    "- outer\n  - inner\n\n    inner paragraph\n\nOut.",
    "```swift\nlet a = 1\n\nlet b = 2\n```\n\nAfter code.\n\n~~~\nraw\n\n~~~\n\nEnd.",
    "> A quote\n> continues\n\n> Another quote\n\nText.",
    "| Desk | Price |\n|---|---|\n| Flexi | $399 |\n| Uplift | $489 |\n\nCheaper: Flexi [1](https://a.example/x).",
    "# Title\n\n## Sub\n\nSetext\n===\n\nBody\n\n---\n\n***\n\nLast.",
    "Para\n\n    indented code\n\n    more code\n\nAfter.",
    "Ref [link][r] here.\n\n[r]: https://example.com\n\nAfter.",
    "<div>\n\nhtml block\n\n</div>\n\nAfter.",
    "Line one\nline two\n\n\n\nAfter blank lines.\n",
    "See [[Ideas]] and [[Projects/Plan#Goals|the plan]].\n\n- [[Ideas]]",
  ]

  static func withoutIds(_ blocks: [MarkdownBlock]) -> [MarkdownBlock] {
    blocks.map { block in
      switch block {
      case .paragraph(_, let text): .paragraph(id: 0, text: text)
      case .heading(_, let level, let text): .heading(id: 0, level: level, text: text)
      case .listItem(_, let marker, let depth, let text):
        .listItem(id: 0, marker: marker, depth: depth, text: text)
      case .quote(_, let text): .quote(id: 0, text: text)
      case .code(_, let language, let code): .code(id: 0, language: language, code: code)
      case .table(_, let header, let rows): .table(id: 0, header: header, rows: rows)
      case .rule: .rule(id: 0)
      }
    }
  }

  static func chunked(_ source: String, typing: Bool = false) -> [MarkdownBlock] {
    withoutIds(MarkdownDocument.blocks(for: source, typing: typing).map(\.block))
  }

  static func whole(_ source: String) -> [MarkdownBlock] {
    withoutIds(MarkdownRenderer.blocks(from: source))
  }

  @Test(arguments: documents)
  func chunkedParsingMatchesTheWholeText(document: String) {
    #expect(Self.chunked(document) == Self.whole(document))
    #expect(MarkdownChunks.split(document).joined() == document)
  }

  /// Every prefix, as the text types out: chunks never change what renders.
  @Test(arguments: documents)
  func everyPrefixRendersTheSameInChunks(document: String) {
    let characters = Array(document)
    for end in stride(from: 1, through: characters.count, by: 2) {
      let prefix = String(characters[..<end])
      #expect(Self.chunked(prefix) == Self.whole(prefix), "prefix: \(prefix.debugDescription)")
    }
  }

  /// When typing finishes, the tolerant rendering of well-formed text is what the final rendering
  /// shows: no jump.
  @Test(arguments: documents.filter { !$0.hasSuffix("\n") })
  func finishedTextRendersTheSameWhileTyping(document: String) {
    #expect(Self.chunked(document, typing: true) == Self.chunked(document))
  }

  @Test func chunksSplitAtParagraphsButKeepListsAndFencesTogether() {
    let chunks = MarkdownChunks.split(
      "Intro\n\n- a\n\n- b\n\nMiddle\n\n```\nx\n\ny\n```\n\nEnd")
    #expect(chunks == ["Intro\n\n- a\n\n- b\n\n", "Middle\n\n", "```\nx\n\ny\n```\n\n", "End"])
    #expect(
      MarkdownChunks.split("[r]: https://x.example\n\nText") == ["[r]: https://x.example\n\nText"])
  }

  nonisolated static let tails: [(typed: String, shown: String)] = [
    ("Hello **wor", "Hello **wor**"),
    ("Hello **world*", "Hello **world**"),
    ("**bold** and **more", "**bold** and **more**"),
    ("a ** b", "a ** b"),
    ("~~old", "~~old~~"),
    ("Use `npm i", "Use `npm i`"),
    ("Say **hi `there", "Say **hi `there`**"),
    ("Done **now** ", "Done **now** "),
    ("text *", "text "),
    ("See [the docs](https://exa", "See the docs"),
    ("See [the do", "See the do"),
    ("Source [1](https://a.exa", "Source "),
    ("Look ![a chart](http", "Look "),
    ("A [complete](https://x.example) link", "A [complete](https://x.example) link"),
    ("Title\n-", "Title\n"),
    ("Title\n==", "Title\n"),
    ("Intro\n\n- ", "Intro\n\n"),
    ("Steps:\n1", "Steps:\n"),
    ("Steps:\n2.", "Steps:\n"),
    ("## ", ""),
    ("> ", ""),
    ("| a | b |\n|--", "| a | b |\n"),
    ("```swift\nlet x = 1\n``", "```swift\nlet x = 1\n"),
    ("```\nlet **x", "```\nlet **x"),
    ("Price is 5", "Price is 5"),
    ("Done.", "Done."),
  ]

  @Test(arguments: tails)
  func halfTypedMarkupIsTolerated(typed: String, shown: String) {
    #expect(MarkdownTail.tolerant(typed) == shown)
  }

  @Test func aHalfTypedListMarkerNeverTurnsTheParagraphIntoAHeading() {
    let blocks = Self.chunked("Some text\n-", typing: true)
    #expect(blocks.count == 1)
    if case .paragraph = blocks.first {} else { Issue.record("expected a paragraph: \(blocks)") }
  }
}
