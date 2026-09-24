import AppKit
import Testing

@testable import DailyDoListEditor

@Suite("Live preview")
@MainActor
struct LivePreviewTests {
  @Test func hidesSyntaxAwayFromTheCaretAndRevealsTheCaretLine() {
    let text = "# Title\n**bold** and `code`\n[[Note|alias]] [x](https://e.com)\nplain"
    let editor = EditorHarness(text: text, selection: NSRange(location: (text as NSString).length, length: 0))
    let heading = editor.range(of: "# ")
    let boldLine = editor.range(of: "**bold** and `code`")
    let linkLine = editor.range(of: "[[Note|alias]] [x](https://e.com)")
    #expect(editor.hiddenCharacters(in: heading) == 2)
    #expect(editor.hiddenCharacters(in: boldLine) == 6)
    // `[[Note|` + `]]` and `[` + `](https://e.com)`.
    #expect(editor.hiddenCharacters(in: linkLine) == 9 + 17)

    editor.select(NSRange(location: editor.offset(of: "bold") + 2, length: 0))
    #expect(editor.hiddenCharacters(in: boldLine) == 0)
    #expect(editor.hiddenCharacters(in: heading) == 2)

    editor.select(NSRange(location: 1, length: 0))
    #expect(editor.hiddenCharacters(in: heading) == 0)
    #expect(editor.hiddenCharacters(in: boldLine) == 6)
  }

  @Test func multiLineSelectionsRevealEveryTouchedLine() {
    let editor = EditorHarness("**a**\n**b**\n**c**\nend|")
    editor.select(NSRange(location: 2, length: 7))
    #expect(editor.hiddenCharacters(in: editor.range(of: "**a**")) == 0)
    #expect(editor.hiddenCharacters(in: editor.range(of: "**b**")) == 0)
    #expect(editor.hiddenCharacters(in: editor.range(of: "**c**")) == 4)
  }

  @Test func checkboxReplacesTheMarkerUntilTheCaretTouchesIt() {
    let editor = EditorHarness("- [ ] task|\nnext")
    let layoutManager = editor.controller.layoutManager
    // The first character becomes the checkbox slot, the rest of `- [ ]` disappears.
    #expect(editor.glyphProperty(at: 0) == .controlCharacter)
    #expect(editor.hiddenCharacters(in: NSRange(location: 0, length: 5)) == 4)
    let slot = layoutManager.boundingRect(
      forGlyphRange: NSRange(location: layoutManager.glyphIndexForCharacter(at: 0), length: 1),
      in: editor.controller.textContainer)
    #expect(abs(slot.width - editor.controller.theme.checkboxSlotWidth) < 0.5)

    editor.select(NSRange(location: 5, length: 0))  // right after `]`: touching
    #expect(editor.hiddenCharacters(in: NSRange(location: 0, length: 5)) == 0)
    #expect(editor.glyphProperty(at: 0) != .controlCharacter)

    editor.select(NSRange(location: 6, length: 0))  // start of the text: not touching
    #expect(editor.glyphProperty(at: 0) == .controlCharacter)
  }

  @Test func typingATaskFromScratchRendersTheCheckboxAfterTheSpace() {
    let editor = EditorHarness("|")
    editor.type("- [ ]")
    #expect(editor.glyphProperty(at: 0) != .controlCharacter)
    editor.type(" buy milk")
    #expect(editor.text == "- [ ] buy milk")
    #expect(editor.glyphProperty(at: 0) == .controlCharacter)
  }

  @Test func bulletsBecomeDotsExceptWhenTouched() {
    let editor = EditorHarness("- item\n* other|")
    #expect(editor.glyphProperty(at: 0) == .controlCharacter)
    editor.select(NSRange(location: 1, length: 0))
    #expect(editor.glyphProperty(at: 0) != .controlCharacter)
  }

  @Test func horizontalRulesAndQuotesHideTheirSyntax() {
    let editor = EditorHarness("> quoted\n---\ntext|")
    #expect(editor.hiddenCharacters(in: editor.range(of: "> ")) == 2)
    #expect(editor.hiddenCharacters(in: editor.range(of: "---")) == 3)
    editor.select(NSRange(location: editor.offset(of: "---") + 1, length: 0))
    #expect(editor.hiddenCharacters(in: editor.range(of: "---")) == 0)
  }

