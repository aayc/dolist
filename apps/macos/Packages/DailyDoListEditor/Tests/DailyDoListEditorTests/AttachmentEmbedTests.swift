import Foundation
import Testing

@testable import DailyDoListEditorCore

@Suite("Attachment parsing and incremental tracking")
struct AttachmentEmbedTests {
  @Test func localImagesAndPDFsRetainModifiersAndRejectRemoteSources() throws {
    let wiki = try #require(
      NoteAttachmentEmbed.parse(line: " ![[assets/figure.png|caption|360x240|right-wrap]] "))
    #expect(wiki.spec.width == 360 && wiki.spec.height == 240)
    #expect(wiki.spec.alias == "caption" && wiki.spec.placement == .rightWrap)
    let markdown = try #require(NoteAttachmentEmbed.parse(line: "![sample](assets/figure.png)"))
    #expect(markdown.markdown && markdown.spec.target == "assets/figure.png")
    #expect(NoteAttachmentEmbed.parse(line: "![[report.pdf#page=2]]")?.spec.subpath == "page=2")
    for source in [
      "![[https://example.test/image.png]]", "![remote](https://example.test/x.png)",
      "![[file:///image.png]]", "![[%66ile%3A/image.png]]", "text ![[image.png]]",
      "`![[image.png]]`", "![[note.md]]",
    ] {
      #expect(NoteAttachmentEmbed.parse(line: source) == nil)
    }
  }

  @Test func attachmentLinesFollowEditsAndIgnoreCodeAndFrontmatter() {
    let text = NSMutableString(
      string: "---\ncover: ![[a.png]]\n---\n![[a.png]]\n```\n![[b.pdf]]\n```\n![c](c.jpg)\ntext")
    let cache = MarkdownParseCache()
    cache.rebuild(text, consume: { _, _, _, _ in })
    #expect(cache.attachmentLines == [3, 7])
    let inserted = "hello\n"
    text.insert(inserted, at: 0)
    cache.textDidChange(
      in: NSRange(location: 0, length: inserted.utf16.count), changeInLength: inserted.utf16.count,
      text: text, consume: { _, _, _, _ in })
    #expect(cache.attachmentLines == [4, 8])
    let index = cache.lineIndex.contentRange(ofLine: 4, textLength: text.length)
    text.replaceCharacters(in: index, with: "gone")
    cache.textDidChange(
      in: NSRange(location: index.location, length: 4), changeInLength: 4 - index.length,
      text: text, consume: { _, _, _, _ in })
    #expect(cache.attachmentLines == [8])
    #expect(cache.embedLines.isEmpty)
  }
}
