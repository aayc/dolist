import AppKit
import Foundation

@testable import DailyDoListEditor

/// Parses marked text: `|` is the caret, `«` … `»` a selection.
func parseMarked(_ marked: String) -> (text: String, selection: NSRange) {
  var units: [UInt16] = []
  var caret: Int?
  var start: Int?
  var end: Int?
  for unit in marked.utf16 {
    switch unit {
    case 0x7C where caret == nil: caret = units.count  // |
    case 0xAB: start = units.count  // «
    case 0xBB: end = units.count  // »
    default: units.append(unit)
    }
  }
  let text = String(decoding: units, as: UTF16.self)
  if let start, let end { return (text, NSRange(location: start, length: end - start)) }
  return (text, NSRange(location: caret ?? units.count, length: 0))
}

/// Renders text with its selection in the marked notation.
func renderMarked(_ text: String, _ selection: NSRange) -> String {
  let ns = text as NSString
  if selection.length == 0 {
    return ns.replacingCharacters(in: NSRange(location: selection.location, length: 0), with: "|")
  }
  let withEnd =
    ns.replacingCharacters(in: NSRange(location: selection.end, length: 0), with: "»") as NSString
  return withEnd.replacingCharacters(
    in: NSRange(location: selection.location, length: 0), with: "«")
}

@MainActor
final class RecordingDelegate: MarkdownEditorDelegate {
  var textChanges: [String] = []
  var cursorLines: [Int] = []
  var badgeClicks: [EditorBadge] = []
  var wikiLinks: [(target: String, newWindow: Bool)] = []
  var links: [URL] = []
  var saves = 0
  var agentThreadClicks: [String] = []
  var previewRequests: [EditorLinkPreview] = []
  /// What `previewFor` answers (nil: the editor's fallback).
  var previewAnswer: String?

  func editor(_ editor: MarkdownEditorController, didClickAgentThread threadId: String) {
    agentThreadClicks.append(threadId)
  }
  func editor(_ editor: MarkdownEditorController, previewFor link: EditorLinkPreview) -> String? {
    previewRequests.append(link)
    return previewAnswer
  }
  func editorTextDidChange(_ editor: MarkdownEditorController, text: String) {
    textChanges.append(text)
  }
  func editor(_ editor: MarkdownEditorController, didClickBadge badge: EditorBadge) {
    badgeClicks.append(badge)
  }
  func editor(_ editor: MarkdownEditorController, didClickWikiLink target: String, newWindow: Bool)
  {
    wikiLinks.append((target, newWindow))
  }
  func editor(_ editor: MarkdownEditorController, didClickLink url: URL) { links.append(url) }
  func editor(_ editor: MarkdownEditorController, cursorDidMoveToLine line: Int) {
    cursorLines.append(line)
  }
  func editorDidRequestSave(_ editor: MarkdownEditorController) { saves += 1 }
}

/// An offscreen editor driven like a user would: typing goes through `insertText`, keys through
/// the text view's action methods. Every action is its own undo group (tests have no run loop to
/// close NSTextView's automatic groups).
@MainActor
final class EditorHarness {
  let controller: MarkdownEditorController
  let delegate = RecordingDelegate()

  /// An editor with marked text (`|` caret, `«…»` selection).
  convenience init(
    _ marked: String = "", configuration: EditorConfiguration = EditorConfiguration(),
    size: NSSize = NSSize(width: 900, height: 700)
  ) {
    let (text, selection) = parseMarked(marked)
    self.init(text: text, selection: selection, configuration: configuration, size: size)
  }

  /// An editor with raw text (no markers parsed).
  init(
    text: String, selection: NSRange = NSRange(location: 0, length: 0),
    configuration: EditorConfiguration = EditorConfiguration(),
    size: NSSize = NSSize(width: 900, height: 700)
  ) {
    controller = MarkdownEditorController(configuration: configuration)
    controller.scrollView.frame = NSRect(origin: .zero, size: size)
    controller.markdownTextView.frame.size.width = controller.scrollView.contentSize.width
    controller.delegate = delegate
    controller.setText(text, resetUndo: true)
    controller.noteUndoManager.groupsByEvent = false
    controller.setSelection([selection], adjust: false)
    delegate.textChanges.removeAll()
    delegate.cursorLines.removeAll()
  }

