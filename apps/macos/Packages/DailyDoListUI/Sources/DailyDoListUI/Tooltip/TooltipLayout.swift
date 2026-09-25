import CoreGraphics

/// Where a tooltip's surface goes, in screen coordinates (y up): centered on the target, 6 pt
/// below or above it, flipped when the preferred side has no room, clamped 8 pt inside `bounds`.
public enum TooltipLayout {
  public struct Result: Equatable, Sendable {
    public var frame: CGRect
    /// The tooltip ended up below its target (it slides down into place).
    public var isBelow: Bool
  }

  /// Whether a target prefers the tooltip below it: controls in a window's top header row do.
  public static func prefersBelow(
    _ placement: TooltipPlacement, anchor: CGRect, windowFrame: CGRect?
  ) -> Bool {
    switch placement {
    case .above: false
    case .below: true
    case .automatic:
      windowFrame.map { anchor.maxY >= $0.maxY - TooltipMetrics.headerBand } ?? false
    }
  }

  public static func place(
    size: CGSize, anchor: CGRect, bounds: CGRect, prefersBelow: Bool,
    gap: CGFloat = TooltipMetrics.gap, margin: CGFloat = TooltipMetrics.margin
  ) -> Result {
    let belowY = anchor.minY - gap - size.height
    let aboveY = anchor.maxY + gap
    let fitsBelow = belowY >= bounds.minY + margin
    let fitsAbove = aboveY + size.height <= bounds.maxY - margin
    let isBelow = prefersBelow ? (fitsBelow || !fitsAbove) : (!fitsAbove && fitsBelow)
    let x = clamp(
      anchor.midX - size.width / 2, bounds.minX + margin, bounds.maxX - margin - size.width)
    let y = clamp(
      isBelow ? belowY : aboveY, bounds.minY + margin, bounds.maxY - margin - size.height)
    return Result(
      frame: CGRect(x: x.rounded(), y: y.rounded(), width: size.width, height: size.height),
      isBelow: isBelow)
  }

  /// `value` within `low…high`; `low` wins when the range is empty (a tooltip wider than bounds).
  private static func clamp(_ value: CGFloat, _ low: CGFloat, _ high: CGFloat) -> CGFloat {
    max(low, min(value, high))
  }
}
