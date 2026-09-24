import AppKit

/// Draws what isn't glyphs: backgrounds, bars and rules (behind the text) and checkboxes, bullets
/// and agent sparkles (in the slots reserved by `GlyphLayoutDelegate`). Everything is derived from
/// the text storage attributes and the current layout, so drawing only ever touches the visible
/// glyphs.
@MainActor
final class DecorationRenderer {
  var theme: EditorTheme
  /// Checkmarks popping in.
  weak var motion: EditorMotion?
  /// Start of the agent marker whose sparkle is under the pointer (drawn stronger).
  var hoveredSparkle: Int?
  private let livePreview: LivePreviewState
  private var symbolCache: [SymbolKey: NSImage] = [:]

  private struct SymbolKey: Hashable {
    var name: String
    var pointSize: CGFloat
  }

  /// Geometry of a replaced marker (checkbox or bullet) in text-container coordinates.
  struct Slot {
    var rect: NSRect
    var baseline: CGFloat
    var font: NSFont
  }

  init(theme: EditorTheme, livePreview: LivePreviewState) {
    self.theme = theme
    self.livePreview = livePreview
  }

  // MARK: Backgrounds

  func drawBackground(in layoutManager: MarkdownLayoutManager, glyphRange: NSRange, origin: NSPoint)
  {
    guard glyphRange.length > 0, let storage = layoutManager.textStorage,
      let container = layoutManager.textContainers.first
    else { return }
    let charRange = layoutManager.characterRange(forGlyphRange: glyphRange, actualGlyphRange: nil)
    guard charRange.length > 0 else { return }
    let length = storage.length
    layoutManager.enumerateLineFragments(forGlyphRange: glyphRange) {
      rect, usedRect, _, fragment, _ in
      let first = layoutManager.characterIndexForGlyph(at: fragment.location)
      guard first < length else { return }
      let attributes = storage.attributes(at: first, effectiveRange: nil)
      let box = NSRect(x: rect.minX, y: usedRect.minY, width: rect.width, height: usedRect.height)
        .offsetBy(dx: origin.x, dy: origin.y)
      if attributes[.ddlCodeBlock] != nil {
        let last = layoutManager.characterIndexForGlyph(at: fragment.end - 1)
        self.drawCodeBlock(box, storage: storage, first: first, last: last)
      }
      if let depth = (attributes[.ddlQuoteDepth] as? NSNumber)?.intValue, depth > 0 {
        self.drawQuoteBars(rect.offsetBy(dx: origin.x, dy: origin.y), depth: depth)
      }
      if attributes[.ddlHorizontalRule] != nil, self.livePreview.isEnabled,
        !self.livePreview.isLineRevealed(containing: first)
      {
        let depth = (attributes[.ddlQuoteDepth] as? NSNumber)?.intValue ?? 0
        self.drawRule(
          box, indent: CGFloat(min(depth, self.theme.maxQuoteIndentLevels)) * self.theme.quoteIndent
        )
      }
    }
    drawPills(
      .ddlInlineCode, color: EditorColors.codeBackground, layoutManager, storage, container,
      charRange, origin)
    drawPills(
      .ddlTag, color: EditorColors.tagBackground, layoutManager, storage, container, charRange,
      origin)
    drawPills(
      .ddlHighlight, color: EditorColors.highlightBackground, layoutManager, storage, container,
      charRange, origin)
  }

  private func drawCodeBlock(_ box: NSRect, storage: NSTextStorage, first: Int, last: Int) {
    let text = storage.mutableString
    let radius = (theme.fontSize * 0.35).rounded()
    let startsBlock =
      (first == 0 || text.character(at: first - 1) == UTF16Unit.newline)
      && (first == 0 || storage.attribute(.ddlCodeBlock, at: first - 1, effectiveRange: nil) == nil)
    let endsLine = last >= storage.length - 1 || text.character(at: last) == UTF16Unit.newline
    let endsBlock =
      endsLine
      && (last + 1 >= storage.length
        || storage.attribute(.ddlCodeBlock, at: last + 1, effectiveRange: nil) == nil)
    EditorColors.codeBlockBackground.setFill()
    Self.roundedRect(box, top: startsBlock ? radius : 0, bottom: endsBlock ? radius : 0).fill()
  }

