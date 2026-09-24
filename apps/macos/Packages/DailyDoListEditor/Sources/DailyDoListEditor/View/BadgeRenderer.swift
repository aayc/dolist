import AppKit

extension EditorBadge {
  /// Statuses that never get a badge (same as the web editor).
  static let hiddenStatuses: Set<String> = ["idle", "ignored"]

  var isDrawn: Bool { !Self.hiddenStatuses.contains(status) }

  /// Label shortened to about 28 characters.
  var displayLabel: String {
    label.count > 28 ? String(label.prefix(27)).trimmingCharacters(in: .whitespaces) + "…" : label
  }

  var unreadText: String? {
    guard unread > 0 else { return nil }
    return unread > 99 ? "99+" : String(unread)
  }
}

/// Lays out, draws and hit-tests agent badges: rounded pills drawn after the end of the last line
/// fragment of their paragraph (in the reserved right margin when the line runs to the edge).
@MainActor
final class BadgeRenderer {
  struct Layout: Equatable {
    var badge: EditorBadge
    /// Start of the badge's line (maps it to the current line number).
    var anchor: Int
    /// Pill frame in text-view coordinates.
    var rect: NSRect
    /// The label as drawn: `displayLabel`, shortened further (or empty) when the pill had to
    /// shrink to fit a narrow editor.
    var label: String

    init(badge: EditorBadge, anchor: Int, rect: NSRect, label: String? = nil) {
      self.badge = badge
      self.anchor = anchor
      self.rect = rect
      self.label = label ?? badge.displayLabel
    }
  }

  private(set) var theme: EditorTheme
  private var labelFont: NSFont
  private var unreadFont: NSFont
  private var widthCache: [String: CGFloat] = [:]
  private var fitCache: [String: (label: String, width: CGFloat)] = [:]

  init(theme: EditorTheme) {
    self.theme = theme
    labelFont = NSFont.systemFont(ofSize: Self.labelSize(theme), weight: .medium)
    unreadFont = NSFont.systemFont(ofSize: (Self.labelSize(theme) * 0.85).rounded(), weight: .semibold)
  }

  func setTheme(_ theme: EditorTheme) {
    self.theme = theme
    labelFont = NSFont.systemFont(ofSize: Self.labelSize(theme), weight: .medium)
    unreadFont = NSFont.systemFont(ofSize: (Self.labelSize(theme) * 0.85).rounded(), weight: .semibold)
    widthCache.removeAll()
    fitCache.removeAll()
  }

  private static func labelSize(_ theme: EditorTheme) -> CGFloat {
    max(9, (theme.fontSize * 0.72 * 2).rounded() / 2)
  }

  var height: CGFloat { (theme.fontSize * 1.2).rounded() }
  var gap: CGFloat { (theme.fontSize * 0.6).rounded() }
  private var padding: CGFloat { (labelFont.pointSize * 0.7).rounded() }
  private var dotDiameter: CGFloat { (labelFont.pointSize * 0.6).rounded() }
  private var unreadHeight: CGFloat { (labelFont.pointSize * 1.3).rounded() }

  /// Width of a badge's pill.
  func width(of badge: EditorBadge) -> CGFloat {
    let key = "\(badge.displayLabel)\u{0}\(badge.unreadText ?? "")"
    if let cached = widthCache[key] { return cached }
    var width = padding + dotDiameter + dotDiameter * 0.8 + labelWidth(badge.displayLabel) + padding
    if let unread = badge.unreadText { width += unreadWidth(unread) + dotDiameter * 0.6 }
    widthCache[key] = ceil(width)
    return ceil(width)
  }

  /// Widest row of badges sharing a line (what the right margin must fit).
  func widestRow(_ items: [BadgeStore.Item]) -> CGFloat {
    var widest: CGFloat = 0
    var index = 0
    while index < items.count {
      var row: CGFloat = 0
      let anchor = items[index].anchor
      while index < items.count, items[index].anchor == anchor {
        if items[index].badge.isDrawn { row += width(of: items[index].badge) + gap }
        index += 1
      }
      widest = max(widest, row)
    }
    return widest
  }

  /// Layouts of the drawn badges whose line intersects `visibleRect` (text-view coordinates).
  func layouts(
    for items: [BadgeStore.Item], in textView: NSTextView, layoutManager: NSLayoutManager, visibleRect: NSRect
  ) -> [Layout] {
    guard !items.isEmpty, let container = textView.textContainer, let storage = layoutManager.textStorage else {
      return []
    }
    let origin = textView.textContainerOrigin
    let visible = visibleRect.offsetBy(dx: -origin.x, dy: -origin.y)
    let glyphs = layoutManager.glyphRange(forBoundingRect: visible, in: container)
    let chars = layoutManager.characterRange(forGlyphRange: glyphs, actualGlyphRange: nil)
    let length = storage.length
    let rightEdge = min(textView.bounds.maxX, visibleRect.maxX) - gap / 2
    var result: [Layout] = []
    var x: CGFloat = 0
    var y: CGFloat = 0
    var lastAnchor = -1
    for item in items where item.badge.isDrawn {
      guard item.lineEnd >= chars.location, item.anchor <= chars.end, item.anchor <= length else { continue }
      if item.anchor != lastAnchor {
        guard let end = lineEndPoint(of: item, layoutManager: layoutManager, container: container, length: length)
        else { continue }
        x = origin.x + end.x + gap
        y = (origin.y + end.midY - height / 2).rounded()
        lastAnchor = item.anchor
      } else if result.last?.anchor != item.anchor {
        continue
      }
      let (label, width) = fitted(item.badge, maxWidth: rightEdge - x)
      result.append(
        Layout(badge: item.badge, anchor: item.anchor, rect: NSRect(x: x, y: y, width: width, height: height), label: label))
      x += width + gap / 2
    }
    return result
  }

