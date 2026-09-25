import AppKit

extension EditorBadge {
  /// Statuses that never get a badge (same as the web editor).
  static let hiddenStatuses: Set<String> = ["idle", "ignored"]

  var isDrawn: Bool { !Self.hiddenStatuses.contains(status) }

  /// Label shortened to about 28 characters.
  var displayLabel: String {
    label.count > 28 ? String(label.prefix(27)).trimmingCharacters(in: .whitespaces) + "…" : label
  }

  /// The unread count for the tooltip (`99+` max); the pill itself shows a dot.
  var unreadText: String? {
    guard unread > 0 else { return nil }
    return unread > 99 ? "99+" : String(unread)
  }
}

/// Lays out, draws and hit-tests agent badges: rounded pills drawn after the end of the last line
/// fragment of their paragraph (in the reserved right margin when the line runs to the edge). How
/// loud a pill is depends on its status (``BadgeStyle``); unread messages add an accent dot.
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
    /// The room the pill was fitted in (a crossfade fits the badge's old look in the same room).
    var available: CGFloat

    init(
      badge: EditorBadge, anchor: Int, rect: NSRect, label: String? = nil,
      available: CGFloat = .greatestFiniteMagnitude
    ) {
      self.badge = badge
      self.anchor = anchor
      self.rect = rect
      self.label = label ?? badge.displayLabel
      self.available = available
    }
  }

  /// Diameter of the unread dot after the label.
  static let unreadDotDiameter: CGFloat = 6

  private(set) var theme: EditorTheme
  private var labelFont: NSFont
  private var widthCache: [String: CGFloat] = [:]
  private var fitCache: [String: (label: String, width: CGFloat)] = [:]

  init(theme: EditorTheme) {
    self.theme = theme
    labelFont = NSFont.systemFont(ofSize: Self.labelSize(theme), weight: .medium)
  }

  func setTheme(_ theme: EditorTheme) {
    self.theme = theme
    labelFont = NSFont.systemFont(ofSize: Self.labelSize(theme), weight: .medium)
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
  private var unreadGap: CGFloat { dotDiameter * 0.6 }

  /// Width of a badge's pill (just the dot and its padding without a label).
  func width(of badge: EditorBadge) -> CGFloat {
    let key = "\(badge.displayLabel)\u{0}\(badge.unread > 0)"
    if let cached = widthCache[key] { return cached }
    var width = padding + dotDiameter + padding
    if !badge.displayLabel.isEmpty {
      width += dotDiameter * 0.8 + labelWidth(badge.displayLabel)
    }
    if badge.unread > 0 { width += unreadGap + Self.unreadDotDiameter }
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
    for items: [BadgeStore.Item], in textView: NSTextView, layoutManager: NSLayoutManager,
    visibleRect: NSRect
  ) -> [Layout] {
    guard !items.isEmpty, let container = textView.textContainer,
      let storage = layoutManager.textStorage
    else {
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
      guard item.lineEnd >= chars.location, item.anchor <= chars.end, item.anchor <= length else {
        continue
      }
      if item.anchor != lastAnchor {
        guard
          let end = lineEndPoint(
            of: item, layoutManager: layoutManager, container: container, length: length)
        else { continue }
        x = origin.x + end.x + gap
        y = (origin.y + end.midY - height / 2).rounded()
        lastAnchor = item.anchor
      } else if result.last?.anchor != item.anchor {
        continue
      }
      let available = rightEdge - x
      let (label, width) = fitted(item.badge, maxWidth: available)
      result.append(
        Layout(
          badge: item.badge, anchor: item.anchor,
          rect: NSRect(x: x, y: y, width: width, height: height), label: label,
          available: available))
      x += width + gap / 2
    }
    return result
  }

  /// The label and pill width for `badge` in at most `maxWidth`: the full display label when it
  /// fits, else a shorter one ending in "…", else no label (just the status and unread dots).
  func fitted(_ badge: EditorBadge, maxWidth: CGFloat) -> (label: String, width: CGFloat) {
    let full = width(of: badge)
    if full <= maxWidth || badge.displayLabel.isEmpty { return (badge.displayLabel, full) }
    let key = "\(badge.displayLabel)\u{0}\(badge.unread > 0)\u{0}\(Int(maxWidth.rounded(.down)))"
    if let cached = fitCache[key] { return cached }
    let result = shortened(badge, fullWidth: full, maxWidth: maxWidth.rounded(.down))
    if fitCache.count > 512 { fitCache.removeAll() }
    fitCache[key] = result
    return result
  }

  private func shortened(_ badge: EditorBadge, fullWidth full: CGFloat, maxWidth: CGFloat) -> (
    label: String, width: CGFloat
  ) {
    let chrome = full - labelWidth(badge.displayLabel)
    var characters = Array(
      badge.displayLabel.hasSuffix("…") ? String(badge.displayLabel.dropLast()) : badge.displayLabel
    )
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
    of item: BadgeStore.Item, layoutManager: NSLayoutManager, container: NSTextContainer,
    length: Int
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

  // MARK: Geometry of motion

  /// The status dot inside a pill.
  func dotRect(in rect: NSRect) -> NSRect {
    NSRect(
      x: rect.minX + padding, y: rect.midY - dotDiameter / 2, width: dotDiameter,
      height: dotDiameter)
  }

  /// Everything a badge may cover while it moves: its pill, the pill 2 pt lower (settling in) and
  /// the pill of its old look (crossfading).
  func motionRect(of layout: Layout, previous: EditorBadge?) -> NSRect {
    var rect = layout.rect.union(layout.rect.offsetBy(dx: 0, dy: MotionTimeline.appearDistance))
    if let previous {
      let old = NSRect(
        origin: layout.rect.origin,
        size: NSSize(width: fitted(previous, maxWidth: layout.available).width, height: height))
      rect = rect.union(old)
    }
    return rect.insetBy(dx: -1, dy: -1)
  }

  // MARK: Drawing

  /// Draws the badges that intersect `dirtyRect`; `paint` gives each one's motion (default: at rest).
  func draw(
    _ layouts: [Layout], hovered: String?, dirtyRect: NSRect,
    paint: (Layout) -> BadgePaint = { _ in .rest }
  ) {
    guard let context = NSGraphicsContext.current?.cgContext else { return }
    for layout in layouts {
      let frame = paint(layout)
      let covered = frame == .rest ? layout.rect : motionRect(of: layout, previous: frame.previous)
      guard covered.intersects(dirtyRect) else { continue }
      draw(layout, paint: frame, isHovered: layout.badge.id == hovered, context: context)
    }
  }

  private func draw(_ layout: Layout, paint: BadgePaint, isHovered: Bool, context: CGContext) {
    let origin = NSPoint(x: layout.rect.minX, y: layout.rect.minY + paint.offsetY)
    if let previous = paint.previous, paint.previousOpacity > 0 {
      let (label, width) = fitted(previous, maxWidth: layout.available)
      drawPill(
        previous, label: label,
        in: NSRect(origin: origin, size: NSSize(width: width, height: height)),
        isHovered: isHovered,
        opacity: paint.opacity * paint.previousOpacity, dotOpacity: 1, context: context)
    }
    drawPill(
      layout.badge, label: layout.label, in: NSRect(origin: origin, size: layout.rect.size),
      isHovered: isHovered,
      opacity: paint.opacity * (1 - paint.previousOpacity), dotOpacity: paint.dotOpacity,
      context: context)
  }

  /// One pill; below full opacity it's composited as a whole (a transparency layer), so its fill,
  /// border and text don't show through each other.
  private func drawPill(
    _ badge: EditorBadge, label: String, in rect: NSRect, isHovered: Bool, opacity: CGFloat,
    dotOpacity: CGFloat,
    context: CGContext
  ) {
    guard opacity > 0.001 else { return }
    let layered = opacity < 0.999
    if layered {
      context.saveGState()
      context.setAlpha(opacity)
      context.beginTransparencyLayer(in: rect.insetBy(dx: -1, dy: -1), auxiliaryInfo: nil)
    }
    let style = BadgeStyle(status: badge.status, isHovered: isHovered)
    let pill = NSBezierPath(
      roundedRect: rect.insetBy(dx: 0.5, dy: 0.5), xRadius: rect.height / 2,
      yRadius: rect.height / 2)
    if let fill = style.fill {
      fill.setFill()
      pill.fill()
    }
    if let border = style.border {
      border.setStroke()
      pill.lineWidth = 1
      pill.stroke()
    }

    let dot = dotRect(in: rect)
    context.saveGState()
    context.setAlpha(dotOpacity)
    style.dot.setFill()
    NSBezierPath(ovalIn: dot).fill()
    context.restoreGState()

    var x = dot.maxX
    if !label.isEmpty {
      x += dotDiameter * 0.8
      let attributes: [NSAttributedString.Key: Any] = [
        .font: labelFont, .foregroundColor: style.text,
      ]
      let size = (label as NSString).size(withAttributes: attributes)
      (label as NSString).draw(
        at: NSPoint(x: x, y: rect.midY - size.height / 2), withAttributes: attributes)
      x += labelWidth(label)
    }
    if badge.unread > 0 {
      let diameter = Self.unreadDotDiameter
      EditorColors.accent.setFill()
      NSBezierPath(
        ovalIn: NSRect(
          x: x + unreadGap, y: rect.midY - diameter / 2, width: diameter, height: diameter)
      ).fill()
    }
    if layered {
      context.endTransparencyLayer()
      context.restoreGState()
    }
  }

  private func labelWidth(_ label: String) -> CGFloat {
    ceil((label as NSString).size(withAttributes: [.font: labelFont]).width)
  }

  /// Tooltip for a badge: its own tooltip or its full label (the pill may shorten it), and the
  /// unread count, worded like the web app's badges.
  static func toolTip(for badge: EditorBadge) -> String {
    let text = badge.tooltip ?? badge.label
    guard let unread = badge.unreadText else { return text }
    return "\(text) · \(unread) unread"
  }
}
