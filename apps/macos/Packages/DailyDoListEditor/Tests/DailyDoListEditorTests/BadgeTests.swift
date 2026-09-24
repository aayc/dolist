import AppKit
import Testing

@testable import DailyDoListEditor

@Suite("Agent badges")
@MainActor
struct BadgeTests {
  private func badge(_ id: String, line: Int, status: String = "working") -> EditorBadge {
    EditorBadge(id: id, line: line, status: status, label: "Label \(id)")
  }

  /// Badge lines after an edit applied directly to a store (pure remapping).
  private func remap(_ text: String, badges: [EditorBadge], edit range: NSRange, with replacement: String) -> [String: Int] {
    let storage = NSMutableString(string: text)
    var index = LineIndex(storage)
    var store = BadgeStore()
    store.set(badges, lineIndex: index, text: storage)
    storage.replaceCharacters(in: range, with: replacement)
    index.applyEdit(location: range.location, oldLength: range.length, newLength: (replacement as NSString).length, text: storage)
    store.applyEdit(location: range.location, oldLength: range.length, newLength: (replacement as NSString).length, lineIndex: index, text: storage)
    return Dictionary(uniqueKeysWithValues: store.currentBadges(lineIndex: index).map { ($0.id, $0.line) })
  }

  private let doc = "intro\n- [ ] task one\n- [ ] task two\nend"

  @Test func linesInsertedOrDeletedAboveShiftBadges() {
    let badges = [badge("a", line: 1), badge("b", line: 2)]
    #expect(remap(doc, badges: badges, edit: NSRange(location: 0, length: 0), with: "new\nlines\n") == ["a": 3, "b": 4])
    #expect(remap(doc, badges: badges, edit: NSRange(location: 0, length: 6), with: "") == ["a": 0, "b": 1])
    #expect(remap(doc, badges: badges, edit: NSRange(location: 36, length: 0), with: "\nmore") == ["a": 1, "b": 2])
  }

  @Test func editsWithinTheLineKeepTheBadge() {
    let badges = [badge("a", line: 1)]
    #expect(remap(doc, badges: badges, edit: NSRange(location: 12, length: 3), with: "ONE MORE") == ["a": 1])
    #expect(remap(doc, badges: badges, edit: NSRange(location: 6, length: 0), with: "x") == ["a": 1])
  }

  @Test func enterAtTheStartMovesTheBadgeWithItsTextAndAtTheEndKeepsIt() {
    let badges = [badge("a", line: 1)]
    #expect(remap(doc, badges: badges, edit: NSRange(location: 6, length: 0), with: "\n") == ["a": 2])
    #expect(remap(doc, badges: badges, edit: NSRange(location: 20, length: 0), with: "\n- [ ] ") == ["a": 1])
  }

  @Test func deletingTheLineDropsTheBadge() {
    let badges = [badge("a", line: 1), badge("b", line: 2)]
    // Select the whole line with its newline and delete.
    #expect(remap(doc, badges: badges, edit: NSRange(location: 6, length: 15), with: "") == ["b": 1])
    // Delete from the end of the previous line to the end of the line.
    #expect(remap(doc, badges: badges, edit: NSRange(location: 5, length: 15), with: "") == ["b": 1])
    // Select the content and retype it.
    #expect(remap(doc, badges: badges, edit: NSRange(location: 6, length: 14), with: "x") == ["b": 2])
  }

  @Test func joiningLinesKeepsTheBadgeOnTheMergedLine() {
    let badges = [badge("a", line: 2)]
    // Backspace at the start of "- [ ] task two".
    #expect(remap(doc, badges: badges, edit: NSRange(location: 20, length: 1), with: "") == ["a": 1])
  }

  @Test func aReplacementReinsertingTheSameLineKeepsTheBadge() {
    let badges = [badge("a", line: 1), badge("b", line: 2)]
    let swapped = "intro\n- [ ] task two\n- [ ] task one\nend"
    let result = remap(doc, badges: badges, edit: NSRange(location: 0, length: (doc as NSString).length), with: swapped)
    #expect(result == ["a": 2, "b": 1])
  }

  @Test func editorRemapsBadgesThroughTyping() {
    let editor = EditorHarness(text: doc)
    editor.controller.setBadges([badge("a", line: 1), badge("b", line: 2)])
    editor.select(NSRange(location: 0, length: 0))
    editor.type("# Title\n\n")
    #expect(editor.controller.badges.map(\.line) == [3, 4])
    editor.select(NSRange(location: editor.offset(of: "- [ ] task one"), length: 15))
    editor.backspace()
    #expect(editor.controller.badges.map(\.id) == ["b"])
    #expect(editor.controller.badges.first?.line == 3)
    editor.undo()
    #expect(editor.text.contains("task one"))
  }

  @Test func idleAndIgnoredBadgesAreKeptButNotDrawn() {
    let editor = EditorHarness(text: doc)
    editor.controller.setBadges([badge("a", line: 1, status: "idle"), badge("b", line: 2, status: "ignored"), badge("c", line: 3, status: "done")])
    editor.layout()
    #expect(editor.controller.badges.count == 3)
    #expect(editor.controller.currentBadgeLayouts().map(\.badge.id) == ["c"])
  }

