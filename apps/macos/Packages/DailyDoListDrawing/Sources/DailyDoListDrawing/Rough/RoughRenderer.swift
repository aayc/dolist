import Foundation

/// Rough.js's `renderer.ts`: the op sets of lines, curves, ellipses and paths, and their fills.
enum RoughRenderer {
  typealias Point = DrawingPoint

  static func line(_ x1: Double, _ y1: Double, _ x2: Double, _ y2: Double, _ o: RoughOptions)
    -> RoughOpSet
  {
    RoughOpSet(.path, doubleLine(x1, y1, x2, y2, o))
  }

  static func linearPath(_ points: [Point], close: Bool, _ o: RoughOptions) -> RoughOpSet {
    let count = points.count
    if count > 2 {
      var ops: [RoughOp] = []
      for i in 0..<(count - 1) {
        ops += doubleLine(points[i].x, points[i].y, points[i + 1].x, points[i + 1].y, o)
      }
      if close {
        ops += doubleLine(points[count - 1].x, points[count - 1].y, points[0].x, points[0].y, o)
      }
      return RoughOpSet(.path, ops)
    } else if count == 2 {
      return line(points[0].x, points[0].y, points[1].x, points[1].y, o)
    }
    return RoughOpSet(.path, [])
  }

  static func polygon(_ points: [Point], _ o: RoughOptions) -> RoughOpSet {
    linearPath(points, close: true, o)
  }

  static func rectangle(
    _ x: Double, _ y: Double, _ width: Double, _ height: Double, _ o: RoughOptions
  ) -> RoughOpSet {
    polygon(
      [Point(x, y), Point(x + width, y), Point(x + width, y + height), Point(x, y + height)], o)
  }

  static func curve(_ points: [Point], _ o: RoughOptions) -> RoughOpSet {
    var o1 = curveWithOffset(points, 1 * (1 + o.roughness * 0.2), o)
    if !o.disableMultiStroke {
      let o2 = curveWithOffset(points, 1.5 * (1 + o.roughness * 0.22), cloneOptionsAlterSeed(o))
      o1 += o2
    }
    return RoughOpSet(.path, o1)
  }

  struct EllipseParams {
    var increment: Double
    var rx: Double
    var ry: Double
  }

  static func generateEllipseParams(_ width: Double, _ height: Double, _ o: RoughOptions)
    -> EllipseParams
  {
    let psq = sqrt(Double.pi * 2 * sqrt((pow(width / 2, 2) + pow(height / 2, 2)) / 2))
    let stepCount = ceil(max(o.curveStepCount, (o.curveStepCount / sqrt(200)) * psq))
    let increment = (Double.pi * 2) / stepCount
    var rx = abs(width / 2)
    var ry = abs(height / 2)
    let curveFitRandomness = 1 - o.curveFitting
    rx += offsetOpt(rx * curveFitRandomness, o)
    ry += offsetOpt(ry * curveFitRandomness, o)
    return EllipseParams(increment: increment, rx: rx, ry: ry)
  }

  static func ellipseWithParams(
    _ x: Double, _ y: Double, _ o: RoughOptions, _ params: EllipseParams
  ) -> (estimatedPoints: [Point], opset: RoughOpSet) {
    let (ap1, cp1) = computeEllipsePoints(
      params.increment, x, y, params.rx, params.ry, 1,
      params.increment * offset(0.1, offset(0.4, 1, o), o), o)
    var o1 = curveOps(ap1, nil, o)
    if !o.disableMultiStroke && o.roughness != 0 {
      let (ap2, _) = computeEllipsePoints(params.increment, x, y, params.rx, params.ry, 1.5, 0, o)
      let o2 = curveOps(ap2, nil, o)
      o1 += o2
    }
    return (cp1, RoughOpSet(.path, o1))
  }

