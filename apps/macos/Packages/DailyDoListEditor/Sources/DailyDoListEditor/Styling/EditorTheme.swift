import AppKit

extension NSAttributedString.Key {
  /// `NSNumber(MarkerKind.rawValue)` on markdown syntax that live preview may hide.
  static let ddlMarker = NSAttributedString.Key("DDLMarker")
  /// `LinkAttribute` over a whole link (syntax included).
  static let ddlLink = NSAttributedString.Key("DDLLink")
  /// Inline code span (rounded background).
  static let ddlInlineCode = NSAttributedString.Key("DDLInlineCode")
  /// `#tag` (rounded background).
  static let ddlTag = NSAttributedString.Key("DDLTag")
  /// `==highlight==` (rounded background).
  static let ddlHighlight = NSAttributedString.Key("DDLHighlight")
  /// Fenced code block line, fences included (full-width background).
  static let ddlCodeBlock = NSAttributedString.Key("DDLCodeBlock")
  /// `NSNumber(depth)` on blockquote lines (left bars).
  static let ddlQuoteDepth = NSAttributedString.Key("DDLQuoteDepth")
  /// Horizontal rule line (drawn as a line while its syntax is hidden).
  static let ddlHorizontalRule = NSAttributedString.Key("DDLHorizontalRule")
  /// `NSNumber(CGFloat)`: baseline offset that centers the block's font in its fixed line height.
  static let ddlBaseline = NSAttributedString.Key("DDLBaseline")
}

/// Attribute value identifying a link's target (compared by value).
final class LinkAttribute: NSObject {
  let target: LinkTarget

  init(_ target: LinkTarget) {
    self.target = target
  }

  override func isEqual(_ object: Any?) -> Bool {
    (object as? LinkAttribute)?.target == target
  }

  override var hash: Int { target.hashValue }
}

/// Block-level style of a line.
enum BlockStyle: Hashable, Sendable {
  case body
  case heading(Int)
  case codeBlock
  case codeFence
  case frontmatter
  case frontmatterDelimiter
  case horizontalRule

  init(_ kind: LineKind) {
    switch kind {
    case let .heading(level): self = .heading(min(max(level, 1), 6))
    case .code: self = .codeBlock
    case .codeFenceOpen, .codeFenceClose: self = .codeFence
    case .frontmatter: self = .frontmatter
    case .frontmatterDelimiter: self = .frontmatterDelimiter
    case .horizontalRule: self = .horizontalRule
    case .blank, .paragraph, .listItem: self = .body
    }
  }

  var isMonospaced: Bool {
    switch self {
    case .codeBlock, .codeFence, .frontmatter, .frontmatterDelimiter: true
    default: false
    }
  }
}

/// Everything that determines a text run's attributes.
struct StyleKey: Hashable, Sendable {
  var block: BlockStyle
  var quoteDepth: Int
  var inline: InlineStyle = []
  var marker: MarkerKind?
  /// Indent of a list item's wrapped lines, in quarter points (0 = none).
  var hangingIndent = 0
}

/// Fonts, metrics and attribute dictionaries of the editor, derived from the font size. Attribute
/// dictionaries, fonts and paragraph styles are cached, so restyling a line allocates almost nothing.
@MainActor
final class EditorTheme {
  let fontSize: CGFloat
  let bodyFont: NSFont
  /// Indent per blockquote level (bars are drawn in it).
  let quoteIndent: CGFloat
  /// Horizontal padding inside code blocks.
  let codeInset: CGFloat
  let tabInterval: CGFloat
  /// Width reserved for a task checkbox that replaces `- [ ]`.
  let checkboxSlotWidth: CGFloat
  let checkboxSize: CGFloat
  let bulletDiameter: CGFloat
  /// Deepest blockquote level that still indents.
  let maxQuoteIndentLevels = 6

