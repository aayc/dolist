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

    /// Inline formatting for table cells and callout titles. Syntax is removed only from this
    /// presentation copy; ranges in the document remain untouched.
    func contentText(_ source: String, bold: Bool = false) -> NSAttributedString {
      let units = Array(source.utf16)
      var inline = InlineTokenizer(units, from: 0, to: units.count)
      inline.run()
      var tokens = LineTokens(kind: .paragraph)
      tokens.spans = inline.spans
      tokens.markers = inline.markers
      let value = NSMutableAttributedString(
        string: source,
        attributes: attributes(kind: .paragraph, style: bold ? [.bold] : [], marker: nil))
      var position = 0
      for segment in StyleSegments.build(tokens, length: units.count) {
        var style = segment.style
        if bold { style.insert(.bold) }
        value.setAttributes(
          attributes(kind: .paragraph, style: style, marker: nil),
          range: NSRange(location: position, length: segment.length))
        position += segment.length
      }
      for marker in tokens.markers.sorted(by: { $0.range.location > $1.range.location })
      where marker.range.end <= value.length {
        value.deleteCharacters(in: marker.range)
      }
      return value
    }

    static func calloutColor(_ family: String) -> UIColor {
      switch family {
      case "abstract", "info", "todo": .systemCyan
      case "tip", "success": .systemGreen
      case "question", "warning": .systemOrange
      case "failure", "danger", "bug": .systemRed
      case "example": .systemPurple
      case "quote": .secondaryLabel
      default: .systemBlue
      }
    }
    static func calloutSymbol(_ family: String) -> String {
      switch family {
      case "abstract": "list.bullet.rectangle"
      case "info": "info.circle"
      case "todo": "checkmark.circle"
      case "tip": "lightbulb"
      case "success": "checkmark"
      case "question": "questionmark.circle"
      case "warning": "exclamationmark.triangle"
      case "failure": "xmark"
      case "danger": "bolt"
      case "bug": "ant"
      case "example": "list.bullet"
      case "quote": "quote.opening"
      default: "pencil"
      }
    }
  }
#endif