  @Test func badgesAreDrawnAfterTheTextWithoutOverlappingIt() throws {
    let long = "- [ ] " + String(repeating: "a long task description ", count: 12)
    let editor = EditorHarness(text: "- [ ] short\n\(long)\nend", size: NSSize(width: 700, height: 600))
    editor.controller.setBadges([badge("s", line: 0), badge("l", line: 1, status: "waiting_approval")])
    editor.layout()
    let layouts = editor.controller.currentBadgeLayouts()
    #expect(layouts.count == 2)
    let layoutManager = editor.controller.layoutManager
    let origin = editor.textView.textContainerOrigin
    for layout in layouts {
      let anchor = layout.badge.id == "s" ? 0 : editor.offset(of: long)
      let lineEnd = editor.controller.highlighter.lineIndex.contentRange(
        ofLine: editor.controller.highlighter.lineIndex.line(containing: anchor), textLength: (editor.text as NSString).length
      ).end
      let used = layoutManager.lineFragmentUsedRect(forGlyphAt: layoutManager.glyphIndexForCharacter(at: lineEnd - 1), effectiveRange: nil)
      #expect(layout.rect.minX >= used.maxX + origin.x, "badge \(layout.badge.id) overlaps its line")
      #expect(layout.rect.maxX <= editor.textView.bounds.width, "badge \(layout.badge.id) is clipped")
      #expect(abs(layout.rect.midY - (used.midY + origin.y)) <= 1.5)
    }
  }

  @Test func clickingABadgeReportsItWithItsCurrentLine() throws {
    let editor = EditorHarness(text: doc)
    editor.controller.setBadges([badge("a", line: 1)])
    editor.select(NSRange(location: 0, length: 0))
    editor.type("more\n")
    editor.layout()
    let layout = try #require(editor.controller.currentBadgeLayouts().first)
    let point = NSPoint(x: layout.rect.midX, y: layout.rect.midY)
    let selection = editor.selection
    #expect(editor.controller.handleClick(at: point, modifiers: []))
    #expect(editor.delegate.badgeClicks.map(\.id) == ["a"])
    #expect(editor.delegate.badgeClicks.first?.line == 2)
    #expect(editor.selection == selection)
    #expect(editor.controller.textView(editor.textView, toolTipAt: point)?.contains("Label a") == true)
  }

  @Test func labelsAreTruncatedAndUnreadCountsCapped() {
    let badge = EditorBadge(id: "x", line: 0, status: "done", label: String(repeating: "abc ", count: 20), unread: 150)
    #expect(badge.displayLabel.count <= 28)
    #expect(badge.displayLabel.hasSuffix("…"))
    #expect(badge.unreadText == "99+")
    #expect(EditorBadge(id: "y", line: 0, status: "done", label: "ok").unreadText == nil)
  }

  @Test func pillsShrinkToTheSpaceTheyHave() {
    let renderer = EditorHarness(text: "").controller.badgeRenderer
    let badge = EditorBadge(id: "x", line: 0, status: "working", label: "Book a table for four", unread: 2)
    let full = renderer.width(of: badge)
    let roomy = renderer.fitted(badge, maxWidth: full)
    #expect(roomy.label == badge.displayLabel)
    #expect(roomy.width == full)

    let shorter = renderer.fitted(badge, maxWidth: full - 30)
    #expect(shorter.label.hasSuffix("…"))
    #expect(badge.displayLabel.hasPrefix(String(shorter.label.dropLast())))
    #expect(shorter.width <= full - 30)

    let dotOnly = renderer.fitted(badge, maxWidth: 12)
    #expect(dotOnly.label.isEmpty, "no room for even one character: status dot and unread count only")
    #expect(dotOnly.width < shorter.width)
  }

  @Test func badgesInANarrowEditorAreShortenedInsteadOfClipped() throws {
    let long = "- [ ] " + String(repeating: "word ", count: 30)
    let editor = EditorHarness(
      text: "\(long)\n- [ ] short", configuration: EditorConfiguration(readableLineLength: false),
      size: NSSize(width: 200, height: 400))
    let label = "Booking a table for four at the usual place"
    editor.controller.setBadges([
      EditorBadge(id: "a", line: 0, status: "waiting_approval", label: label, unread: 3),
      EditorBadge(id: "b", line: 1, status: "working", label: label),
    ])
    editor.layout()
    let layouts = editor.controller.currentBadgeLayouts()
    #expect(layouts.count == 2)
    for layout in layouts {
      #expect(layout.rect.maxX <= editor.textView.bounds.width, "badge \(layout.badge.id) is clipped")
      #expect(layout.label.isEmpty || layout.label == layout.badge.displayLabel || layout.label.hasSuffix("…"))
    }
    #expect(layouts.contains { $0.label != $0.badge.displayLabel }, "200pt is too narrow for the full labels")
    let first = try #require(layouts.first)
    let point = NSPoint(x: first.rect.midX, y: first.rect.midY)
    #expect(editor.controller.textView(editor.textView, toolTipAt: point)?.contains(label) == true, "the tooltip keeps the full label")
  }

  @Test func narrowEditorsReserveARightMarginForBadges() {
    let editor = EditorHarness(text: doc, configuration: EditorConfiguration(readableLineLength: false), size: NSSize(width: 500, height: 400))
    let before = editor.controller.textContainer.size.width
    editor.controller.setBadges([badge("a", line: 1, status: "waiting_approval")])
    let after = editor.controller.textContainer.size.width
    #expect(after < before)
    let reserve = editor.controller.badgeRenderer.widestRow(editor.controller.badgeStore.items)
    let origin = editor.textView.textContainerOrigin
    #expect(editor.textView.bounds.width - (origin.x + after) >= reserve)
    // A wide window keeps the readable column untouched: the free space fits the badges.
    let wide = EditorHarness(text: doc, size: NSSize(width: 1400, height: 400))
    let column = wide.controller.textContainer.size.width
    wide.controller.setBadges([badge("a", line: 1)])
    #expect(wide.controller.textContainer.size.width == column)
  }
}
