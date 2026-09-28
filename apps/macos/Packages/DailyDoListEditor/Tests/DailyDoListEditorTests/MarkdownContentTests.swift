import Foundation
import Testing

@testable import DailyDoListEditorCore

@Suite("Native content parsing and incremental boundaries")
struct MarkdownContentTests {
  @Test func backlinksResolveMarkdownWikiAliasesAndExcludeLiteralBlocks() {
    let notes = [
      "Other.md":
        "[[Garden|plants]]\n[plants](Garden.md#Care)\nA Garden plan\nGardener\n```\n[[Garden]]\n```",
      "Garden.md": "[[Garden]]",
    ]
    let mentions = EditorBacklinkIndex.mentions(
      of: "Garden.md", notes: notes, paths: Array(notes.keys))
    #expect(mentions.map(\.line) == [0, 1, 2])
    #expect(mentions.map(\.kind) == [.linked, .linked, .unlinked])
  }

  @Test func tableCellsFollowGFMSpacesEscapesAndAlignment() throws {
    let row = MarkdownContentLine.parse("| left \\| pipe | `a\\|b` | last |", literal: false)
    let cells = try #require(row.cells)
    #expect(cells.map(\.source) == ["left \\| pipe", "`a\\|b`", "last"])
    let delimiters = MarkdownContentLine.parse("| :--- | :--: | -: |", literal: false)
    #expect(delimiters.delimiter == [.left, .center, .right])
    #expect(MarkdownContentLine.parse("| --:-- |", literal: false).delimiter == nil)
    #expect(MarkdownContentLine.parse("| anything |", literal: true).cells == nil)
    #expect(MarkdownContentLine.parse("escaped \\| prose", literal: false).cells == nil)
  }

  @Test func calloutsPreserveTypesMetadataFoldAndNesting() throws {
    let header = try #require(
      MarkdownContentLine.parse("> > [!warning|custom]- **Careful**", literal: false).callout)
    #expect(header.depth == 2 && header.fold == true)
    #expect(header.type == "warning" && header.title == "**Careful**")
    #expect(MarkdownContentLine.parse("> [!tip]+", literal: false).callout?.fold == false)
    #expect(MarkdownContentLine.parse("> [!custom]", literal: false).callout?.family == "note")
    #expect(MarkdownContentLine.parse("> [!check]", literal: false).callout?.family == "success")
    #expect(MarkdownContentLine.parse("[!note] text", literal: false).callout == nil)
    #expect(MarkdownContentLine.parse("> [!note] text", literal: true).callout == nil)
  }

  @Test func agentMarkersStayOutOfPresentationWithoutChangingSourceRanges() throws {
    let source = "| Name | State | %%agent:thread_1%%"
    let row = MarkdownContentLine.parse(source, literal: false)
    #expect(row.agent?.threadId == "thread_1")
    #expect(row.cells?.map(\.source) == ["Name", "State"])
    let first = try #require(row.cells?.first)
    #expect((source as NSString).substring(with: first.range) == "Name")
    #expect(
      MarkdownContentLine.parse("| - | - | %%agent%%", literal: false).delimiter == [.left, .left])
    let callout = MarkdownContentLine.parse("> [!note] Title %%agent:thread_2%%", literal: false)
    #expect(callout.callout?.title == "Title")
    #expect(callout.agent?.threadId == "thread_2")
  }

  @Test func typingKeepsContentMembershipAndOnlyParsesChangedLine() {
    let text = NSMutableString(
      string:
        "| A | B |\n| - | - |\n| value | other |\n\n> [!note]- Title\n> body\n> > [!tip] Nested\n> > nested body\n\n"
        + Array(repeating: "plain text", count: 2000).joined(separator: "\n"))
    let parser = MarkdownParseCache()
    parser.rebuild(text, consume: { _, _, _, _ in })
    let index = MarkdownContentIndex()
    index.rebuild(text, literal: parser.isLiteralLine)
    let at = text.range(of: "value").location + 2
    text.insert("x", at: at)
    parser.textDidChange(
      in: NSRange(location: at, length: 1), changeInLength: 1, text: text,
      consume: { _, _, _, _ in })
    index.applyEdit(
      location: at, oldLength: 0, newLength: 1, text: text, restyledRange: parser.lastRestyledRange,
      literal: parser.isLiteralLine)
    #expect(index.lastParsedLineCount == 1)
    #expect(index.tables.count == 1 && index.tables[0].last == 2)
    #expect(index.callouts.count == 2 && index.callouts[0].last == 7)
  }

  @Test func joiningBlankLinesIntoCalloutDoesNotRetainTheOldHeader() {
    let text = NSMutableString(string: "intro\n\n\n> [!tip]+ Title\n> body\n")
    let parser = MarkdownParseCache()
    parser.rebuild(text, consume: { _, _, _, _ in })
    let index = MarkdownContentIndex()
    index.rebuild(text, literal: parser.isLiteralLine)
    let location = ("intro\n" as NSString).length
    text.replaceCharacters(in: NSRange(location: location, length: 2), with: "> ")
    parser.textDidChange(
      in: NSRange(location: location, length: 2), changeInLength: 0,
      text: text, consume: { _, _, _, _ in })
    index.applyEdit(
      location: location, oldLength: 2, newLength: 2, text: text,
      restyledRange: parser.lastRestyledRange, literal: parser.isLiteralLine)
    let rebuilt = MarkdownContentIndex()
    rebuilt.rebuild(text, literal: parser.isLiteralLine)
    #expect(index.callouts == rebuilt.callouts)
    #expect(index.callouts.count == 1 && index.callouts[0].first == 1)
  }

  @Test func incrementalContentMatchesFreshParsingAfterStructuralEdits() throws {
    let text = NSMutableString(
      string:
        "intro\n\n| A | B |\n| - | - |\n| one | two |\n\n> [!note]- Title\n> body\n> > [!tip] Nested\n> > text\n\nend"
    )
    let parser = MarkdownParseCache()
    parser.rebuild(text, consume: { _, _, _, _ in })
    let index = MarkdownContentIndex()
    index.rebuild(text, literal: parser.isLiteralLine)
    var seed: UInt64 = 19
    let replacements = [
      "x", "\n", "|", "> ", "", "\n> [!tip]+ Title\n", "\n| a | b |\n| - | - |\n",
    ]
    let iterations = ProcessInfo.processInfo.environment["DDL_TEST_THOROUGH"] == "1" ? 2000 : 100
    for step in 0..<iterations {
      seed = seed &* 6_364_136_223_846_793_005 &+ 1
      let location = Int(seed % UInt64(text.length + 1))
      let removed = min(Int((seed >> 20) % 4), text.length - location)
      let inserted = replacements[Int((seed >> 32) % UInt64(replacements.count))]
      text.replaceCharacters(in: NSRange(location: location, length: removed), with: inserted)
      parser.textDidChange(
        in: NSRange(location: location, length: inserted.utf16.count),
        changeInLength: inserted.utf16.count - removed, text: text, consume: { _, _, _, _ in })
      index.applyEdit(
        location: location, oldLength: removed, newLength: inserted.utf16.count, text: text,
        restyledRange: parser.lastRestyledRange, literal: parser.isLiteralLine)
      let rebuilt = MarkdownContentIndex()
      rebuilt.rebuild(text, literal: parser.isLiteralLine)
      try #require(index.tables == rebuilt.tables, "Table membership at edit \(step)")
      try #require(index.callouts == rebuilt.callouts, "Callout membership at edit \(step)")
      try #require(index.lines == rebuilt.lines, "Line descriptors at edit \(step)")
    }
  }
}