  private var attributeCache: [StyleKey: [NSAttributedString.Key: Any]] = [:]
  private var fontCache: [FontKey: NSFont] = [:]
  private var paragraphCache: [ParagraphKey: NSParagraphStyle] = [:]
  private var widthCache: [String: CGFloat] = [:]

  private struct FontKey: Hashable {
    var size: CGFloat
    var weight: CGFloat
    var italic: Bool
    var mono: Bool
  }

  private struct ParagraphKey: Hashable {
    var block: BlockStyle
    var quoteDepth: Int
    var hangingIndent: Int
  }

  private static let headingScale: [CGFloat] = [1.6, 1.4, 1.25, 1.1, 1.0, 1.0]
  private static let headingSpacing: [CGFloat] = [0.7, 0.6, 0.5, 0.4, 0.3, 0.3]

  /// Plain-text metrics for tests that pin geometry (the vim vector replay reproduces the web
  /// oracle's viewport): every line in one monospaced font at one fixed height, no heading
  /// scale, spacing or indents, tab stops every `tabSize` columns.
  struct Uniform: Hashable, Sendable {
    var lineHeight: CGFloat
    var tabSize: Int
  }

  let uniform: Uniform?

  init(fontSize: CGFloat, uniform: Uniform? = nil) {
    let size = max(8, min(fontSize, 72))
    self.fontSize = size
    self.uniform = uniform
    if let uniform {
      let mono = NSFont.monospacedSystemFont(ofSize: size, weight: .regular)
      bodyFont = mono
      quoteIndent = 0
      codeInset = 0
      let space = (" " as NSString).size(withAttributes: [.font: mono]).width
      tabInterval = space * CGFloat(max(1, uniform.tabSize))
    } else {
      bodyFont = NSFont.systemFont(ofSize: size)
      quoteIndent = (size * 1.1).rounded()
      codeInset = (size * 0.75).rounded()
      tabInterval = (size * 1.75).rounded()
    }
    checkboxSlotWidth = (size * 1.3).rounded()
    checkboxSize = (size * 1.05).rounded()
    bulletDiameter = max(3, (size * 0.3).rounded())
  }

  /// Width reserved for the sparkle that replaces an agent marker (and the blanks before it) in a
  /// line set in `font`.
  func agentSlotWidth(font: NSFont) -> CGFloat {
    (font.pointSize * 1.25).rounded()
  }

  /// Attributes for text typed where no styling applies yet (and the empty last line).
  var baseAttributes: [NSAttributedString.Key: Any] {
    attributes(for: StyleKey(block: .body, quoteDepth: 0))
  }

  func attributes(for key: StyleKey) -> [NSAttributedString.Key: Any] {
    if let cached = attributeCache[key] { return cached }
    var attributes: [NSAttributedString.Key: Any] = [:]
    let block = key.block
    var size = blockFontSize(block)
    var weight = blockFontWeight(block)
    var mono = block.isMonospaced
    if key.inline.contains(.bold) { weight = block.isHeading ? .heavy : .bold }
    if key.inline.contains(.code), !mono {
      mono = true
      size = (size * 0.92 * 2).rounded() / 2
    }
    attributes[.font] = font(size: size, weight: weight, italic: key.inline.contains(.italic), mono: mono)
    attributes[.foregroundColor] = color(for: key)
    attributes[.paragraphStyle] = paragraphStyle(block: block, quoteDepth: key.quoteDepth, hangingIndent: key.hangingIndent)
    attributes[.ddlBaseline] = NSNumber(value: Double(baselineOffset(block)))
    let tasky = key.inline.contains(.taskDone) || key.inline.contains(.taskCancelled)
    if key.inline.contains(.strikethrough) || (tasky && key.marker == nil) {
      attributes[.strikethroughStyle] = NSUnderlineStyle.single.rawValue
      if tasky { attributes[.strikethroughColor] = EditorColors.tertiaryText }
    }
    if key.inline.contains(.link), key.marker == nil {
      attributes[.underlineStyle] = NSUnderlineStyle.single.rawValue
      attributes[.underlineColor] = EditorColors.linkUnderline
    }
    if let marker = key.marker { attributes[.ddlMarker] = NSNumber(value: marker.rawValue) }
    if key.inline.contains(.code), !block.isMonospaced { attributes[.ddlInlineCode] = true }
    if key.inline.contains(.tag) { attributes[.ddlTag] = true }
    if key.inline.contains(.highlight) { attributes[.ddlHighlight] = true }
    if block == .codeBlock || block == .codeFence { attributes[.ddlCodeBlock] = true }
    if key.quoteDepth > 0 { attributes[.ddlQuoteDepth] = NSNumber(value: key.quoteDepth) }
    if block == .horizontalRule { attributes[.ddlHorizontalRule] = true }
    attributeCache[key] = attributes
    return attributes
  }

