import Foundation
import Testing

@testable import DailyDoListEditor

@Suite("Tokenizer: block structure")
struct TokenizerBlockTests {
  @Test(arguments: [
    ("# One", LineKind.heading(level: 1)),
    ("## Two", .heading(level: 2)),
    ("### Three", .heading(level: 3)),
    ("#### Four", .heading(level: 4)),
    ("##### Five", .heading(level: 5)),
    ("###### Six", .heading(level: 6)),
    ("####### Seven", .paragraph),
    ("#", .heading(level: 1)),
    ("#\tTabbed", .heading(level: 1)),
    ("   # Three spaces", .heading(level: 1)),
    ("    # Four spaces", .paragraph),
    ("#tag", .paragraph),
    ("#123", .paragraph),
    ("> # Quoted heading", .heading(level: 1)),
  ])
  func headings(line: String, kind: LineKind) {
    #expect(tokenizeLine(line).kind == kind)
  }

  @Test func headingMarkersIncludeTheFollowingWhitespaceAndClosingSequence() {
    #expect(markers("## Title", .heading) == ["## "])
    #expect(markers("#   Spaced", .heading) == ["#   "])
    #expect(markers("# Title ##  ", .heading) == ["# ", " ##  "])
    #expect(markers("# C#", .heading) == ["# "])
    #expect(markers("#", .heading) == ["#"])
  }

  @Test func headingContentIsInlineParsed() {
    #expect(spans("# A **bold** title", .bold) == ["**bold**"])
    #expect(tagNames("## Heading with #tag") == ["tag"])
  }

  @Test(arguments: [
    ("---", LineKind.horizontalRule),
    ("***", .horizontalRule),
    ("___", .horizontalRule),
    ("- - -", .horizontalRule),
    ("* * *  ", .horizontalRule),
    ("----------", .horizontalRule),
    ("--", .paragraph),
    ("---a", .paragraph),
    ("***bold***", .paragraph),
    ("> ---", .horizontalRule),
  ])
  func horizontalRules(line: String, kind: LineKind) {
    #expect(tokenizeLine(line).kind == kind)
  }

  @Test(arguments: [
    ("", LineKind.blank),
    ("   ", .blank),
    ("\t", .blank),
    ("text", .paragraph),
    ("- item", .listItem),
    ("* item", .listItem),
    ("+ item", .listItem),
    ("1. item", .listItem),
    ("12) item", .listItem),
    ("-", .listItem),
    ("- ", .listItem),
    ("-item", .paragraph),
    ("1.item", .paragraph),
    ("1234567890. too long", .paragraph),
    ("\t\t- nested", .listItem),
    ("        - deeply indented stays a list item", .listItem),
  ])
  func listItems(line: String, kind: LineKind) {
    #expect(tokenizeLine(line).kind == kind)
  }

  @Test func bulletsAreMarkersAndNumbersStayVisible() {
    #expect(markers("- item", .bullet) == ["-"])
    #expect(markers("* item", .bullet) == ["*"])
    #expect(markers("1. item", .bullet).isEmpty)
    #expect(spans("1. item", .listNumber) == ["1."])
    #expect(spans("\t10) item", .listNumber) == ["10)"])
  }

  @Test(arguments: [
    ("- [ ] open", UInt16(0x20), "- [ ]"),
    ("- [x] done", UInt16(0x78), "- [x]"),
    ("- [X] done", UInt16(0x58), "- [X]"),
    ("- [/] doing", UInt16(0x2F), "- [/]"),
    ("- [-] cancelled", UInt16(0x2D), "- [-]"),
    ("- [>] deferred", UInt16(0x3E), "- [>]"),
    ("- [<] scheduled", UInt16(0x3C), "- [<]"),
    ("- [?] question", UInt16(0x3F), "- [?]"),
    ("* [ ] star", UInt16(0x20), "* [ ]"),
    ("-   [ ] spaced", UInt16(0x20), "-   [ ]"),
    ("\t- [ ] nested", UInt16(0x20), "- [ ]"),
    ("1. [ ] ordered", UInt16(0x20), "[ ]"),
    ("- [ ]", UInt16(0x20), "- [ ]"),
    ("> - [x] quoted", UInt16(0x78), "- [x]"),
  ])
  func tasks(line: String, status: UInt16, replaced: String) throws {
    let tokens = tokenizeLine(line)
    let task = try #require(tokens.task)
    #expect(task.status == status)
    #expect(substring(line, task.markerRange) == replaced)
    #expect(markers(line, .task) == [replaced])
    #expect(markers(line, .bullet).isEmpty)
  }

