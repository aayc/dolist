import AppKit
import DailyDoListUI
import Testing

@testable import DailyDoListEditor

@Suite("Hit testing: checkboxes and links")
@MainActor
struct HitTestingTests {
  @Test func checkboxRectsSitOnTheTaskLines() throws {
    let editor = EditorHarness("- [ ] one\n- [x] two\n1. [ ] three\nplain|")
    editor.layout()
    let boxes = editor.controller.checkboxRects()
    #expect(boxes.map(\.line) == [0, 1, 2])
    let size = editor.controller.theme.checkboxSize
    for box in boxes {
      #expect(abs(box.rect.width - size) < 0.5)
      let lineRect = editor.controller.lineRectInTextView(
        at: editor.controller.highlighter.lineIndex.start(ofLine: box.line))
      #expect(box.rect.minY >= lineRect.minY - 1 && box.rect.maxY <= lineRect.maxY + 1)
    }
    // The ordered task's checkbox sits after its number.
    let ordered = try #require(boxes.first { $0.line == 2 })
    #expect(ordered.rect.minX > boxes[0].rect.minX)
  }

  @Test func clickingACheckboxTogglesTheTaskAsAnUndoableEdit() throws {
    let editor = EditorHarness("- [ ] one\n- [/] two\nplain|")
    editor.layout()
    let first = try #require(editor.controller.checkboxRects().first { $0.line == 0 })
    let caret = editor.selection
    editor.act {
      #expect(
        editor.controller.handleClick(
          at: NSPoint(x: first.rect.midX, y: first.rect.midY), modifiers: []))
    }
    #expect(editor.text == "- [x] one\n- [/] two\nplain")
    #expect(editor.selection == caret)
    let second = try #require(editor.controller.checkboxRects().first { $0.line == 1 })
    editor.act {
      editor.controller.handleClick(
        at: NSPoint(x: second.rect.midX, y: second.rect.midY), modifiers: [])
    }
    #expect(editor.text == "- [x] one\n- [x] two\nplain")
    editor.undo()
    #expect(editor.text == "- [x] one\n- [/] two\nplain")
    #expect(editor.delegate.textChanges.count == 3)
  }

  @Test func readOnlyCheckboxesSwallowClicksWithoutToggling() throws {
    let editor = EditorHarness(
      "- [ ] one\nplain|", configuration: EditorConfiguration(isEditable: false))
    editor.layout()
    let box = try #require(editor.controller.checkboxRects().first)
    #expect(
      editor.controller.handleClick(at: NSPoint(x: box.rect.midX, y: box.rect.midY), modifiers: []))
    #expect(editor.text == "- [ ] one\nplain")
  }

  @Test func revealedCheckboxesAreText() {
    let editor = EditorHarness("- [|] one")
    editor.layout()
    #expect(editor.controller.checkboxRects().isEmpty)
  }

  @Test func plainClickFollowsRenderedLinks() {
    let text =
      "See [[Daily/2026-06-19#Tasks|today]] and [docs](https://example.com/docs) and [note](Notes/Plan.md)\nx"
    let editor = EditorHarness(
      text: text, selection: NSRange(location: (text as NSString).length, length: 0))
    editor.layout()
    #expect(
      editor.controller.handleClick(at: editor.point(at: editor.range(of: "today")), modifiers: []))
    #expect(editor.delegate.wikiLinks.map(\.target) == ["Daily/2026-06-19"])
    #expect(editor.delegate.wikiLinks.first?.newWindow == false)
    #expect(
      editor.controller.handleClick(at: editor.point(at: editor.range(of: "docs")), modifiers: []))
    #expect(editor.delegate.links == [URL(string: "https://example.com/docs")!])
    #expect(
      editor.controller.handleClick(at: editor.point(at: editor.range(of: "note")), modifiers: []))
    #expect(editor.delegate.wikiLinks.last?.target == "Notes/Plan.md")
    #expect(
      !editor.controller.handleClick(at: editor.point(at: editor.range(of: "See")), modifiers: []))
  }

  @Test func linksOnTheCaretLineNeedCommandClick() {
    let text = "go [[Target]] now https://example.com/x"
    let editor = EditorHarness(text: text, selection: NSRange(location: 1, length: 0))
    editor.layout()
    let wiki = editor.point(at: editor.range(of: "Target"))
    #expect(!editor.controller.handleClick(at: wiki, modifiers: []))
    #expect(editor.controller.handleClick(at: wiki, modifiers: .command))
    #expect(editor.delegate.wikiLinks.first?.target == "Target")
    #expect(editor.delegate.wikiLinks.first?.newWindow == true)
    #expect(
      editor.controller.handleClick(
        at: editor.point(at: editor.range(of: "example.com")), modifiers: .command))
    #expect(editor.delegate.links == [URL(string: "https://example.com/x")!])
  }

  @Test func sourceModeFollowsLinksOnlyWithCommand() {
    let editor = EditorHarness("[[A]]\nx|", configuration: EditorConfiguration(livePreview: false))
    editor.layout()
    let point = editor.point(at: editor.range(of: "A"))
    #expect(!editor.controller.handleClick(at: point, modifiers: []))
    #expect(editor.controller.handleClick(at: point, modifiers: .command))
  }

  @Test func unsafeSchemesAreNeverPassedOn() {
    #expect(LinkClassifier.classify("javascript:alert(1)") == nil)
    #expect(LinkClassifier.classify("file:///etc/passwd") == nil)
    #expect(LinkClassifier.classify("data:text/html,x") == nil)
    #expect(LinkClassifier.classify("https://x.com") == .external(URL(string: "https://x.com")!))
    #expect(LinkClassifier.classify("www.x.com") == .external(URL(string: "https://www.x.com")!))
    #expect(
      LinkClassifier.classify("me@example.com") == .external(URL(string: "mailto:me@example.com")!))
    #expect(LinkClassifier.classify("tel:+123") == .external(URL(string: "tel:+123")!))
    #expect(
      LinkClassifier.classify("Notes/My%20Plan.md#Goals")
        == .note(target: "Notes/My Plan.md", subpath: "Goals"))
    #expect(
      LinkClassifier.destination(for: .wiki(target: "", subpath: "H", alias: nil, isEmbed: false))
        == nil)
  }

  @Test func externalLinksAreExactlyTheOnesTheAppOpens() {
    let raws = [
      "https://x.com", "HTTPS://X.COM/a", "www.x.com", "//x.com", "me@example.com",
      "mailto:me@example.com", "tel:+123", "http:relative", "https://", "mailto:", "tel:",
      "javascript:alert(1)", "ftp://x.com",
    ]
    for raw in raws {
      guard case .external(let url) = LinkClassifier.classify(raw) else { continue }
      #expect(LinkPolicy.isAllowed(url), "\(raw)")
    }
    #expect(LinkClassifier.classify("http:relative") == nil, "no host")
    #expect(LinkClassifier.classify("mailto:") == nil)
    #expect(LinkClassifier.classify("tel:") == nil)
  }

  @Test func phoneLinksAreFollowedAndHostlessOnesAreNot() {
    let text = "[call](tel:+15550100) or [nowhere](http:relative)\nx"
    let editor = EditorHarness(
      text: text, selection: NSRange(location: (text as NSString).length, length: 0))
    editor.layout()
    editor.controller.handleClick(at: editor.point(at: editor.range(of: "call")), modifiers: [])
    editor.controller.handleClick(at: editor.point(at: editor.range(of: "nowhere")), modifiers: [])
    #expect(editor.delegate.links == [URL(string: "tel:+15550100")!])
  }
}