  static func svgPath(_ segments: [RoughPathSegment], _ o: RoughOptions) -> RoughOpSet {
    var ops: [RoughOp] = []
    var first = Point(0, 0)
    var current = Point(0, 0)
    for segment in segments {
      switch segment {
      case .move(let point):
        current = point
        first = point
      case .line(let point):
        ops += doubleLine(current.x, current.y, point.x, point.y, o)
        current = point
      case .cubic(let c1, let c2, let point):
        ops += bezierTo(c1.x, c1.y, c2.x, c2.y, point.x, point.y, current, o)
        current = point
      case .close:
        ops += doubleLine(current.x, current.y, first.x, first.y, o)
        current = first
      case .quad:
        break  // normalized away
      }
    }
    return RoughOpSet(.path, ops)
  }

  // MARK: Fills

  static func solidFillPolygon(_ polygonList: [[Point]], _ o: RoughOptions) -> RoughOpSet {
    var ops: [RoughOp] = []
    for points in polygonList where !points.isEmpty {
      let offset = o.maxRandomnessOffset
      let count = points.count
      if count > 2 {
        ops.append(
          RoughOp(
            .move, [points[0].x + offsetOpt(offset, o), points[0].y + offsetOpt(offset, o)]))
        for i in 1..<count {
          ops.append(
            RoughOp(
              .lineTo, [points[i].x + offsetOpt(offset, o), points[i].y + offsetOpt(offset, o)]))
        }
      }
    }
    return RoughOpSet(.fillPath, ops)
  }

  static func patternFillPolygons(_ polygonList: [[Point]], _ o: RoughOptions) -> RoughOpSet {
    RoughFillers.fillPolygons(polygonList, o)
  }

  // MARK: Helpers shared with the fillers

  static func randOffset(_ x: Double, _ o: RoughOptions) -> Double { offsetOpt(x, o) }

  static func doubleLineFillOps(
    _ x1: Double, _ y1: Double, _ x2: Double, _ y2: Double, _ o: RoughOptions
  ) -> [RoughOp] {
    doubleLine(x1, y1, x2, y2, o, filling: true)
  }

  static func ellipse(
    _ x: Double, _ y: Double, _ width: Double, _ height: Double, _ o: RoughOptions
  ) -> RoughOpSet {
    let params = generateEllipseParams(width, height, o)
    return ellipseWithParams(x, y, o, params).opset
  }

  // MARK: Private helpers

  static func cloneOptionsAlterSeed(_ o: RoughOptions) -> RoughOptions {
    let result = o.copy()
    result.randomizer = nil
    if o.seed != 0 {
      result.seed = o.seed + 1
    }
    return result
  }

  static func random(_ o: RoughOptions) -> Double {
    if o.randomizer == nil {
      o.randomizer = RoughRandom(seed: o.seed)
    }
    return o.randomizer!.next()
  }

  static func offset(_ min: Double, _ max: Double, _ o: RoughOptions, _ roughnessGain: Double = 1)
    -> Double
  {
    o.roughness * roughnessGain * ((random(o) * (max - min)) + min)
  }

  static func offsetOpt(_ x: Double, _ o: RoughOptions, _ roughnessGain: Double = 1) -> Double {
    offset(-x, x, o, roughnessGain)
  }

  static func doubleLine(
    _ x1: Double, _ y1: Double, _ x2: Double, _ y2: Double, _ o: RoughOptions,
    filling: Bool = false
  ) -> [RoughOp] {
    let singleStroke = filling ? o.disableMultiStrokeFill : o.disableMultiStroke
    let o1 = line(x1, y1, x2, y2, o, move: true, overlay: false)
    if singleStroke {
      return o1
    }
    let o2 = line(x1, y1, x2, y2, o, move: true, overlay: true)
    return o1 + o2
  }

