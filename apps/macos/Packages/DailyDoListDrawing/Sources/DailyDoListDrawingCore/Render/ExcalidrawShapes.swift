import CoreGraphics
import Foundation

/// Excalidraw's `scene/Shape.ts`: the Rough.js options and drawables of an element, in the
/// element's own coordinates.
public enum ExcalidrawShapes {
  /// Stands for the canvas color in the fill of outlined arrowheads, resolved when drawing.
  public static let canvasBackground = "\u{0}canvas"

  static func dashArrayDashed(_ strokeWidth: Double) -> [Double] { [8, 8 + strokeWidth] }
  static func dashArrayDotted(_ strokeWidth: Double) -> [Double] { [1.5, 6 + strokeWidth] }

  /// `adjustRoughness`: small shapes get less sloppy.
  static func adjustRoughness(_ element: ExcalidrawElement) -> Double {
    let roughness = element.roughness
    let maxSize = max(element.width, element.height)
    let minSize = min(element.width, element.height)
    let canChangeRoundness =
      element.type == .rectangle || element.type == .iframe || element.type == .embeddable
      || element.type == .line || element.type == .diamond || element.type == .image
    if (minSize >= 20 && maxSize >= 50)
      || (minSize >= 15 && element.roundness != nil && canChangeRoundness)
      || (element.type.isLinear && maxSize >= 50)
    {
      return roughness
    }
    return min(roughness / (maxSize < 10 ? 3 : 2), 2.5)
  }

  /// `generateRoughOptions`.
  static func roughOptions(_ element: ExcalidrawElement, continuousPath: Bool = false)
    -> RoughOptions
  {
    let options = RoughOptions()
    options.seed = Double(element.seed)
    options.strokeLineDash =
      element.strokeStyle == .dashed
      ? dashArrayDashed(element.strokeWidth)
      : element.strokeStyle == .dotted ? dashArrayDotted(element.strokeWidth) : nil
    options.disableMultiStroke = element.strokeStyle != .solid
    options.strokeWidth =
      element.strokeStyle != .solid ? element.strokeWidth + 0.5 : element.strokeWidth
    options.fillWeight = element.strokeWidth / 2
    options.hachureGap = element.strokeWidth * 4
    options.roughness = adjustRoughness(element)
    options.stroke = element.strokeColor
    options.preserveVertices = continuousPath || element.roughness < 2
    switch element.type {
    case .rectangle, .iframe, .embeddable, .diamond, .ellipse:
      options.fillStyle = element.fillStyle.rawValue
      options.fill =
        DrawingColor.isTransparent(element.backgroundColor) ? nil : element.backgroundColor
      if element.type == .ellipse { options.curveFitting = 1 }
    case .line, .freedraw:
      if ElementGeometry.isPathALoop(element.points) {
        options.fillStyle = element.fillStyle.rawValue
        options.fill = element.backgroundColor == "transparent" ? nil : element.backgroundColor
      }
    default:
      break
    }
    return options
  }