  @Test(arguments: ["- [ ]a", "- [] a", "- [xx] a", "-[ ] a", "- [😀] a", "[ ] a", "- [ ]\r"])
  func notTasks(line: String) {
    #expect(tokenizeLine(line).task == nil)
  }

  @Test func taskTextStyles() {
    #expect(spans("- [x] done it", .taskDone) == ["done it"])
    #expect(spans("- [X]   spaced", .taskDone) == ["spaced"])
    #expect(spans("- [-] nope", .taskCancelled) == ["nope"])
    #expect(spans("- [ ] open", .taskDone).isEmpty)
    #expect(spans("- [/] doing", .taskDone).isEmpty)
    #expect(spans("- [x]", .taskDone).isEmpty)
  }

  @Test func blockquotes() {
    #expect(tokenizeLine("> quote").quoteDepth == 1)
    #expect(tokenizeLine("> > nested").quoteDepth == 2)
    #expect(tokenizeLine(">> tight").quoteDepth == 2)
    #expect(tokenizeLine("  > indented").quoteDepth == 1)
    #expect(markers("> > nested", .quote) == ["> ", "> "])
    #expect(markers(">quote", .quote) == [">"])
    #expect(markers("  > x", .quote) == ["  > "])
    #expect(tokenizeLine("> - [ ] task").kind == .listItem)
    #expect(tokenizeLine("a > b").quoteDepth == 0)
  }

  @Test func fencedCode() {
    #expect(
      lineKinds("```swift\nlet x = \"**no**\"\n```\n**yes**")
        == [.codeFenceOpen, .code, .codeFenceClose, .paragraph])
    #expect(lineKinds("~~~\n```\n~~~") == [.codeFenceOpen, .code, .codeFenceClose])
    #expect(lineKinds("````\n```\n````") == [.codeFenceOpen, .code, .codeFenceClose])
    #expect(lineKinds("```\nunterminated\n# still code") == [.codeFenceOpen, .code, .code])
    #expect(lineKinds("  ```\n  code\n  ```  ") == [.codeFenceOpen, .code, .codeFenceClose])
    #expect(lineKinds("``` a ` b") == [.paragraph])
    #expect(lineKinds("```\n```js\n```") == [.codeFenceOpen, .code, .codeFenceClose])
    let inside = MarkdownTokenizer.tokenize("```\n- [ ] not a task\n```")
    #expect(inside[1].tokens.task == nil)
    #expect(inside[1].tokens.markers.isEmpty)
    #expect(inside[1].state == .fence(marker: UTF16Unit.backtick, length: 3))
  }

  @Test func frontmatter() {
    #expect(
      lineKinds("---\ntitle: x\ntags: [a]\n---\n# H")
        == [.frontmatterDelimiter, .frontmatter, .frontmatter, .frontmatterDelimiter, .heading(level: 1)])
    #expect(lineKinds("---\nkey: v\n...\ntext") == [.frontmatterDelimiter, .frontmatter, .frontmatterDelimiter, .paragraph])
    #expect(lineKinds("---\nno close") == [.horizontalRule, .paragraph])
    #expect(lineKinds("text\n---\nmore\n---") == [.paragraph, .horizontalRule, .paragraph, .horizontalRule])
    #expect(lineKinds("---") == [.horizontalRule])
    let far = "---\n" + String(repeating: "k: v\n", count: 250) + "---"
    #expect(lineKinds(far).first == .horizontalRule)
    let fmTokens = MarkdownTokenizer.tokenize("---\ntitle: **x** #tag\n---")
    #expect(fmTokens[1].tokens.spans.isEmpty)
  }

  @Test func documentOffsetsAreUTF16() {
    let lines = MarkdownTokenizer.tokenize("😀 one\n- [ ] **two**\n")
    #expect(lines.count == 3)
    #expect(lines[0].range == NSRange(location: 0, length: 6))
    #expect(lines[1].range == NSRange(location: 7, length: 13))
    let bold = try? #require(lines[1].tokens.spans.first { $0.style == .bold })
    #expect(bold?.range == NSRange(location: 13, length: 7))
    #expect(lines[1].tokens.task?.markerRange == NSRange(location: 7, length: 5))
    #expect(lines[2].tokens.kind == .blank)
  }
}