  private static func line(
    _ x1: Double, _ y1: Double, _ x2: Double, _ y2: Double, _ o: RoughOptions, move: Bool,
    overlay: Bool
  ) -> [RoughOp] {
    let lengthSq = pow(x1 - x2, 2) + pow(y1 - y2, 2)
    let length = sqrt(lengthSq)
    var roughnessGain: Double = 1
    if length < 200 {
      roughnessGain = 1
    } else if length > 500 {
      roughnessGain = 0.4
    } else {
      roughnessGain = (-0.0016668) * length + 1.233334
    }
    var offset = o.maxRandomnessOffset
    if (offset * offset * 100) > lengthSq {
      offset = length / 10
    }
    let halfOffset = offset / 2
    let divergePoint = 0.2 + random(o) * 0.2
    var midDispX = o.bowing * o.maxRandomnessOffset * (y2 - y1) / 200
    var midDispY = o.bowing * o.maxRandomnessOffset * (x1 - x2) / 200
    midDispX = offsetOpt(midDispX, o, roughnessGain)
    midDispY = offsetOpt(midDispY, o, roughnessGain)
    var ops: [RoughOp] = []
    let randomHalf = { offsetOpt(halfOffset, o, roughnessGain) }
    let randomFull = { offsetOpt(offset, o, roughnessGain) }
    let preserveVertices = o.preserveVertices
    if move {
      if overlay {
        let x = x1 + (preserveVertices ? 0 : randomHalf())
        let y = y1 + (preserveVertices ? 0 : randomHalf())
        ops.append(RoughOp(.move, [x, y]))
      } else {
        let x = x1 + (preserveVertices ? 0 : offsetOpt(offset, o, roughnessGain))
        let y = y1 + (preserveVertices ? 0 : offsetOpt(offset, o, roughnessGain))
        ops.append(RoughOp(.move, [x, y]))
      }
    }
    let jitter = overlay ? randomHalf : randomFull
    let c1x = midDispX + x1 + (x2 - x1) * divergePoint + jitter()
    let c1y = midDispY + y1 + (y2 - y1) * divergePoint + jitter()
    let c2x = midDispX + x1 + 2 * (x2 - x1) * divergePoint + jitter()
    let c2y = midDispY + y1 + 2 * (y2 - y1) * divergePoint + jitter()
    let endX = x2 + (preserveVertices ? 0 : jitter())
    let endY = y2 + (preserveVertices ? 0 : jitter())
    ops.append(RoughOp(.bcurveTo, [c1x, c1y, c2x, c2y, endX, endY]))
    return ops
  }

  private static func curveWithOffset(_ points: [Point], _ offset: Double, _ o: RoughOptions)
    -> [RoughOp]
  {
    var ps: [Point] = []
    ps.append(Point(points[0].x + offsetOpt(offset, o), points[0].y + offsetOpt(offset, o)))
    ps.append(Point(points[0].x + offsetOpt(offset, o), points[0].y + offsetOpt(offset, o)))
    for i in 1..<max(points.count, 1) {
      ps.append(Point(points[i].x + offsetOpt(offset, o), points[i].y + offsetOpt(offset, o)))
      if i == points.count - 1 {
        ps.append(Point(points[i].x + offsetOpt(offset, o), points[i].y + offsetOpt(offset, o)))
      }
    }
    return curveOps(ps, nil, o)
  }

  static func curveOps(_ points: [Point], _ closePoint: Point?, _ o: RoughOptions) -> [RoughOp] {
    let count = points.count
    var ops: [RoughOp] = []
    if count > 3 {
      let s = 1 - o.curveTightness
      ops.append(RoughOp(.move, [points[1].x, points[1].y]))
      var i = 1
      while i + 2 < count {
        let vertex = points[i]
        let b1x = vertex.x + (s * points[i + 1].x - s * points[i - 1].x) / 6
        let b1y = vertex.y + (s * points[i + 1].y - s * points[i - 1].y) / 6
        let b2x = points[i + 1].x + (s * points[i].x - s * points[i + 2].x) / 6
        let b2y = points[i + 1].y + (s * points[i].y - s * points[i + 2].y) / 6
        ops.append(RoughOp(.bcurveTo, [b1x, b1y, b2x, b2y, points[i + 1].x, points[i + 1].y]))
        i += 1
      }
      if let closePoint {
        let ro = o.maxRandomnessOffset
        ops.append(
          RoughOp(.lineTo, [closePoint.x + offsetOpt(ro, o), closePoint.y + offsetOpt(ro, o)]))
      }
    } else if count == 3 {
      ops.append(RoughOp(.move, [points[1].x, points[1].y]))
      ops.append(
        RoughOp(
          .bcurveTo, [points[1].x, points[1].y, points[2].x, points[2].y, points[2].x, points[2].y]
        ))
    } else if count == 2 {
      ops += doubleLine(points[0].x, points[0].y, points[1].x, points[1].y, o)
    }
    return ops
  }