  /// `_generateElementShape`: the drawables of rectangles, diamonds, ellipses, lines, arrows (with
  /// their arrowheads) and the fill of closed freehand strokes; nil for other types.
  public static func drawables(_ element: ExcalidrawElement) -> [RoughDrawable] {
    switch element.type {
    case .rectangle, .iframe, .embeddable:
      var element = element
      if element.type != .rectangle, DrawingColor.isTransparent(element.backgroundColor),
        DrawingColor.isTransparent(element.strokeColor)
      {
        element.roughness = 0
        element.backgroundColor = "#d3d3d3"
        element.fillStyle = .solid
      }
      if element.roundness != nil {
        let w = element.width
        let h = element.height
        let r = ElementGeometry.cornerRadius(min(w, h), element)
        typealias P = DrawingPoint
        let path: [RoughPathSegment] = [
          .move(P(r, 0)), .line(P(w - r, 0)), .quad(P(w, 0), P(w, r)), .line(P(w, h - r)),
          .quad(P(w, h), P(w - r, h)), .line(P(r, h)), .quad(P(0, h), P(0, h - r)),
          .line(P(0, r)), .quad(P(0, 0), P(r, 0)),
        ]
        return [RoughGenerator.path(path, roughOptions(element, continuousPath: true))]
      }
      return [
        RoughGenerator.rectangle(0, 0, element.width, element.height, roughOptions(element))
      ]
    case .diamond:
      let points = ElementGeometry.diamondPoints(element)
      let (top, right, bottom, left) = (points[0], points[1], points[2], points[3])
      if element.roundness != nil {
        let vr = ElementGeometry.cornerRadius(abs(top.x - left.x), element)
        let hr = ElementGeometry.cornerRadius(abs(right.y - top.y), element)
        typealias P = DrawingPoint
        let path: [RoughPathSegment] = [
          .move(P(top.x + vr, top.y + hr)), .line(P(right.x - vr, right.y - hr)),
          .cubic(right, right, P(right.x - vr, right.y + hr)),
          .line(P(bottom.x + vr, bottom.y - hr)),
          .cubic(bottom, bottom, P(bottom.x - vr, bottom.y - hr)),
          .line(P(left.x + vr, left.y + hr)), .cubic(left, left, P(left.x + vr, left.y - hr)),
          .line(P(top.x - vr, top.y + hr)), .cubic(top, top, P(top.x + vr, top.y + hr)),
        ]
        return [RoughGenerator.path(path, roughOptions(element, continuousPath: true))]
      }
      return [RoughGenerator.polygon([top, right, bottom, left], roughOptions(element))]
    case .ellipse:
      return [
        RoughGenerator.ellipse(
          element.width / 2, element.height / 2, element.width, element.height,
          roughOptions(element))
      ]
    case .line, .arrow:
      return linearDrawables(element)
    case .freedraw:
      guard ElementGeometry.isPathALoop(element.points) else { return [] }
      let simplified = PointsOnCurve.simplify(element.points, 0.75)
      let options = roughOptions(element)
      options.stroke = "none"
      return [RoughGenerator.curve(simplified, options)]
    default:
      return []
    }
  }

  private static func linearDrawables(_ element: ExcalidrawElement) -> [RoughDrawable] {
    let options = roughOptions(element)
    let points = element.points.isEmpty ? [DrawingPoint(0, 0)] : element.points
    var shape: [RoughDrawable]
    if element.type == .arrow && element.elbowed {
      guard points.allSatisfy({ abs($0.x) <= 1e6 && abs($0.y) <= 1e6 }) else { return [] }
      shape = [
        RoughGenerator.path(
          elbowArrowPath(points, radius: 16), roughOptions(element, continuousPath: true))
      ]
    } else if element.roundness == nil {
      shape = [
        options.fill != nil
          ? RoughGenerator.polygon(points, options) : RoughGenerator.linearPath(points, options)
      ]
    } else {
      shape = [RoughGenerator.curve(points, options)]
    }
    if element.type == .arrow {
      if let start = element.startArrowhead {
        shape += arrowheadShapes(element, shape, position: .start, arrowhead: start, options)
      }
      if let end = element.endArrowhead {
        shape += arrowheadShapes(element, shape, position: .end, arrowhead: end, options)
      }
    }
    return shape
  }

  enum ArrowEnd {
    case start
    case end
  }