  /// The label and pill width for `badge` in at most `maxWidth`: the full display label when it
  /// fits, else a shorter one ending in "…", else no label (just the status dot and unread count).
  func fitted(_ badge: EditorBadge, maxWidth: CGFloat) -> (label: String, width: CGFloat) {
    let full = width(of: badge)
    if full <= maxWidth { return (badge.displayLabel, full) }
    let key = "\(badge.displayLabel)\u{0}\(badge.unreadText ?? "")\u{0}\(Int(maxWidth.rounded(.down)))"
    if let cached = fitCache[key] { return cached }
    let result = shortened(badge, fullWidth: full, maxWidth: maxWidth.rounded(.down))
    if fitCache.count > 512 { fitCache.removeAll() }
    fitCache[key] = result
    return result
  }

  private func shortened(_ badge: EditorBadge, fullWidth full: CGFloat, maxWidth: CGFloat) -> (label: String, width: CGFloat) {
    let chrome = full - labelWidth(badge.displayLabel)
    var characters = Array(badge.displayLabel.hasSuffix("…") ? String(badge.displayLabel.dropLast()) : badge.displayLabel)
    while !characters.isEmpty {
      characters.removeLast()
      let label = String(characters).trimmingCharacters(in: .whitespaces) + "…"
      let width = ceil(chrome + labelWidth(label))
      if !characters.isEmpty, width <= maxWidth { return (label, width) }
    }
    return ("", ceil(chrome - dotDiameter * 0.8))
  }

  /// End of the text on the last line fragment of the badge's line: x and the vertical center of
  /// the line box (text-container coordinates).
  private func lineEndPoint(
    of item: BadgeStore.Item, layoutManager: NSLayoutManager, container: NSTextContainer, length: Int
  ) -> (x: CGFloat, midY: CGFloat)? {
    let index = item.lineEnd > item.anchor ? item.lineEnd - 1 : item.anchor
    if index >= length {
      let extra = layoutManager.extraLineFragmentUsedRect
      return extra.height > 0 ? (extra.minX, extra.midY) : nil
    }
    let glyph = layoutManager.glyphIndexForCharacter(at: index)
    guard glyph < layoutManager.numberOfGlyphs else { return nil }
    let used = layoutManager.lineFragmentUsedRect(forGlyphAt: glyph, effectiveRange: nil)
    return (used.maxX, used.midY)
  }

  func draw(_ layouts: [Layout], hovered: String?, dirtyRect: NSRect) {
    for layout in layouts where layout.rect.intersects(dirtyRect) {
      draw(layout, isHovered: layout.badge.id == hovered)
    }
  }

  private func draw(_ layout: Layout, isHovered: Bool) {
    let badge = layout.badge
    let rect = layout.rect
    let pill = NSBezierPath(roundedRect: rect.insetBy(dx: 0.5, dy: 0.5), xRadius: rect.height / 2, yRadius: rect.height / 2)
    (isHovered ? EditorColors.badgeHoverBackground : EditorColors.badgeBackground).setFill()
    pill.fill()
    EditorColors.badgeBorder(for: badge.status).setStroke()
    pill.lineWidth = 1
    pill.stroke()

    let dot = NSRect(x: rect.minX + padding, y: rect.midY - dotDiameter / 2, width: dotDiameter, height: dotDiameter)
    EditorColors.badgeStatus(badge.status).setFill()
    NSBezierPath(ovalIn: dot).fill()

    var x: CGFloat
    if !layout.label.isEmpty {
      x = dot.maxX + dotDiameter * 0.8
      let labelColor = isHovered ? EditorColors.text : EditorColors.secondaryText
      let label = layout.label as NSString
      let labelAttributes: [NSAttributedString.Key: Any] = [.font: labelFont, .foregroundColor: labelColor]
      let labelSize = label.size(withAttributes: labelAttributes)
      label.draw(at: NSPoint(x: x, y: rect.midY - labelSize.height / 2), withAttributes: labelAttributes)
      x += labelWidth(layout.label)
    } else {
      x = dot.maxX
    }

    if let unread = badge.unreadText {
      x += dotDiameter * 0.6
      let bubble = NSRect(x: x, y: rect.midY - unreadHeight / 2, width: unreadWidth(unread), height: unreadHeight)
      EditorColors.accent.setFill()
      NSBezierPath(roundedRect: bubble, xRadius: bubble.height / 2, yRadius: bubble.height / 2).fill()
      let attributes: [NSAttributedString.Key: Any] = [.font: unreadFont, .foregroundColor: NSColor.white]
      let size = (unread as NSString).size(withAttributes: attributes)
      (unread as NSString).draw(
        at: NSPoint(x: bubble.midX - size.width / 2, y: bubble.midY - size.height / 2), withAttributes: attributes)
    }
  }

  private func labelWidth(_ label: String) -> CGFloat {
    ceil((label as NSString).size(withAttributes: [.font: labelFont]).width)
  }

  private func unreadWidth(_ text: String) -> CGFloat {
    let textWidth = ceil((text as NSString).size(withAttributes: [.font: unreadFont]).width)
    return max(unreadHeight, textWidth + unreadHeight * 0.6)
  }

  /// Tooltip for a badge: status and full label.
  static func toolTip(for badge: EditorBadge) -> String {
    let status = badge.status.replacingOccurrences(of: "_", with: " ").capitalized
    var text = "\(status): \(badge.label)"
    if let unread = badge.unreadText { text += " · \(unread) unread" }
    return text
  }
}
