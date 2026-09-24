import AppKit
import Testing

@testable import DailyDoListEditor

@Suite("Editor smoke tests")
@MainActor
struct SmokeTests {
  @Test func usesTextKit1WithTheMarkdownLayoutManager() {
    let editor = EditorHarness("# Title\n")
    #expect(editor.textView.layoutManager === editor.controller.layoutManager)
    #expect(editor.textView.textLayoutManager == nil)
    #expect(editor.textView.isRichText == false)
    #expect(editor.textView.isAutomaticQuoteSubstitutionEnabled == false)
    #expect(editor.textView.isAutomaticDashSubstitutionEnabled == false)
    #expect(editor.textView.usesFindBar)
    #expect(editor.textView.allowsUndo)
  }

  @Test func stylesHeadingsBoldCodeAndMarkers() throws {
    let editor = EditorHarness("# Title\n**bold** and `code`\n")
    let storage = editor.controller.storage
    let headingFont = try #require(storage.attribute(.font, at: 3, effectiveRange: nil) as? NSFont)
    #expect(headingFont.pointSize == (16 * 1.6).rounded())
    #expect(
      storage.attribute(.ddlMarker, at: 0, effectiveRange: nil) as? Int
        == MarkerKind.heading.rawValue)
    let boldFont = try #require(
      storage.attribute(.font, at: editor.offset(of: "bold"), effectiveRange: nil) as? NSFont)
    #expect(boldFont.fontDescriptor.symbolicTraits.contains(.bold))
    let codeFont = try #require(
      storage.attribute(.font, at: editor.offset(of: "code"), effectiveRange: nil) as? NSFont)
    #expect(codeFont.isFixedPitch)
    #expect(
      storage.attribute(.ddlInlineCode, at: editor.offset(of: "code"), effectiveRange: nil) != nil)
  }

  @Test func typingRestylesTheLine() throws {
    let editor = EditorHarness("|")
    editor.type("## Hello")
    let storage = editor.controller.storage
    let font = try #require(storage.attribute(.font, at: 4, effectiveRange: nil) as? NSFont)
    #expect(font.pointSize == (16 * 1.4).rounded())
    #expect(editor.text == "## Hello")
    #expect(editor.delegate.textChanges.last == "## Hello")
  }
}
