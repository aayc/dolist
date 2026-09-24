import AppKit
import DailyDoListVim

/// Vim's block cursor, drawn like the web app's (`measureCursor` of @replit/codemirror-vim): a
/// block over the character under the cursor in normal, visual and replace mode, the character
/// redrawn on it in the text color; half height while a command is pending, a fifth in replace
/// mode; an outline when the editor isn't focused. A forward visual selection shows it on its last
/// character, and a visual block only on the main range.
@MainActor
final class VimCursorRenderer {
  struct Block: Equatable {
    /// In text-view coordinates.
    var rect: NSRect
    /// The glyphs drawn again on a full block.
    var glyphs: NSRange?
  }

  private(set) var blocks: [Block] = []

  /// Recomputes the blocks for the host's state and redraws what changed.
  func update(for host: TextViewVimHost) {
    let next = host.drawsBlockCursor ? host.measuring { Self.blocks(for: host) } : []
    guard next != blocks else { return }
    let textView = host.textView
    for block in blocks + next { textView.setNeedsDisplay(block.rect.insetBy(dx: -2, dy: -2)) }
    blocks = next
  }

  func draw(in dirtyRect: NSRect, host: TextViewVimHost) {
    guard !blocks.isEmpty else { return }
    let focused = host.textView.isKeyFocus || host.textView.window == nil
    let accent = EditorColors.accent
    for block in blocks where block.rect.intersects(dirtyRect) {
      let path = NSBezierPath(roundedRect: block.rect, xRadius: 1, yRadius: 1)
      if focused {
        accent.withAlphaComponent(0.75).setFill()
        path.fill()
        if let glyphs = block.glyphs {
          NSGraphicsContext.saveGraphicsState()
          NSBezierPath(rect: block.rect).addClip()
          host.layoutManager.drawGlyphs(
            forGlyphRange: glyphs, at: host.textView.textContainerOrigin)
          NSGraphicsContext.restoreGraphicsState()
        }
      } else {
        accent.withAlphaComponent(0.7).setStroke()
        let outline = NSBezierPath(
          roundedRect: block.rect.insetBy(dx: 0.5, dy: 0.5), xRadius: 1, yRadius: 1)
        outline.lineWidth = 1
        outline.stroke()
      }
    }
  }

  private static func blocks(for host: TextViewVimHost) -> [Block] {
    guard let session = host.session, let status = host.status else { return [] }
    let selection = host.selection
    let ranges = status.mode == .visualBlock ? [selection.main] : selection.ranges
    let heightFraction: CGFloat =
      status.mode == .replace ? 0.2 : (session.pendingKeys.isEmpty ? 1 : 0.5)
    return ranges.compactMap { block(at: $0, heightFraction: heightFraction, host: host) }
  }

  private static func block(
    at range: VimSelection.Range, heightFraction: CGFloat, host: TextViewVimHost
  ) -> Block? {
    let storage = host.storage
    let string = storage.mutableString
    let length = storage.length
    let layoutManager = host.layoutManager
    var head = range.head
    if range.anchor < head, head == length || string.character(at: head) != UTF16Unit.newline {
      head -= 1
    }
    head = min(max(head, 0), length)
    if head > 1, head < length, (0xDC00..<0xE000).contains(string.character(at: head)) { head -= 1 }
    guard let caret = host.vimCoords(at: head, side: 1) else { return nil }
    let origin = host.textView.textContainerOrigin
    let font =
      head < length ? (storage.attribute(.font, at: head, effectiveRange: nil) as? NSFont) : nil
    let space = (" " as NSString).size(withAttributes: [
      .font: font ?? host.controller.theme.bodyFont
    ]).width
    var x = CGFloat(caret.left)
    var width = space
    var glyphs: NSRange?
    if head < length, string.character(at: head) != UTF16Unit.newline {
      let characters = string.rangeOfComposedCharacterSequence(at: head)
      let glyphRange = layoutManager.glyphRange(
        forCharacterRange: characters, actualCharacterRange: nil)
      let bounds = layoutManager.boundingRect(forGlyphRange: glyphRange, in: host.textContainer)
      if string.character(at: head) == UTF16Unit.tab {
        // One column at the end of the tab, like the web.
        x = max(x, bounds.maxX - space)
      } else if bounds.width > 0.5 {
        x = bounds.minX
        width = bounds.width
        glyphs = glyphRange
      }
    }
    let top = CGFloat(caret.top)
    let height = CGFloat(caret.bottom - caret.top)
    var rect = NSRect(x: x + origin.x, y: top + origin.y, width: max(1, width), height: height)
    if heightFraction < 1 {
      rect.origin.y += height * (1 - heightFraction)
      rect.size.height = height * heightFraction
      glyphs = nil
    }
    return Block(rect: rect, glyphs: glyphs)
  }
}

extension TextViewVimHost {
  /// Vim draws a block instead of the text view's caret (normal, visual and replace mode).
  var drawsBlockCursor: Bool {
    guard isAttached, let status else { return false }
    return status.mode != .insert
  }

  /// The selection, mode or layout changed: the block cursor follows.
  func cursorDidChange() {
    cursor.update(for: self)
  }

  func focusDidChange() {
    guard isAttached else { return }
    for block in cursor.blocks { textView.setNeedsDisplay(block.rect.insetBy(dx: -2, dy: -2)) }
  }

  func drawOverlays(in dirtyRect: NSRect) {
    guard isAttached else { return }
    cursor.draw(in: dirtyRect, host: self)
  }
}