  private static func computeEllipsePoints(
    _ increment: Double, _ cx: Double, _ cy: Double, _ rx: Double, _ ry: Double,
    _ offset: Double, _ overlap: Double, _ o: RoughOptions
  ) -> ([Point], [Point]) {
    let coreOnly = o.roughness == 0
    var corePoints: [Point] = []
    var allPoints: [Point] = []
    if coreOnly {
      let increment = increment / 4
      allPoints.append(Point(cx + rx * cos(-increment), cy + ry * sin(-increment)))
      var angle: Double = 0
      while angle <= Double.pi * 2 {
        let p = Point(cx + rx * cos(angle), cy + ry * sin(angle))
        corePoints.append(p)
        allPoints.append(p)
        angle = angle + increment
      }
      allPoints.append(Point(cx + rx * cos(0), cy + ry * sin(0)))
      allPoints.append(Point(cx + rx * cos(increment), cy + ry * sin(increment)))
    } else {
      let radOffset = offsetOpt(0.5, o) - (Double.pi / 2)
      do {
        let x = offsetOpt(offset, o) + cx + 0.9 * rx * cos(radOffset - increment)
        let y = offsetOpt(offset, o) + cy + 0.9 * ry * sin(radOffset - increment)
        allPoints.append(Point(x, y))
      }
      let endAngle = Double.pi * 2 + radOffset - 0.01
      var angle = radOffset
      while angle < endAngle {
        let x = offsetOpt(offset, o) + cx + rx * cos(angle)
        let y = offsetOpt(offset, o) + cy + ry * sin(angle)
        let p = Point(x, y)
        corePoints.append(p)
        allPoints.append(p)
        angle = angle + increment
      }
      do {
        let x = offsetOpt(offset, o) + cx + rx * cos(radOffset + Double.pi * 2 + overlap * 0.5)
        let y = offsetOpt(offset, o) + cy + ry * sin(radOffset + Double.pi * 2 + overlap * 0.5)
        allPoints.append(Point(x, y))
      }
      do {
        let x = offsetOpt(offset, o) + cx + 0.98 * rx * cos(radOffset + overlap)
        let y = offsetOpt(offset, o) + cy + 0.98 * ry * sin(radOffset + overlap)
        allPoints.append(Point(x, y))
      }
      do {
        let x = offsetOpt(offset, o) + cx + 0.9 * rx * cos(radOffset + overlap * 0.5)
        let y = offsetOpt(offset, o) + cy + 0.9 * ry * sin(radOffset + overlap * 0.5)
        allPoints.append(Point(x, y))
      }
    }
    return (allPoints, corePoints)
  }

  private static func bezierTo(
    _ x1: Double, _ y1: Double, _ x2: Double, _ y2: Double, _ x: Double, _ y: Double,
    _ current: Point, _ o: RoughOptions
  ) -> [RoughOp] {
    var ops: [RoughOp] = []
    let base = o.maxRandomnessOffset != 0 ? o.maxRandomnessOffset : 1
    let ros = [base, base + 0.3]
    let iterations = o.disableMultiStroke ? 1 : 2
    let preserveVertices = o.preserveVertices
    for i in 0..<iterations {
      if i == 0 {
        ops.append(RoughOp(.move, [current.x, current.y]))
      } else {
        let mx = current.x + (preserveVertices ? 0 : offsetOpt(ros[0], o))
        let my = current.y + (preserveVertices ? 0 : offsetOpt(ros[0], o))
        ops.append(RoughOp(.move, [mx, my]))
      }
      let f: Point
      if preserveVertices {
        f = Point(x, y)
      } else {
        let fx = x + offsetOpt(ros[i], o)
        let fy = y + offsetOpt(ros[i], o)
        f = Point(fx, fy)
      }
      let c1x = x1 + offsetOpt(ros[i], o)
      let c1y = y1 + offsetOpt(ros[i], o)
      let c2x = x2 + offsetOpt(ros[i], o)
      let c2y = y2 + offsetOpt(ros[i], o)
      ops.append(RoughOp(.bcurveTo, [c1x, c1y, c2x, c2y, f.x, f.y]))
    }
    return ops
  }
}