  /// `getArrowheadShapes`. Mutates `options` like the JavaScript does, which the end arrowhead
  /// then sees.
  private static func arrowheadShapes(
    _ element: ExcalidrawElement, _ shape: [RoughDrawable], position: ArrowEnd,
    arrowhead: Arrowhead, _ options: RoughOptions
  ) -> [RoughDrawable] {
    guard let points = arrowheadPoints(element, shape, position, arrowhead) else { return [] }
    func crowfootOne(_ points: [Double]?) -> [RoughDrawable] {
      guard let points else { return [] }
      return [RoughGenerator.line(points[2], points[3], points[4], points[5], options)]
    }
    switch arrowhead {
    case .dot, .circle, .circleOutline:
      options.strokeLineDash = nil
      let circle = options.copy()
      circle.fill = arrowhead == .circleOutline ? canvasBackground : element.strokeColor
      circle.fillStyle = "solid"
      circle.stroke = element.strokeColor
      circle.roughness = min(0.5, options.roughness)
      return [RoughGenerator.circle(points[0], points[1], points[2], circle)]
    case .triangle, .triangleOutline:
      options.strokeLineDash = nil
      let triangle = options.copy()
      triangle.fill = arrowhead == .triangleOutline ? canvasBackground : element.strokeColor
      triangle.fillStyle = "solid"
      triangle.roughness = min(1, options.roughness)
      typealias P = DrawingPoint
      return [
        RoughGenerator.polygon(
          [
            P(points[0], points[1]), P(points[2], points[3]), P(points[4], points[5]),
            P(points[0], points[1]),
          ], triangle)
      ]
    case .diamond, .diamondOutline:
      options.strokeLineDash = nil
      let diamond = options.copy()
      diamond.fill = arrowhead == .diamondOutline ? canvasBackground : element.strokeColor
      diamond.fillStyle = "solid"
      diamond.roughness = min(1, options.roughness)
      typealias P = DrawingPoint
      return [
        RoughGenerator.polygon(
          [
            P(points[0], points[1]), P(points[2], points[3]), P(points[4], points[5]),
            P(points[6], points[7]), P(points[0], points[1]),
          ], diamond)
      ]
    case .crowfootOne:
      return crowfootOne(points)
    default:
      if element.strokeStyle == .dotted {
        let dash = dashArrayDotted(element.strokeWidth - 1)
        options.strokeLineDash = [dash[0], dash[1] - 1]
      } else {
        options.strokeLineDash = nil
      }
      options.roughness = min(1, options.roughness)
      var result = [
        RoughGenerator.line(points[2], points[3], points[0], points[1], options),
        RoughGenerator.line(points[4], points[5], points[0], points[1], options),
      ]
      if arrowhead == .crowfootOneOrMany {
        result += crowfootOne(arrowheadPoints(element, shape, position, .crowfootOne))
      }
      return result
    }
  }

  static func arrowheadSize(_ arrowhead: Arrowhead) -> Double {
    switch arrowhead {
    case .arrow: 25
    case .diamond, .diamondOutline: 12
    case .crowfootMany, .crowfootOne, .crowfootOneOrMany: 20
    default: 15
    }
  }

  static func arrowheadAngle(_ arrowhead: Arrowhead) -> Double {
    switch arrowhead {
    case .bar: 90
    case .arrow: 20
    default: 25
    }
  }

  /// `getCurvePathOps`: the ops of the first stroke set.
  static func curvePathOps(_ drawable: RoughDrawable) -> [RoughOp] {
    drawable.sets.first { $0.kind == .path }?.ops ?? drawable.sets.first?.ops ?? []
  }

