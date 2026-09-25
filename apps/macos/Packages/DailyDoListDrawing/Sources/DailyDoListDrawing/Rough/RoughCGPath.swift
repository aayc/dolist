import CoreGraphics

extension RoughOpSet {
  /// The ops as a CoreGraphics path, the way `RoughCanvas._drawToContext` traces them.
  public var cgPath: CGPath {
    let path = CGMutablePath()
    for op in ops {
      let d = op.data
      switch op.kind {
      case .move:
        path.move(to: CGPoint(x: d[0], y: d[1]))
      case .bcurveTo:
        if path.isEmpty { path.move(to: CGPoint(x: d[0], y: d[1])) }
        path.addCurve(
          to: CGPoint(x: d[4], y: d[5]), control1: CGPoint(x: d[0], y: d[1]),
          control2: CGPoint(x: d[2], y: d[3]))
      case .lineTo:
        if path.isEmpty {
          path.move(to: CGPoint(x: d[0], y: d[1]))
        } else {
          path.addLine(to: CGPoint(x: d[0], y: d[1]))
        }
      }
    }
    return path
  }
}
