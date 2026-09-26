import AppKit
import DailyDoListUI

extension NSAttributedString.Key {
  /// A numbered citation (`[1](url)`), drawn as a small chip.
  static let agentCitation = NSAttributedString.Key("DDLAgentCitation")
}

/// How a block of agent text is set.
enum RichTextStyle: Hashable, Sendable {
  case body
  case heading(level: Int)
  case quote

  /// SwiftUI's macOS text styles: body 13 pt; title2, title3 and headline for headings.
  var baseFont: NSFont {
    switch self {
    case .body, .quote: .systemFont(ofSize: 13)
    case .heading(let level):
      level == 1
        ? .systemFont(ofSize: 17, weight: .bold)
        : level == 2
          ? .systemFont(ofSize: 15, weight: .semibold) : .systemFont(ofSize: 13, weight: .semibold)
    }
  }

  var color: NSColor { self == .quote ? NSColor(Theme.mutedText) : NSColor(Theme.text) }
}

/// Agent markdown (an `AttributedString` from `MarkdownRenderer`) as TextKit attributes: fonts for
/// emphasis and code, links in the accent color, and citations as superscript chips.
enum AgentRichText {
  /// Room on each side of a citation for its chip.
  static let citationPadding: CGFloat = 4
  static let citationBaselineOffset: CGFloat = 4

  static func attributed(_ text: AttributedString, style: RichTextStyle) -> NSAttributedString {
    let paragraph = NSMutableParagraphStyle()
    paragraph.lineSpacing = 2
    paragraph.lineBreakMode = .byWordWrapping
    let result = NSMutableAttributedString()
    var citations: [NSRange] = []
    for run in text.runs {
      let string = String(text[run.range].characters)
      guard !string.isEmpty else { continue }
      let intent = run.inlinePresentationIntent ?? []
      var attributes: [NSAttributedString.Key: Any] = [
        .font: font(for: intent, style: style), .foregroundColor: style.color,
        .paragraphStyle: paragraph,
      ]
      if intent.contains(.strikethrough) {
        attributes[.strikethroughStyle] = NSUnderlineStyle.single.rawValue
      }
      if let link = run.link {
        attributes[.link] = link
        attributes[.foregroundColor] = NSColor(Theme.accent)
        if LinkPreview.isCitationLabel(string) {
          attributes[.font] = NSFont.systemFont(ofSize: 9.5, weight: .semibold)
          attributes[.baselineOffset] = citationBaselineOffset
          attributes[.agentCitation] = true
          citations.append(NSRange(location: result.length, length: (string as NSString).length))
        } else {
          attributes[.underlineStyle] = NSUnderlineStyle.single.rawValue
          attributes[.underlineColor] = NSColor(Theme.accent).withAlphaComponent(0.5)
        }
      }
      result.append(NSAttributedString(string: string, attributes: attributes))
    }
    // Kerning after the character before a chip (unless it's a blank) and after its last digit
    // makes room for the chip's padding.
    let text = result.string as NSString
    for citation in citations {
      if citation.location > 0, text.character(at: citation.location - 1) != 0x20 {
        result.addAttribute(
          .kern, value: citationPadding + 1,
          range: NSRange(location: citation.location - 1, length: 1))
      }
      result.addAttribute(
        .kern, value: citationPadding + 1,
        range: NSRange(location: citation.location + citation.length - 1, length: 1))
    }
    return result
  }

  private static func font(for intent: InlinePresentationIntent, style: RichTextStyle) -> NSFont {
    var font = style.baseFont
    if intent.contains(.code) {
      font = .monospacedSystemFont(ofSize: font.pointSize - 1, weight: .regular)
    }
    var traits: NSFontDescriptor.SymbolicTraits = []
    if intent.contains(.stronglyEmphasized) { traits.insert(.bold) }
    if intent.contains(.emphasized) { traits.insert(.italic) }
    guard !traits.isEmpty else { return font }
    let descriptor = font.fontDescriptor.withSymbolicTraits(
      font.fontDescriptor.symbolicTraits.union(traits))
    return NSFont(descriptor: descriptor, size: font.pointSize) ?? font
  }
}
