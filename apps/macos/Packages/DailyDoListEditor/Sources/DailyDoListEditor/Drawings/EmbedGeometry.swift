import CoreGraphics
import DailyDoListDrawing

/// Sizes and places a drawing embed in the text column the way the web editor's embed layer does
/// (`widget.ts`, `styles.css`): a width from the modifiers (else the drawing's own width, else
/// 360, full width for no placement), a height from the modifiers or the drawing's proportions,
/// floats with room around them, and the others on a row of their own.
enum EmbedGeometry {
  /// Width of a floated or aligned embed that names none, before its drawing is known.
  static let defaultWidth: CGFloat = 360
  /// Height of the box while the drawing's size isn't known (or it's empty).
  static let placeholderHeight: CGFloat = 160
  /// The narrowest an embed can be resized to.
  static let minWidth: CGFloat = 48
  /// Space above a float, below it, and between it and the text wrapping around it.
  static let floatTop: CGFloat = 3
  static let floatBottom: CGFloat = 10
  static let floatGap: CGFloat = 20
  /// Space above and below a drawing on its own row.
  static let rowMargin: CGFloat = 4
  /// The box of a drawing being edited in place is at least this tall.
  static let minEditingHeight: CGFloat = 240

  /// The box's size for `spec` in a column `columnWidth` wide. `natural` is the drawing's size at
  /// 100% (nil while unknown or empty).
  static func size(for spec: DrawingEmbed, natural: CGSize?, columnWidth: CGFloat) -> CGSize {
    let column = max(1, columnWidth)
    let requested: CGFloat =
      if let width = spec.width {
        CGFloat(width)
      } else if let percent = spec.widthPercent {
        column * CGFloat(percent) / 100
      } else if spec.placement == .full {
        column
      } else {
        natural?.width ?? defaultWidth
      }
    let width = max(1, min(requested, column)).rounded()
    let height: CGFloat
    if let fixed = spec.height {
      height = spec.width == nil ? CGFloat(fixed) : CGFloat(fixed) * width / max(1, requested)
    } else if let natural, natural.width > 0, natural.height > 0 {
      height = width * natural.height / natural.width
    } else {
      height = placeholderHeight
    }
    return CGSize(width: width, height: max(1, height.rounded()))
  }

  /// Where a box `width` wide starts in the column.
  static func x(for placement: DrawingEmbed.Placement, width: CGFloat, columnWidth: CGFloat)
    -> CGFloat
  {
    switch placement {
    case .right, .rightWrap: max(0, columnWidth - width)
    case .center: max(0, ((columnWidth - width) / 2).rounded())
    case .full, .left, .leftWrap: 0
    }
  }

  /// The part of a float's line the text stays out of: the box with its margins, to the column's
  /// edge on the float's side.
  static func exclusion(
    forFloat box: CGRect, placement: DrawingEmbed.Placement, columnWidth: CGFloat
  )
    -> CGRect
  {
    let top = box.minY - floatTop
    let height = floatTop + box.height + floatBottom
    if placement == .leftWrap {
      return CGRect(x: 0, y: top, width: box.maxX + floatGap, height: height)
    }
    let x = box.minX - floatGap
    return CGRect(x: x, y: top, width: max(columnWidth, box.maxX) - x, height: height)
  }

  /// Where a drawing whose size at 100% is `natural` goes in `box`: fitted, centered.
  static func fit(_ natural: CGSize?, in box: CGRect) -> CGRect {
    guard let natural, natural.width > 0, natural.height > 0 else { return box }
    let scale = min(box.width / natural.width, box.height / natural.height)
    let size = CGSize(width: natural.width * scale, height: natural.height * scale)
    return CGRect(
      x: box.midX - size.width / 2, y: box.midY - size.height / 2, width: size.width,
      height: size.height)
  }
}