  private func drawQuoteBars(_ rect: NSRect, depth: Int) {
    EditorColors.quoteBar.setFill()
    let width = max(2, (theme.fontSize * 0.16).rounded())
    for level in 0..<min(depth, theme.maxQuoteIndentLevels) {
      let x = rect.minX + CGFloat(level) * theme.quoteIndent + 1
      NSRect(x: x, y: rect.minY, width: width, height: rect.height).fill()
    }
  }

  private func drawRule(_ box: NSRect, indent: CGFloat) {
    EditorColors.rule.setFill()
    let y = (box.midY - 0.5).rounded(.down)
    NSRect(x: box.minX + indent, y: y, width: max(0, box.width - indent), height: 1).fill()
  }

  private func drawPills(
    _ key: NSAttributedString.Key, color: NSColor, _ layoutManager: MarkdownLayoutManager,
    _ storage: NSTextStorage,
    _ container: NSTextContainer, _ charRange: NSRange, _ origin: NSPoint
  ) {
    storage.enumerateAttribute(key, in: charRange) { value, run, _ in
      guard value != nil else { return }
      let glyphs = layoutManager.glyphRange(forCharacterRange: run, actualCharacterRange: nil)
      guard glyphs.length > 0 else { return }
      layoutManager.enumerateLineFragments(forGlyphRange: glyphs) { rect, _, _, fragment, _ in
        let piece = NSIntersectionRange(fragment, glyphs)
        guard piece.length > 0 else { return }
        let bounds = layoutManager.boundingRect(forGlyphRange: piece, in: container)
        guard bounds.width > 0.5 else { return }
        let baseline = rect.minY + layoutManager.location(forGlyphAt: piece.location).y
        let index = layoutManager.characterIndexForGlyph(at: piece.location)
        let font =
          storage.attribute(.font, at: index, effectiveRange: nil) as? NSFont ?? self.theme.bodyFont
        let top = baseline - font.ascender - 1
        let bottom = baseline - font.descender + 1
        let pill = NSRect(x: bounds.minX - 3, y: top, width: bounds.width + 6, height: bottom - top)
          .offsetBy(dx: origin.x, dy: origin.y)
        color.setFill()
        NSBezierPath(roundedRect: pill, xRadius: 4, yRadius: 4).fill()
      }
    }
  }

  // MARK: Checkboxes, bullets and sparkles

  func drawReplacements(
    in layoutManager: MarkdownLayoutManager, glyphRange: NSRange, origin: NSPoint
  ) {
    guard livePreview.isEnabled, glyphRange.length > 0, let storage = layoutManager.textStorage
    else { return }
    let charRange = layoutManager.characterRange(forGlyphRange: glyphRange, actualGlyphRange: nil)
    guard charRange.length > 0 else { return }
    let text = storage.mutableString
    storage.enumerateAttribute(.ddlMarker, in: charRange) { value, run, _ in
      guard let raw = value as? Int, let kind = MarkerKind(rawValue: raw), kind.isReplacement else {
        return
      }
      var full = run
      _ = storage.attribute(.ddlMarker, at: run.location, effectiveRange: &full)
      guard full.location == run.location,
        let slot = self.slot(forMarker: full, kind: kind, in: layoutManager)
      else { return }
      let rect = slot.rect.offsetBy(dx: origin.x, dy: origin.y)
      let baseline = slot.baseline + origin.y
      if kind == .task, full.length >= 3 {
        let statusOffset = full.end - 2
        self.drawCheckbox(
          status: text.character(at: statusOffset),
          in: self.checkboxRect(inSlot: rect, baseline: baseline, font: slot.font),
          check: self.motion?.checkPaint(statusOffset: statusOffset))
      } else if kind == .bullet {
        self.drawBullet(inSlot: rect, baseline: baseline, font: slot.font)
      } else if kind == .agent {
        let color =
          self.hoveredSparkle == full.location ? EditorColors.accentStrong : EditorColors.accent
        self.drawSymbol(
          "sparkle", color: color,
          in: self.sparkleRect(inSlot: rect, baseline: baseline, font: slot.font))
      }
    }
  }

