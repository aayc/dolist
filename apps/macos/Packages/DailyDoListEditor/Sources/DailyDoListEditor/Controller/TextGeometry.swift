import CoreGraphics

/// Where the text column goes: centered at a readable width (or full width), leaving room on the
/// right for badges when lines run to the edge of the column.
struct TextGeometry: Equatable {
  /// Left edge of the text container (and top inset).
  var inset: CGSize
  var columnWidth: CGFloat

  static let maxReadableWidth: CGFloat = 700
  static let minColumnWidth: CGFloat = 120
  /// A text container this wide never wraps a line (plain-text test metrics).
  static let unwrappedWidth: CGFloat = 1_000_000

  /// - Parameters:
  ///   - badgeReserve: width that must stay free right of the column (0 without badges).
  static func compute(
    viewWidth: CGFloat, readable: Bool, horizontalPadding: CGFloat, topPadding: CGFloat,
    badgeReserve: CGFloat
  ) -> TextGeometry {
    var column = max(minColumnWidth, viewWidth - 2 * horizontalPadding)
    var left = horizontalPadding
    if readable, column > maxReadableWidth {
      column = maxReadableWidth
      left = ((viewWidth - column) / 2).rounded(.down)
    }
    if badgeReserve > 0 {
      let right = viewWidth - left - column
      if right < badgeReserve { column = max(minColumnWidth, viewWidth - left - badgeReserve) }
    }
    return TextGeometry(
      inset: CGSize(width: left, height: topPadding), columnWidth: column.rounded(.down))
  }
}