  func blockFont(_ block: BlockStyle) -> NSFont {
    font(size: blockFontSize(block), weight: blockFontWeight(block), italic: false, mono: block.isMonospaced)
  }

  func lineHeight(_ block: BlockStyle) -> CGFloat {
    if let uniform { return uniform.lineHeight }
    return switch block {
    case .heading: (blockFontSize(block) * 1.3).rounded()
    case .codeBlock, .codeFence: (fontSize * 1.45).rounded()
    case .frontmatter, .frontmatterDelimiter: (fontSize * 1.35).rounded()
    case .body, .horizontalRule: (fontSize * 1.5).rounded()
    }
  }

  /// Baseline offset from the top of a line box that vertically centers the block's font.
  func baselineOffset(_ block: BlockStyle) -> CGFloat {
    let font = blockFont(block)
    let textHeight = font.ascender - font.descender
    return ((lineHeight(block) - textHeight) / 2 + font.ascender).rounded()
  }

  func paragraphStyle(block: BlockStyle, quoteDepth: Int, hangingIndent: Int = 0) -> NSParagraphStyle {
    let key = ParagraphKey(block: block, quoteDepth: quoteDepth, hangingIndent: hangingIndent)
    if let cached = paragraphCache[key] { return cached }
    let style = NSMutableParagraphStyle()
    let height = lineHeight(block)
    style.minimumLineHeight = height
    style.maximumLineHeight = height
    style.lineBreakMode = .byWordWrapping
    style.defaultTabInterval = tabInterval
    style.tabStops = []
    var indent = CGFloat(min(quoteDepth, maxQuoteIndentLevels)) * quoteIndent
    switch block {
    case let .heading(level) where uniform == nil:
      style.paragraphSpacingBefore = (fontSize * Self.headingSpacing[level - 1]).rounded()
    case .codeBlock, .codeFence:
      indent += codeInset
      style.tailIndent = -codeInset
    default:
      break
    }
    style.firstLineHeadIndent = indent
    style.headIndent = uniform == nil ? max(indent, CGFloat(hangingIndent) / 4) : indent
    paragraphCache[key] = style
    return style
  }

  // MARK: List layout

  /// Width of the slot a replaced bullet takes: the bullet character's own width, so revealing it
  /// doesn't shift the text.
  func bulletSlotWidth(_ character: UInt16, font: NSFont) -> CGFloat {
    max(textWidth(String(utf16Units: [character][...]), font: font), bulletDiameter + 2)
  }