  /// The sparkle inside an agent marker's slot: centered, on the middle of the x-height.
  func sparkleRect(inSlot slot: NSRect, baseline: CGFloat, font: NSFont) -> NSRect {
    let size = (font.pointSize * 0.8).rounded()
    let centerY = baseline - font.xHeight / 2
    return NSRect(
      x: (slot.midX - size / 2).rounded(), y: (centerY - size / 2).rounded(), width: size,
      height: size)
  }

  /// The reserved slot of a replaced marker, or nil while the marker shows as text.
  func slot(forMarker marker: NSRange, kind: MarkerKind, in layoutManager: MarkdownLayoutManager)
    -> Slot?
  {
    guard let storage = layoutManager.textStorage,
      let container = layoutManager.textContainers.first,
      marker.location < storage.length, livePreview.isHidden(kind, range: marker)
    else { return nil }
    let glyph = layoutManager.glyphIndexForCharacter(at: marker.location)
    guard glyph < layoutManager.numberOfGlyphs,
      layoutManager.propertyForGlyph(at: glyph) == .controlCharacter
    else {
      return nil
    }
    let bounds = layoutManager.boundingRect(
      forGlyphRange: NSRange(location: glyph, length: 1), in: container)
    let fragment = layoutManager.lineFragmentRect(forGlyphAt: glyph, effectiveRange: nil)
    let baseline = fragment.minY + layoutManager.location(forGlyphAt: glyph).y
    let font =
      storage.attribute(.font, at: marker.location, effectiveRange: nil) as? NSFont
      ?? theme.bodyFont
    return Slot(rect: bounds, baseline: baseline, font: font)
  }

  /// The checkbox square inside a slot: left-aligned, centered on the cap height.
  func checkboxRect(inSlot slot: NSRect, baseline: CGFloat, font: NSFont) -> NSRect {
    let size = theme.checkboxSize
    let centerY = baseline - font.capHeight / 2
    return NSRect(x: slot.minX, y: (centerY - size / 2).rounded(), width: size, height: size)
  }

  private func drawBullet(inSlot slot: NSRect, baseline: CGFloat, font: NSFont) {
    let diameter = theme.bulletDiameter
    let centerY = baseline - font.xHeight / 2
    EditorColors.bullet.setFill()
    NSBezierPath(
      ovalIn: NSRect(
        x: slot.midX - diameter / 2, y: centerY - diameter / 2, width: diameter, height: diameter)
    )
    .fill()
  }

  static func checkboxSymbol(for status: UInt16) -> (name: String, color: NSColor) {
    switch status {
    case UTF16Unit.space: ("square", EditorColors.accent)
    case UTF16Unit.lowerX, UTF16Unit.upperX: ("checkmark.square.fill", EditorColors.accent)
    case UTF16Unit.slash: ("square.lefthalf.filled", EditorColors.accent)
    case UTF16Unit.dash: ("minus.square", EditorColors.tertiaryText)
    case UTF16Unit.greaterThan: ("arrow.right.square", EditorColors.accent)
    case UTF16Unit.lessThan: ("arrow.left.square", EditorColors.accent)
    case UTF16Unit.question: ("questionmark.square", EditorColors.accent)
    case UTF16Unit.bang: ("exclamationmark.square", EditorColors.warning)
    default: ("square.dashed", EditorColors.accent)
    }
  }