  /// `getArrowheadPoints`.
  static func arrowheadPoints(
    _ element: ExcalidrawElement, _ shape: [RoughDrawable], _ position: ArrowEnd,
    _ arrowhead: Arrowhead
  ) -> [Double]? {
    guard let first = shape.first else { return nil }
    let ops = curvePathOps(first)
    guard ops.count >= 2 else { return nil }
    let index = position == .start ? 1 : ops.count - 1
    let data = ops[index].data
    guard data.count == 6 else { return nil }
    typealias P = DrawingPoint
    let p3 = P(data[4], data[5])
    let p2 = P(data[2], data[3])
    let p1 = P(data[0], data[1])
    let prevOp = ops[index - 1]
    var p0 = P(0, 0)
    if prevOp.kind == .move {
      p0 = P(prevOp.data[0], prevOp.data[1])
    } else if prevOp.kind == .bcurveTo {
      p0 = P(prevOp.data[4], prevOp.data[5])
    }
    func equation(_ t: Double, _ x: Bool) -> Double {
      let a = x ? p3.x : p3.y
      let b = x ? p2.x : p2.y
      let c = x ? p1.x : p1.y
      let d = x ? p0.x : p0.y
      return pow(1 - t, 3) * a + 3 * t * pow(1 - t, 2) * b + 3 * pow(t, 2) * (1 - t) * c + d
        * pow(t, 3)
    }
    let (x2, y2) = position == .start ? (p0.x, p0.y) : (p3.x, p3.y)
    let (x1, y1) = (equation(0.3, true), equation(0.3, false))
    let distance = hypot(x2 - x1, y2 - y1)
    let nx = (x2 - x1) / distance
    let ny = (y2 - y1) / distance
    let size = arrowheadSize(arrowhead)
    var length: Double = 0
    do {
      let points = element.points
      let c = position == .end ? points[points.count - 1] : points[0]
      let p = points.count > 1 ? (position == .end ? points[points.count - 2] : points[1]) : P(0, 0)
      length = hypot(c.x - p.x, c.y - p.y)
    }
    let lengthMultiplier = arrowhead == .diamond || arrowhead == .diamondOutline ? 0.25 : 0.5
    let minSize = min(size, length * lengthMultiplier)
    let xs = x2 - nx * minSize
    let ys = y2 - ny * minSize
    if arrowhead == .dot || arrowhead == .circle || arrowhead == .circleOutline {
      let diameter = hypot(ys - y2, xs - x2) + element.strokeWidth - 2
      return [x2, y2, diameter]
    }
    let angle = arrowheadAngle(arrowhead)
    if arrowhead == .crowfootMany || arrowhead == .crowfootOneOrMany {
      let a = P(x2, y2).rotated(around: P(xs, ys), by: -angle * Double.pi / 180)
      let b = P(x2, y2).rotated(around: P(xs, ys), by: angle * Double.pi / 180)
      return [xs, ys, a.x, a.y, b.x, b.y]
    }
    let a = P(xs, ys).rotated(around: P(x2, y2), by: -angle * Double.pi / 180)
    let b = P(xs, ys).rotated(around: P(x2, y2), by: angle * Double.pi / 180)
    if arrowhead == .diamond || arrowhead == .diamondOutline {
      let o: P
      let points = element.points
      if position == .start {
        let p = points.count > 1 ? points[1] : P(0, 0)
        o = P(x2 + minSize * 2, y2).rotated(around: P(x2, y2), by: atan2(p.y - y2, p.x - x2))
      } else {
        let p = points.count > 1 ? points[points.count - 2] : P(0, 0)
        o = P(x2 - minSize * 2, y2).rotated(around: P(x2, y2), by: atan2(y2 - p.y, x2 - p.x))
      }
      return [x2, y2, a.x, a.y, o.x, o.y, b.x, b.y]
    }
    return [x2, y2, a.x, a.y, b.x, b.y]
  }

  /// `generateElbowArrowShape`: straight runs with rounded corners.
  static func elbowArrowPath(_ points: [DrawingPoint], radius: Double) -> [RoughPathSegment] {
    typealias P = DrawingPoint
    func horizontal(_ p: P, _ origin: P) -> Bool {
      let x = p.x - origin.x
      let y = p.y - origin.y
      return x > abs(y) || x <= -abs(y)
    }
    var subpoints: [P] = []
    for i in stride(from: 1, to: points.count - 1, by: 1) {
      let prev = points[i - 1]
      let next = points[i + 1]
      let point = points[i]
      let corner = min(radius, point.distance(to: next) / 2, point.distance(to: prev) / 2)
      if horizontal(point, prev) {
        subpoints.append(P(prev.x < point.x ? point.x - corner : point.x + corner, point.y))
      } else {
        subpoints.append(P(point.x, prev.y < point.y ? point.y - corner : point.y + corner))
      }
      subpoints.append(point)
      if horizontal(next, point) {
        subpoints.append(P(next.x < point.x ? point.x - corner : point.x + corner, point.y))
      } else {
        subpoints.append(P(point.x, next.y < point.y ? point.y - corner : point.y + corner))
      }
    }
    var path: [RoughPathSegment] = [.move(points[0])]
    for i in stride(from: 0, to: subpoints.count, by: 3) {
      path.append(.line(subpoints[i]))
      path.append(.quad(subpoints[i + 1], subpoints[i + 2]))
    }
    path.append(.line(points[points.count - 1]))
    return path
  }
}