  var textView: MarkdownTextView { controller.markdownTextView }
  var text: String { controller.text }
  var selection: NSRange { textView.selectedRange() }
  var marked: String { renderMarked(text, selection) }
  var undoManager: UndoManager { controller.noteUndoManager }

  func select(_ range: NSRange) {
    controller.setSelection([range])
  }

  /// Runs `action` as one user action (its own undo group).
  func act(_ action: () -> Void) {
    let manager = controller.noteUndoManager
    manager.groupsByEvent = false
    manager.beginUndoGrouping()
    action()
    manager.endUndoGrouping()
  }

  /// Types each character through the text view, like keystrokes.
  func type(_ string: String) {
    act {
      for character in string {
        if character == "\n" {
          textView.insertNewline(nil)
        } else {
          textView.insertText(
            String(character), replacementRange: NSRange(location: NSNotFound, length: 0))
        }
      }
    }
  }

  func enter() { act { textView.insertNewline(nil) } }
  func tab() { act { textView.insertTab(nil) } }
  func backtab() { act { textView.insertBacktab(nil) } }
  func backspace() { act { textView.deleteBackward(nil) } }

  func command(_ block: (MarkdownEditorController) -> Void) {
    act { block(controller) }
  }

  func undo() {
    let manager = controller.noteUndoManager
    if manager.canUndo { manager.undo() }
  }

  func redo() {
    let manager = controller.noteUndoManager
    if manager.canRedo { manager.redo() }
  }

  /// Lays out the whole document.
  func layout() {
    controller.layoutManager.ensureLayout(for: controller.textContainer)
  }

  /// Glyph property of the character at `index` (after generating glyphs).
  func glyphProperty(at index: Int) -> NSLayoutManager.GlyphProperty {
    let layoutManager = controller.layoutManager
    layoutManager.ensureGlyphs(forCharacterRange: NSRange(location: index, length: 1))
    return layoutManager.propertyForGlyph(at: layoutManager.glyphIndexForCharacter(at: index))
  }

  /// Characters of `range` that are currently hidden: null glyphs, and control glyphs laid out with
  /// no advance (not a replaced marker's visible slot, not a newline or tab).
  func hiddenCharacters(in range: NSRange) -> Int {
    let layoutManager = controller.layoutManager
    let text = controller.storage.mutableString
    layoutManager.ensureLayout(forCharacterRange: range)
    var hidden = 0
    for index in range.location..<range.end {
      let glyph = layoutManager.glyphIndexForCharacter(at: index)
      let property = layoutManager.propertyForGlyph(at: glyph)
      if property == .null {
        hidden += 1
        continue
      }
      let unit = text.character(at: index)
      guard property == .controlCharacter, unit != UTF16Unit.newline, unit != UTF16Unit.tab else {
        continue
      }
      if advance(ofGlyph: glyph) < 0.5 { hidden += 1 }
    }
    return hidden
  }

  /// Horizontal advance of a glyph within its line fragment.
  func advance(ofGlyph glyph: Int) -> CGFloat {
    let layoutManager = controller.layoutManager
    var fragmentGlyphs = NSRange()
    let used = layoutManager.lineFragmentUsedRect(
      forGlyphAt: glyph, effectiveRange: &fragmentGlyphs)
    let x = layoutManager.location(forGlyphAt: glyph).x
    if glyph + 1 < fragmentGlyphs.end {
      return layoutManager.location(forGlyphAt: glyph + 1).x - x
    }
    return max(0, used.maxX - x)
  }

  /// Offset of the first occurrence of `needle`.
  func offset(of needle: String) -> Int {
    (text as NSString).range(of: needle).location
  }

  func range(of needle: String) -> NSRange {
    (text as NSString).range(of: needle)
  }

  /// Center of the glyphs of `range`, in text-view coordinates.
  func point(at range: NSRange) -> NSPoint {
    let layoutManager = controller.layoutManager
    layoutManager.ensureLayout(forCharacterRange: range)
    let glyphs = layoutManager.glyphRange(forCharacterRange: range, actualCharacterRange: nil)
    let rect = layoutManager.boundingRect(forGlyphRange: glyphs, in: controller.textContainer)
    let origin = textView.textContainerOrigin
    return NSPoint(x: rect.midX + origin.x, y: rect.midY + origin.y)
  }
}