  @Test func sourceModeShowsEverythingDimmed() throws {
    let editor = EditorHarness("# Title\n- [ ] task\n**b**\nx|", configuration: EditorConfiguration(livePreview: false))
    #expect(editor.hiddenCharacters(in: NSRange(location: 0, length: (editor.text as NSString).length)) == 0)
    #expect(editor.glyphProperty(at: editor.offset(of: "- [ ]")) != .controlCharacter)
    let color = editor.controller.storage.attribute(.foregroundColor, at: editor.offset(of: "**"), effectiveRange: nil)
    #expect(color as? NSColor == EditorColors.tertiaryText)
    // Toggling live preview on hides the syntax without restyling.
    var configuration = editor.controller.configuration
    configuration.livePreview = true
    editor.controller.configure(configuration)
    #expect(editor.hiddenCharacters(in: editor.range(of: "# ")) == 2)
  }

  @Test func unfocusedEditorRevealsNothing() {
    let editor = EditorHarness("**bold**|")
    let window = NSWindow(
      contentRect: NSRect(x: 0, y: 0, width: 600, height: 400), styleMask: [.titled], backing: .buffered, defer: true)
    window.contentView = editor.controller.scrollView
    window.makeFirstResponder(editor.textView)
    editor.controller.refreshLivePreview()
    #expect(editor.hiddenCharacters(in: editor.range(of: "**bold**")) == 0)
    window.makeFirstResponder(nil)
    #expect(editor.hiddenCharacters(in: editor.range(of: "**bold**")) == 4)
    window.makeFirstResponder(editor.textView)
    #expect(editor.hiddenCharacters(in: editor.range(of: "**bold**")) == 0)
  }

  @Test func caretLandingInsideHiddenSyntaxSnapsToItsEdge() {
    let editor = EditorHarness("- [ ] task\nsecond|")
    // A vertical move proposing an offset inside the replaced `- [ ]` (hidden: caret elsewhere).
    editor.textView.setSelectedRange(NSRange(location: 2, length: 0))
    #expect(editor.selection.location == 0)
    editor.select(NSRange(location: 8, length: 0))
    editor.textView.setSelectedRange(NSRange(location: editor.offset(of: "second") + 2, length: 0))
    editor.select(NSRange(location: editor.offset(of: "second"), length: 0))
    #expect(editor.selection.location == editor.offset(of: "second"))
  }

  @Test func selectionChangesInvalidateOnlyTheLinesThatChange() {
    let editor = EditorHarness(text: SampleNote.long(lines: 400), selection: NSRange(location: 0, length: 0))
    let preview = editor.controller.livePreview
    let index = editor.controller.highlighter.lineIndex
    let storage = editor.controller.storage
    let from = index.start(ofLine: 100)
    editor.select(NSRange(location: from, length: 0))
    let invalid = preview.update(
      selection: [NSRange(location: index.start(ofLine: 101), length: 0)], focused: true, lineIndex: index,
      storage: storage)
    #expect(invalid.count == 2)
    #expect(invalid.allSatisfy { $0.length < 200 })
    let same = preview.update(
      selection: [NSRange(location: index.start(ofLine: 101) + 1, length: 0)], focused: true, lineIndex: index,
      storage: storage)
    #expect(same.isEmpty)
  }

  @Test(arguments: ["\t- [ ] ", "- ", "1. ", "12. [x] ", "> - [ ] "])
  func wrappedListItemsAlignWithTheirText(prefix: String) throws {
    let item = prefix + String(repeating: "wrapping item text ", count: 12)
    let editor = EditorHarness(text: item + "\nend", size: NSSize(width: 700, height: 500))
    editor.select(NSRange(location: (editor.text as NSString).length, length: 0))
    editor.layout()
    let layoutManager = editor.controller.layoutManager
    let textStart = editor.offset(of: "wrapping")
    let glyph = layoutManager.glyphIndexForCharacter(at: textStart)
    var firstLine = NSRange()
    let fragment = layoutManager.lineFragmentRect(forGlyphAt: glyph, effectiveRange: &firstLine)
    let textX = fragment.minX + layoutManager.location(forGlyphAt: glyph).x
    let wrapped = layoutManager.lineFragmentUsedRect(forGlyphAt: firstLine.end, effectiveRange: nil)
    #expect(wrapped.minY > fragment.minY, "item didn't wrap")
    #expect(abs(wrapped.minX - textX) < 1, "wrapped line starts at \(wrapped.minX), text at \(textX)")
  }
}
