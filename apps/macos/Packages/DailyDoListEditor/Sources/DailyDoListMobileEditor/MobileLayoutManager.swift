#if canImport(UIKit)
  import DailyDoListEditorCore
  import UIKit

  /// Paints marker replacements in the slots allocated by MobileGlyphDelegate; markdown is never
  /// changed into attachments, so copy, selection and undo continue to use source positions.
  final class MobileLayoutManager: NSLayoutManager {
    var preview: LivePreviewState?
    override func drawGlyphs(forGlyphRange glyphsToShow: NSRange, at origin: CGPoint) {
      super.drawGlyphs(forGlyphRange: glyphsToShow, at: origin)
      nonisolated(unsafe) let manager = self
      MainActor.assumeIsolated { manager.drawMarkers(forGlyphRange: glyphsToShow, at: origin) }
    }

    @MainActor
    private func drawMarkers(forGlyphRange glyphsToShow: NSRange, at origin: CGPoint) {
      guard let storage = textStorage, let preview, preview.isEnabled else { return }
      let characters = characterRange(forGlyphRange: glyphsToShow, actualGlyphRange: nil)
      storage.enumerateAttribute(.ddlMarker, in: characters) { value, range, _ in
        guard let value = value as? Int, let kind = MarkerKind(rawValue: value), kind.isReplacement,
          preview.isHidden(kind, range: range), let rect = markerRect(at: range.location)
        else { return }
        let box = rect.offsetBy(dx: origin.x, dy: origin.y)
        switch kind {
        case .task:
          let text = storage.mutableString.substring(with: range)
          let done = text.contains("[x]") || text.contains("[X]")
          let cancelled = text.contains("[-]")
          let shape = UIBezierPath(roundedRect: box, cornerRadius: 4)
          (done ? UIColor.systemBlue : UIColor.secondaryLabel).setStroke()
          shape.lineWidth = 1.5
          if done {
            UIColor.systemBlue.setFill()
            shape.fill()
            UIColor.white.setStroke()
            let check = UIBezierPath()
            check.move(to: CGPoint(x: box.minX + box.width * 0.22, y: box.midY))
            check.addLine(
              to: CGPoint(x: box.minX + box.width * 0.43, y: box.minY + box.height * 0.72))
            check.addLine(
              to: CGPoint(x: box.minX + box.width * 0.8, y: box.minY + box.height * 0.28))
            check.lineWidth = 1.7
            check.lineCapStyle = .round
            check.stroke()
          } else {
            shape.stroke()
            if cancelled {
              let line = UIBezierPath()
              line.move(to: CGPoint(x: box.minX + 3, y: box.midY))
              line.addLine(to: CGPoint(x: box.maxX - 3, y: box.midY))
              line.lineWidth = 1.5
              line.stroke()
            }
          }
        case .bullet:
          UIColor.secondaryLabel.setFill()
          UIBezierPath(ovalIn: CGRect(x: box.midX - 2, y: box.midY - 2, width: 4, height: 4)).fill()
        case .agent:
          ("✦" as NSString).draw(
            in: box,
            withAttributes: [
              .font: UIFont.systemFont(ofSize: box.height), .foregroundColor: UIColor.systemBlue,
            ])
        default: break
        }
      }
    }

    /// Coordinates in the text container (before UITextView's inset).
    @MainActor
    func markerRect(at character: Int) -> CGRect? {
      guard let storage = textStorage, character < storage.length,
        let container = textContainers.first
      else { return nil }
      let glyph = glyphIndexForCharacter(at: character)
      guard glyph < numberOfGlyphs else { return nil }
      let rect = boundingRect(forGlyphRange: NSRange(location: glyph, length: 1), in: container)
      let font =
        storage.attribute(.font, at: character, effectiveRange: nil) as? UIFont
        ?? .preferredFont(forTextStyle: .body)
      let side = max(14, font.pointSize * 0.92)
      return CGRect(x: rect.minX + 1, y: rect.midY - side / 2, width: side, height: side)
    }
  }
#endif
