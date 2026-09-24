import Foundation

@MainActor
public protocol MarkdownEditorDelegate: AnyObject {
  /// Every text change made by the user (not `setText`). Keep it cheap; the host debounces saves.
  func editorTextDidChange(_ editor: MarkdownEditorController, text: String)
  func editor(_ editor: MarkdownEditorController, didClickBadge badge: EditorBadge)
  /// A `[[wikilink]]` was clicked (⌘-click = `newWindow`).
  func editor(_ editor: MarkdownEditorController, didClickWikiLink target: String, newWindow: Bool)
  func editor(_ editor: MarkdownEditorController, didClickLink url: URL)
  /// The caret moved to another 0-based line (throttle before sending presence).
  func editor(_ editor: MarkdownEditorController, cursorDidMoveToLine line: Int)
  /// ⌘S
  func editorDidRequestSave(_ editor: MarkdownEditorController)
}

extension MarkdownEditorDelegate {
  public func editorTextDidChange(_ editor: MarkdownEditorController, text: String) {}
  public func editor(_ editor: MarkdownEditorController, didClickBadge badge: EditorBadge) {}
  public func editor(_ editor: MarkdownEditorController, didClickWikiLink target: String, newWindow: Bool) {}
  public func editor(_ editor: MarkdownEditorController, didClickLink url: URL) {}
  public func editor(_ editor: MarkdownEditorController, cursorDidMoveToLine line: Int) {}
  public func editorDidRequestSave(_ editor: MarkdownEditorController) {}
}