  /// X position (from the line's left edge) where a list item's text starts as live preview draws
  /// it (checkbox and bullet slots) or as raw text, in quarter points: the indent of its wrapped
  /// lines. Tabs advance to the next multiple of the tab interval, like TextKit.
  func hangingIndent(for tokens: LineTokens, units: [UInt16], livePreview: Bool) -> Int {
    guard let list = tokens.listPrefix, list.textStart <= units.count, list.markerEnd <= units.count else { return 0 }
    let font = bodyFont
    var x = CGFloat(min(tokens.quoteDepth, maxQuoteIndentLevels)) * quoteIndent
    func advance(over range: Range<Int>) {
      for i in range where i < units.count {
        if units[i] == UTF16Unit.tab {
          x = ((x / tabInterval).rounded(.down) + 1) * tabInterval
        } else {
          x += textWidth(" ", font: font)
        }
      }
    }
    advance(over: list.indentStart..<list.markerStart)
    let marker = String(utf16Units: units[list.markerStart..<list.markerEnd])
    let isOrdered = !(marker == "-" || marker == "*" || marker == "+")
    if !livePreview {
      x += textWidth(String(utf16Units: units[list.markerStart..<list.textStart]), font: font)
    } else if let box = list.box, box.end <= units.count {
      if isOrdered {
        x += textWidth(marker, font: font)
        advance(over: list.markerEnd..<box.location)
      }
      x += checkboxSlotWidth
      advance(over: box.end..<list.textStart)
    } else {
      x += isOrdered ? textWidth(marker, font: font) : bulletSlotWidth(units[list.markerStart], font: font)
      advance(over: list.markerEnd..<list.textStart)
    }
    return Int((x * 4).rounded())
  }

  private func textWidth(_ text: String, font: NSFont) -> CGFloat {
    let key = "\(font.pointSize)\u{0}\(text)"
    if let cached = widthCache[key] { return cached }
    let width = (text as NSString).size(withAttributes: [.font: font]).width
    widthCache[key] = width
    return width
  }

  private func blockFontSize(_ block: BlockStyle) -> CGFloat {
    if uniform != nil { return fontSize }
    return switch block {
    case let .heading(level): (fontSize * Self.headingScale[level - 1]).rounded()
    case .codeBlock, .codeFence: (fontSize * 0.9 * 2).rounded() / 2
    case .frontmatter, .frontmatterDelimiter: (fontSize * 0.85 * 2).rounded() / 2
    case .body, .horizontalRule: fontSize
    }
  }

  private func blockFontWeight(_ block: BlockStyle) -> NSFont.Weight {
    block.isHeading ? .semibold : .regular
  }

  private func font(size sizeIn: CGFloat, weight: NSFont.Weight, italic: Bool, mono monoIn: Bool) -> NSFont {
    let size = uniform == nil ? sizeIn : fontSize
    let mono = uniform != nil || monoIn
    let key = FontKey(size: size, weight: weight.rawValue, italic: italic, mono: mono)
    if let cached = fontCache[key] { return cached }
    var font =
      mono ? NSFont.monospacedSystemFont(ofSize: size, weight: weight) : NSFont.systemFont(ofSize: size, weight: weight)
    if italic {
      let descriptor = font.fontDescriptor.withSymbolicTraits(font.fontDescriptor.symbolicTraits.union(.italic))
      font = NSFont(descriptor: descriptor, size: size) ?? font
    }
    fontCache[key] = font
    return font
  }

  private func color(for key: StyleKey) -> NSColor {
    if let marker = key.marker {
      return marker == .bullet || marker == .task ? EditorColors.secondaryText : EditorColors.tertiaryText
    }
    if key.inline.contains(.taskCancelled) { return EditorColors.tertiaryText }
    if !key.inline.isDisjoint(with: [.link, .wikilink, .tag]) { return EditorColors.accent }
    if key.inline.contains(.taskDone) || key.inline.contains(.listNumber) { return EditorColors.secondaryText }
    if key.inline.contains(.agent) { return EditorColors.agentText }
    switch key.block {
    case .frontmatter: return EditorColors.secondaryText
    case .frontmatterDelimiter, .codeFence, .horizontalRule: return EditorColors.tertiaryText
    case .heading(6): return EditorColors.secondaryText
    default: return key.quoteDepth > 0 ? EditorColors.secondaryText : EditorColors.text
    }
  }
}

extension BlockStyle {
  var isHeading: Bool {
    if case .heading = self { return true }
    return false
  }
}
