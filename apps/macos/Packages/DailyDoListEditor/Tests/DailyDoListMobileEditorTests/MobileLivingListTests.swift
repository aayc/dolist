#if canImport(UIKit)
  import DailyDoListEditorCore
  import Testing
  import UIKit
  @testable import DailyDoListMobileEditor

  @MainActor struct MobileLivingListTests {
    @Test func proseBandsWrapMapAndDisappearWithoutChangingMarkdown() throws {
      let editor = MobileMarkdownController()
      editor.input.frame = CGRect(x: 0, y: 0, width: 210, height: 800)
      let prose = "A synthetic paragraph with enough words to wrap over several narrow lines."
      editor.load(prose + "\nFollowing text")
      editor.setBadges([
        EditorBadge(id: "one", line: 0, status: "working", label: "Working", highlightsLine: true),
        EditorBadge(id: "two", line: 0, status: "working", label: "Working", highlightsLine: true),
        EditorBadge(id: "hidden", line: 1, status: "idle", label: "", highlightsLine: true),
      ])
      func bands() -> [CGRect] {
        editor.input.layoutManager.ensureLayout(for: editor.input.textContainer)
        return editor.proseHighlightBands(
          forGlyphRange: NSRange(location: 0, length: editor.input.layoutManager.numberOfGlyphs),
          at: CGPoint(x: 20, y: 20))
      }
      let original = bands()
      #expect(original.count > 1)
      #expect(Set(original.map(\.minY)).count == original.count)
      #expect(editor.text == prose + "\nFollowing text")
      editor.selection = NSRange(location: 0, length: 0)
      editor.input.insertText("Above\n")
      #expect(try #require(bands().first).minY > #require(original.first).minY)
      editor.selection = NSRange(location: 6, length: prose.utf16.count + 1)
      editor.input.insertText("")
      #expect(bands().isEmpty)
      #expect(editor.text == "Above\nFollowing text")
    }

    @Test func sourcePreviewPreservesAliasAndAuthoringThreadAndRejectsActiveSchemes() throws {
      let editor = MobileMarkdownController()
      editor.load(
        "See [1](https://example.test/reference) %%agent:thread-source%%\n[[Note#Heading|Alias]]\n[x](javascript:alert)"
      )
      let source = try #require(editor.linkPreview(atUTF16: 5))
      #expect(source.label == "1")
      #expect(source.agentThreadId == "thread-source")
      let wikiOffset = (editor.text as NSString).range(of: "[[Note").location + 2
      let wiki = try #require(editor.linkPreview(atUTF16: wikiOffset))
      #expect(wiki.label == "Alias")
      #expect(wiki.target == .note(target: "Note", subpath: "Heading"))
      #expect(wiki.agentThreadId == nil)
      let unsafe = (editor.text as NSString).range(of: "[x]").location + 1
      #expect(editor.linkPreview(atUTF16: unsafe) == nil)
    }
  }
#endif