  /// A checkbox; while `check` pops a checkmark in, the checkmark grows and fades in over the open
  /// box it replaces.
  private func drawCheckbox(status: UInt16, in rect: NSRect, check: CheckPaint?) {
    guard let check, let context = NSGraphicsContext.current?.cgContext else {
      drawCheckbox(status: status, in: rect)
      return
    }
    drawCheckbox(status: UTF16Unit.space, in: rect)
    context.saveGState()
    context.setAlpha(check.opacity)
    context.translateBy(x: rect.midX, y: rect.midY)
    context.scaleBy(x: check.scale, y: check.scale)
    context.translateBy(x: -rect.midX, y: -rect.midY)
    drawCheckbox(status: status, in: rect)
    context.restoreGState()
  }

  private func drawCheckbox(status: UInt16, in rect: NSRect) {
    let (name, color) = Self.checkboxSymbol(for: status)
    guard drawSymbol(name, color: color, in: rect) else {
      color.setStroke()
      let path = NSBezierPath(roundedRect: rect.insetBy(dx: 1.5, dy: 1.5), xRadius: 3, yRadius: 3)
      path.lineWidth = 1.5
      path.stroke()
      return
    }
  }

  /// An SF Symbol fitted in `rect` and tinted with `color`; false when the symbol is unavailable.
  @discardableResult
  private func drawSymbol(_ name: String, color: NSColor, in rect: NSRect) -> Bool {
    guard let image = symbol(name, pointSize: rect.height),
      let context = NSGraphicsContext.current?.cgContext
    else {
      return false
    }
    let scale = min(rect.width / max(image.size.width, 1), rect.height / max(image.size.height, 1))
    let size = NSSize(width: image.size.width * scale, height: image.size.height * scale)
    let fitted = NSRect(
      x: rect.midX - size.width / 2, y: rect.midY - size.height / 2, width: size.width,
      height: size.height)
    context.saveGState()
    context.beginTransparencyLayer(in: fitted.insetBy(dx: -1, dy: -1), auxiliaryInfo: nil)
    image.draw(
      in: fitted, from: .zero, operation: .sourceOver, fraction: 1, respectFlipped: true, hints: nil
    )
    color.setFill()
    fitted.insetBy(dx: -1, dy: -1).fill(using: .sourceAtop)
    context.endTransparencyLayer()
    context.restoreGState()
    return true
  }

  private func symbol(_ name: String, pointSize: CGFloat) -> NSImage? {
    let key = SymbolKey(name: name, pointSize: pointSize)
    if let cached = symbolCache[key] { return cached }
    let configuration = NSImage.SymbolConfiguration(pointSize: pointSize, weight: .regular)
    guard
      let image = NSImage(systemSymbolName: name, accessibilityDescription: nil)?
        .withSymbolConfiguration(configuration)
    else { return nil }
    symbolCache[key] = image
    return image
  }

  /// A rectangle with independently rounded top and bottom corners (flipped coordinates).
  static func roundedRect(_ r: NSRect, top: CGFloat, bottom: CGFloat) -> NSBezierPath {
    let path = NSBezierPath()
    path.move(to: NSPoint(x: r.minX + top, y: r.minY))
    path.line(to: NSPoint(x: r.maxX - top, y: r.minY))
    if top > 0 {
      path.appendArc(
        from: NSPoint(x: r.maxX, y: r.minY), to: NSPoint(x: r.maxX, y: r.minY + top), radius: top)
    }
    path.line(to: NSPoint(x: r.maxX, y: r.maxY - bottom))
    if bottom > 0 {
      path.appendArc(
        from: NSPoint(x: r.maxX, y: r.maxY), to: NSPoint(x: r.maxX - bottom, y: r.maxY),
        radius: bottom)
    }
    path.line(to: NSPoint(x: r.minX + bottom, y: r.maxY))
    if bottom > 0 {
      path.appendArc(
        from: NSPoint(x: r.minX, y: r.maxY), to: NSPoint(x: r.minX, y: r.maxY - bottom),
        radius: bottom)
    }
    path.line(to: NSPoint(x: r.minX, y: r.minY + top))
    if top > 0 {
      path.appendArc(
        from: NSPoint(x: r.minX, y: r.minY), to: NSPoint(x: r.minX + top, y: r.minY), radius: top)
    }
    path.close()
    return path
  }
}
