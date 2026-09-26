import AppKit

/// TextKit 1 layout manager that lets `DecorationRenderer` draw the editor's decorations: code
/// block, inline code, tag and highlight backgrounds, blockquote bars and horizontal rules behind
/// the text (and behind the selection highlight), and checkboxes and bullets in the slots live
/// preview reserves.
///
/// `NSLayoutManager` isn't actor-annotated, but this text system is only ever used from the main
/// thread (layout and drawing are driven by the text view), hence the `assumeIsolated` hops.
final class MarkdownLayoutManager: NSLayoutManager {
  weak var renderer: DecorationRenderer?
  /// Character ranges restyled while the text storage processed an edit; invalidated along with
  /// that edit when this layout manager processes it (their coordinates are the edited text's).
  var invalidateAfterEdit: [NSRange] = []

  /// The restyled ranges join the range the edit invalidates, so `super` invalidates them in its
  /// one pass. A second pass after it (`invalidateGlyphs`, `invalidateLayout`) recomputes the text
  /// container's used rect, which resizes the text view; when that shows or hides a legacy
  /// scroller, the text view counts its glyphs, and generating the ones `super` just invalidated
  /// raises while the storage is still processing the edit.
  override func processEditing(
    for textStorage: NSTextStorage, edited editMask: NSTextStorageEditActions,
    range newCharRange: NSRange,
    changeInLength delta: Int, invalidatedRange invalidatedCharRange: NSRange
  ) {
    var invalidated = invalidatedCharRange
    var beyondEditedLines = false
    for range in invalidateAfterEdit {
      let clamped = range.clamped(to: textStorage.length)
      guard clamped.length > 0 else { continue }
      if clamped.location < invalidatedCharRange.location || clamped.end > invalidatedCharRange.end
      {
        beyondEditedLines = true
      }
      invalidated = NSUnionRange(invalidated, clamped)
    }
    invalidateAfterEdit.removeAll()
    super.processEditing(
      for: textStorage, edited: editMask, range: newCharRange, changeInLength: delta,
      invalidatedRange: invalidated)
    // Display invalidation by character range would generate glyphs: redraw what's visible.
    guard beyondEditedLines else { return }
    nonisolated(unsafe) let manager = self
    MainActor.assumeIsolated {
      if let textView = manager.firstTextView { textView.setNeedsDisplay(textView.visibleRect) }
    }
  }

  override func drawBackground(forGlyphRange glyphsToShow: NSRange, at origin: NSPoint) {
    nonisolated(unsafe) let manager = self
    MainActor.assumeIsolated {
      manager.renderer?.drawBackground(in: manager, glyphRange: glyphsToShow, origin: origin)
    }
    super.drawBackground(forGlyphRange: glyphsToShow, at: origin)
  }

  override func drawGlyphs(forGlyphRange glyphsToShow: NSRange, at origin: NSPoint) {
    super.drawGlyphs(forGlyphRange: glyphsToShow, at: origin)
    nonisolated(unsafe) let manager = self
    MainActor.assumeIsolated {
      manager.renderer?.drawReplacements(in: manager, glyphRange: glyphsToShow, origin: origin)
    }
  }
}
