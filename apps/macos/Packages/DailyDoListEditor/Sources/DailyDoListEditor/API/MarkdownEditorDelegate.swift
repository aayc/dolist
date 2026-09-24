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
  /// ⌘S, vim's `:w` (and `:wq`/`:x` before closing).
  func editorDidRequestSave(_ editor: MarkdownEditorController)
  /// Vim's mode, pending keys or macro recording changed (nil: vim was turned off). Only called
  /// on changes, never for every key typed in insert mode.
  func editor(_ editor: MarkdownEditorController, vimStatusDidChange status: EditorVimStatus?)
  /// An app command from vim (`:q`, `:e note`, `gt`, `:obcommand id`…).
  func editor(_ editor: MarkdownEditorController, perform request: EditorVimRequest) -> EditorVimRequestResult
  /// The sparkle ending a line the agent wrote was clicked: open the thread its marker names.
  func editor(_ editor: MarkdownEditorController, didClickAgentThread threadId: String)
  /// The hover preview of a link: asked when the pointer starts hovering the link (a chance to
  /// start loading what it needs) and again when its tooltip shows. Return what's known now; nil
  /// shows `link.fallbackText`.
  func editor(_ editor: MarkdownEditorController, previewFor link: EditorLinkPreview) -> String?
}

extension MarkdownEditorDelegate {
  public func editorTextDidChange(_ editor: MarkdownEditorController, text: String) {}
  public func editor(_ editor: MarkdownEditorController, didClickBadge badge: EditorBadge) {}
  public func editor(_ editor: MarkdownEditorController, didClickWikiLink target: String, newWindow: Bool) {}
  public func editor(_ editor: MarkdownEditorController, didClickLink url: URL) {}
  public func editor(_ editor: MarkdownEditorController, cursorDidMoveToLine line: Int) {}
  public func editorDidRequestSave(_ editor: MarkdownEditorController) {}
  public func editor(_ editor: MarkdownEditorController, vimStatusDidChange status: EditorVimStatus?) {}
  public func editor(_ editor: MarkdownEditorController, perform request: EditorVimRequest) -> EditorVimRequestResult {
    .unavailable
  }
  public func editor(_ editor: MarkdownEditorController, didClickAgentThread threadId: String) {}
  public func editor(_ editor: MarkdownEditorController, previewFor link: EditorLinkPreview) -> String? { nil }
}
