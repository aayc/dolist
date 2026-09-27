#if canImport(UIKit)
  import DailyDoListEditorCore
  import UIKit

  @MainActor
  struct MobileMarkdownStyle {
    var fontSize: Double
    var bodyFont: UIFont {
      UIFontMetrics(forTextStyle: .body).scaledFont(for: .systemFont(ofSize: fontSize))
    }
    var checkboxSlotWidth: CGFloat { bodyFont.pointSize * 1.5 }
    func agentSlotWidth(font: UIFont) -> CGFloat { font.pointSize }
    func bulletSlotWidth(_ character: UInt16, font: UIFont) -> CGFloat { font.pointSize }

    func attributes(kind: LineKind, style: InlineStyle, marker: MarkerKind?)
      -> [NSAttributedString.Key: Any]
    {
      var font = bodyFont
      var color = UIColor.label
      var traits: UIFontDescriptor.SymbolicTraits = []
      let paragraph = NSMutableParagraphStyle()
      paragraph.lineSpacing = 4
      paragraph.paragraphSpacing = 3
      if case .heading(let level) = kind {
        font = UIFontMetrics(forTextStyle: .headline).scaledFont(
          for: .systemFont(ofSize: fontSize + Double(7 - level) * 1.5, weight: .semibold))
        paragraph.paragraphSpacingBefore = 8
        paragraph.paragraphSpacing = 6
      }
      if kind.isLiteral || style.contains(.code) {
        font = UIFontMetrics(forTextStyle: .body).scaledFont(
          for: .monospacedSystemFont(ofSize: fontSize * 0.92, weight: .regular))
      }
      if style.contains(.bold) { traits.insert(.traitBold) }
      if style.contains(.italic) { traits.insert(.traitItalic) }
      if !traits.isEmpty, let descriptor = font.fontDescriptor.withSymbolicTraits(traits) {
        font = UIFont(descriptor: descriptor, size: font.pointSize)
      }
      if style.contains(.link) || style.contains(.wikilink) || style.contains(.agent) {
        color = .systemBlue
      }
      if style.contains(.taskDone) || style.contains(.taskCancelled) { color = .secondaryLabel }
      if marker != nil { color = .tertiaryLabel }
      var values: [NSAttributedString.Key: Any] = [
        .font: font, .foregroundColor: color, .paragraphStyle: paragraph,
      ]
      if style.contains(.highlight) {
        values[.backgroundColor] = UIColor.systemYellow.withAlphaComponent(0.3)
      }
      if style.contains(.code) { values[.backgroundColor] = UIColor.secondarySystemBackground }
      if style.contains(.strikethrough) || style.contains(.taskDone)
        || style.contains(.taskCancelled)
      {
        values[.strikethroughStyle] = NSUnderlineStyle.single.rawValue
      }
      if let marker { values[.ddlMarker] = marker.rawValue }
      return values
    }
  }
#endif
