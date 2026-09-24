import AppKit
import DailyDoListVim

/// Vim's search highlight (`hlsearch`, `incsearch`): the matches of the current search in the
/// visible lines as temporary background attributes (layout doesn't change), refreshed when the
/// view scrolls or the text changes.
@MainActor
final class VimSearchHighlighter {
  /// The web app's `.cm-searchMatch`: the warning tone at 25 %.
  static let matchColor = EditorColors.warningFill

  private var highlight: VimSearchHighlight?
  /// Where attributes were added (character ranges at the time), to remove them.
  private var marked: [NSRange] = []
  private var textChanged = false

  var isShowing: Bool { highlight != nil }
  var markedRanges: [NSRange] { marked }

  func show(_ highlight: VimSearchHighlight?, in host: TextViewVimHost) {
    self.highlight = highlight
    refresh(in: host)
  }

  func textDidChange() {
    textChanged = true
  }

  /// Re-marks the matches in the visible part of the document (plus a margin).
  func refresh(in host: TextViewVimHost) {
    let layoutManager = host.layoutManager
    let length = host.storage.length
    if textChanged, !marked.isEmpty {
      // Edits moved the marked text: clear everywhere.
      layoutManager.removeTemporaryAttribute(.backgroundColor, forCharacterRange: NSRange(location: 0, length: length))
    } else {
      for range in marked {
        let clamped = range.clamped(to: length)
        if clamped.length > 0 { layoutManager.removeTemporaryAttribute(.backgroundColor, forCharacterRange: clamped) }
      }
    }
    marked = []
    textChanged = false
    guard let highlight, length > 0 else { return }
    let visible = host.measuring { visibleCharacters(host) }
    for match in highlight.matches(from: visible.location, to: visible.end) where match.count > 0 {
      let range = NSRange(location: match.lowerBound, length: match.count).clamped(to: length)
      guard range.length > 0 else { continue }
      layoutManager.addTemporaryAttribute(.backgroundColor, value: Self.matchColor, forCharacterRange: range)
      marked.append(range)
    }
  }

  private func visibleCharacters(_ host: TextViewVimHost) -> NSRange {
    let textView = host.textView
    let origin = textView.textContainerOrigin
    let visible = textView.visibleRect.isEmpty
      ? NSRect(origin: .zero, size: host.controller.scrollView.contentSize) : textView.visibleRect
    let area = visible.offsetBy(dx: -origin.x, dy: -origin.y).insetBy(dx: 0, dy: -visible.height / 2)
    let glyphs = host.layoutManager.glyphRange(forBoundingRect: area, in: host.textContainer)
    return host.layoutManager.characterRange(forGlyphRange: glyphs, actualGlyphRange: nil)
  }
}
