#if canImport(UIKit)
  import DailyDoListEditorCore
  import UIKit

  extension MobileMarkdownController {
    /// Draw before TextKit's normal backgrounds so selections remain above the quiet prose band.
    /// Coordinates are supplied by NSLayoutManager; this never mutates text or forces a full parse.
    func drawProseHighlights(
      forGlyphRange glyphs: NSRange, at origin: CGPoint, isHidden: (Int) -> Bool = { _ in false }
    ) {
      for band in proseHighlightBands(forGlyphRange: glyphs, at: origin, isHidden: isHidden) {
        guard let context = UIGraphicsGetCurrentContext() else { return }
        context.saveGState()
        UIBezierPath(roundedRect: band, cornerRadius: 4).addClip()
        UIColor.systemBlue.withAlphaComponent(0.075).setFill()
        context.fill(band)
        UIColor.systemBlue.withAlphaComponent(0.7).setFill()
        context.fill(CGRect(x: band.minX, y: band.minY, width: 2, height: band.height))
        context.restoreGState()
      }
    }

    /// Every wrapped fragment of the anchored source line, excluding any badge paragraph spacing.
    /// Duplicate thread annotations on one line produce one band, and retired anchors vanish with
    /// the shared BadgeStore instead of being relocated from a stale server line number.
    func proseHighlightBands(
      forGlyphRange glyphs: NSRange, at origin: CGPoint, isHidden: (Int) -> Bool = { _ in false }
    ) -> [CGRect] {
      guard configuration.livePreview, input.textStorage.length > 0, glyphs.length > 0 else {
        return []
      }
      let manager = input.layoutManager
      let visible = manager.characterRange(forGlyphRange: glyphs, actualGlyphRange: nil)
      var seen: Set<Int> = []
      var result: [CGRect] = []
      for item in annotations.store.items {
        guard item.badge.highlightsLine, !item.badge.isFading,
          item.badge.status != "idle", item.badge.status != "ignored",
          item.lineEnd > item.anchor, item.anchor < input.textStorage.length,
          item.anchor < visible.end, item.lineEnd > visible.location,
          !isHidden(item.anchor), seen.insert(item.anchor).inserted
        else { continue }
        let range = NSRange(location: item.anchor, length: item.lineEnd - item.anchor)
        let lineGlyphs = manager.glyphRange(forCharacterRange: range, actualCharacterRange: nil)
        manager.enumerateLineFragments(forGlyphRange: lineGlyphs) { fragment, used, _, _, _ in
          guard used.height > 0 else { return }
          // Keep each wrapped fragment's exclusion geometry. A union across a floated drawing
          // would incorrectly tint the drawing and could cover a different paragraph's column.
          let band = CGRect(
            x: fragment.minX, y: used.minY, width: fragment.width, height: used.height)
          result.append(band.offsetBy(dx: origin.x, dy: origin.y))
        }
      }
      return result
    }
  }
#endif
