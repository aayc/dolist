import Foundation

/// An SVG path command in absolute coordinates: what `path-data-parser` gives Rough.js after
/// `absolutize` (Excalidraw only builds paths from M, L, Q and C).
public enum RoughPathSegment: Hashable, Sendable {
  case move(DrawingPoint)
  case line(DrawingPoint)
  case quad(DrawingPoint, DrawingPoint)
  case cubic(DrawingPoint, DrawingPoint, DrawingPoint)
  case close

  /// Parses SVG path data with M, L, H, V, Q, C and Z (absolute or relative), like
  /// `absolutize(parsePath(d))`; nil for anything else.
  public static func parse(_ d: String) -> [RoughPathSegment]? {
    var tokens: [Substring] = []
    var index = d.startIndex
    while index < d.endIndex {
      let character = d[index]
      if character == " " || character == "," || character == "\n" || character == "\t" {
        index = d.index(after: index)
      } else if "MmLlHhVvQqCcZz".contains(character) {
        tokens.append(d[index...index])
        index = d.index(after: index)
      } else {
        var end = index
        var seenExponent = false
        while end < d.endIndex {
          let c = d[end]
          let atStart = end == index
          let afterExponent = end > index && "eE".contains(d[d.index(before: end)])
          if c.isNumber || c == "." || (c == "-" || c == "+") && (atStart || afterExponent)
            || (c == "e" || c == "E") && !seenExponent && !atStart
          {
            if c == "e" || c == "E" { seenExponent = true }
            end = d.index(after: end)
          } else {
            break
          }
        }
        guard end > index else { return nil }
        tokens.append(d[index..<end])
        index = end
      }
    }
    var segments: [RoughPathSegment] = []
    var current = DrawingPoint.zero
    var subpathStart = DrawingPoint.zero
    var command: Character?
    var position = 0
    func number() -> Double? {
      guard position < tokens.count, let value = Double(tokens[position]) else { return nil }
      position += 1
      return value
    }
    while position < tokens.count {
      if let first = tokens[position].first, first.isLetter {
        command = first
        position += 1
      } else if command == "M" {
        command = "L"
      } else if command == "m" {
        command = "l"
      }
      guard let command else { return nil }
      let relative = command.isLowercase
      let base = relative ? current : DrawingPoint.zero
      func point() -> DrawingPoint? {
        guard let x = number(), let y = number() else { return nil }
        return DrawingPoint(base.x + x, base.y + y)
      }
      switch command.uppercased() {
      case "M":
        guard let p = point() else { return nil }
        segments.append(.move(p))
        current = p
        subpathStart = p
      case "L":
        guard let p = point() else { return nil }
        segments.append(.line(p))
        current = p
      case "H":
        guard let x = number() else { return nil }
        current = DrawingPoint(relative ? current.x + x : x, current.y)
        segments.append(.line(current))
      case "V":
        guard let y = number() else { return nil }
        current = DrawingPoint(current.x, relative ? current.y + y : y)
        segments.append(.line(current))
      case "Q":
        guard let c = point(), let p = point() else { return nil }
        segments.append(.quad(c, p))
        current = p
      case "C":
        guard let c1 = point(), let c2 = point(), let p = point() else { return nil }
        segments.append(.cubic(c1, c2, p))
        current = p
      case "Z":
        segments.append(.close)
        current = subpathStart
      default:
        return nil
      }
    }
    return segments
  }

  /// `normalize`: quadratic curves become cubic ones, the rest stays.
  static func normalize(_ segments: [RoughPathSegment]) -> [RoughPathSegment] {
    var output: [RoughPathSegment] = []
    var cx: Double = 0
    var cy: Double = 0
    var subx: Double = 0
    var suby: Double = 0
    for segment in segments {
      switch segment {
      case .move(let point):
        output.append(segment)
        (cx, cy) = (point.x, point.y)
        (subx, suby) = (point.x, point.y)
      case .line(let point):
        output.append(segment)
        (cx, cy) = (point.x, point.y)
      case .cubic(_, _, let point):
        output.append(segment)
        (cx, cy) = (point.x, point.y)
      case .quad(let control, let point):
        let (x1, y1, x, y) = (control.x, control.y, point.x, point.y)
        let cx1 = cx + 2 * (x1 - cx) / 3
        let cy1 = cy + 2 * (y1 - cy) / 3
        let cx2 = x + 2 * (x1 - x) / 3
        let cy2 = y + 2 * (y1 - y) / 3
        output.append(.cubic(DrawingPoint(cx1, cy1), DrawingPoint(cx2, cy2), point))
        (cx, cy) = (x, y)
      case .close:
        output.append(.close)
        (cx, cy) = (subx, suby)
      }
    }
    return output
  }
}

/// `points-on-curve` and `points-on-path`: flattening Bézier curves and simplifying polylines.
enum PointsOnCurve {
  typealias Point = DrawingPoint

  static func distanceSq(_ p1: Point, _ p2: Point) -> Double {
    pow(p1.x - p2.x, 2) + pow(p1.y - p2.y, 2)
  }

  static func distance(_ p1: Point, _ p2: Point) -> Double { sqrt(distanceSq(p1, p2)) }

  static func distanceToSegmentSq(_ p: Point, _ v: Point, _ w: Point) -> Double {
    let l2 = distanceSq(v, w)
    if l2 == 0 { return distanceSq(p, v) }
    var t = ((p.x - v.x) * (w.x - v.x) + (p.y - v.y) * (w.y - v.y)) / l2
    t = max(0, min(1, t))
    return distanceSq(p, lerp(v, w, t))
  }

  static func lerp(_ a: Point, _ b: Point, _ t: Double) -> Point {
    Point(a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t)
  }

  static func flatness(_ points: [Point], _ offset: Int) -> Double {
    let p1 = points[offset + 0]
    let p2 = points[offset + 1]
    let p3 = points[offset + 2]
    let p4 = points[offset + 3]
    var ux = 3 * p2.x - 2 * p1.x - p4.x
    ux *= ux
    var uy = 3 * p2.y - 2 * p1.y - p4.y
    uy *= uy
    var vx = 3 * p3.x - 2 * p4.x - p1.x
    vx *= vx
    var vy = 3 * p3.y - 2 * p4.y - p1.y
    vy *= vy
    if ux < vx { ux = vx }
    if uy < vy { uy = vy }
    return ux + uy
  }

  static func pointsOnBezierCurveWithSplitting(
    _ points: [Point], _ offset: Int, _ tolerance: Double, _ outPoints: inout [Point]
  ) {
    if flatness(points, offset) < tolerance {
      let p0 = points[offset + 0]
      if let last = outPoints.last {
        if distance(last, p0) > 1 { outPoints.append(p0) }
      } else {
        outPoints.append(p0)
      }
      outPoints.append(points[offset + 3])
    } else {
      let t = 0.5
      let p1 = points[offset + 0]
      let p2 = points[offset + 1]
      let p3 = points[offset + 2]
      let p4 = points[offset + 3]
      let q1 = lerp(p1, p2, t)
      let q2 = lerp(p2, p3, t)
      let q3 = lerp(p3, p4, t)
      let r1 = lerp(q1, q2, t)
      let r2 = lerp(q2, q3, t)
      let red = lerp(r1, r2, t)
      pointsOnBezierCurveWithSplitting([p1, q1, r1, red], 0, tolerance, &outPoints)
      pointsOnBezierCurveWithSplitting([red, r2, q3, p4], 0, tolerance, &outPoints)
    }
  }

  /// Ramer–Douglas–Peucker.
  static func simplify(_ points: [Point], _ distance: Double) -> [Point] {
    var out: [Point] = []
    simplifyPoints(points, 0, points.count, distance, &out)
    return out
  }

  static func simplifyPoints(
    _ points: [Point], _ start: Int, _ end: Int, _ epsilon: Double, _ outPoints: inout [Point]
  ) {
    let s = points[start]
    let e = points[end - 1]
    var maxDistSq: Double = 0
    var maxIndex = 1
    var i = start + 1
    while i < end - 1 {
      let distSq = distanceToSegmentSq(points[i], s, e)
      if distSq > maxDistSq {
        maxDistSq = distSq
        maxIndex = i
      }
      i += 1
    }
    if sqrt(maxDistSq) > epsilon {
      simplifyPoints(points, start, maxIndex + 1, epsilon, &outPoints)
      simplifyPoints(points, maxIndex, end, epsilon, &outPoints)
    } else {
      if outPoints.isEmpty { outPoints.append(s) }
      outPoints.append(e)
    }
  }

  static func pointsOnBezierCurves(
    _ points: [Point], tolerance: Double = 0.15, distance: Double? = nil
  ) -> [Point] {
    var newPoints: [Point] = []
    let segments = (points.count - 1) / 3
    for i in 0..<max(segments, 0) {
      pointsOnBezierCurveWithSplitting(points, i * 3, tolerance, &newPoints)
    }
    if let distance, distance > 0 {
      var out: [Point] = []
      simplifyPoints(newPoints, 0, newPoints.count, distance, &out)
      return out
    }
    return newPoints
  }

  static func curveToBezier(_ pointsIn: [Point], curveTightness: Double = 0) -> [Point] {
    let count = pointsIn.count
    precondition(count >= 3, "A curve must have at least three points.")
    var out: [Point] = []
    if count == 3 {
      out += [pointsIn[0], pointsIn[1], pointsIn[2], pointsIn[2]]
    } else {
      var points: [Point] = [pointsIn[0], pointsIn[0]]
      for i in 1..<count {
        points.append(pointsIn[i])
        if i == count - 1 { points.append(pointsIn[i]) }
      }
      let s = 1 - curveTightness
      out.append(points[0])
      var i = 1
      while i + 2 < points.count {
        let vertex = points[i]
        let b1 = Point(
          vertex.x + (s * points[i + 1].x - s * points[i - 1].x) / 6,
          vertex.y + (s * points[i + 1].y - s * points[i - 1].y) / 6)
        let b2 = Point(
          points[i + 1].x + (s * points[i].x - s * points[i + 2].x) / 6,
          points[i + 1].y + (s * points[i].y - s * points[i + 2].y) / 6)
        out += [b1, b2, points[i + 1]]
        i += 1
      }
    }
    return out
  }

  /// `pointsOnPath(path, tolerance, distance)` for normalized segments.
  static func pointsOnPath(
    _ normalized: [RoughPathSegment], tolerance: Double, distance: Double?
  ) -> [[Point]] {
    var sets: [[Point]] = []
    var currentPoints: [Point] = []
    var start = Point(0, 0)
    var pendingCurve: [Point] = []
    func appendPendingCurve() {
      if pendingCurve.count >= 4 {
        currentPoints += pointsOnBezierCurves(pendingCurve, tolerance: tolerance)
      }
      pendingCurve = []
    }
    func appendPendingPoints() {
      appendPendingCurve()
      if !currentPoints.isEmpty {
        sets.append(currentPoints)
        currentPoints = []
      }
    }
    for segment in normalized {
      switch segment {
      case .move(let point):
        appendPendingPoints()
        start = point
        currentPoints.append(start)
      case .line(let point):
        appendPendingCurve()
        currentPoints.append(point)
      case .cubic(let c1, let c2, let point):
        if pendingCurve.isEmpty {
          pendingCurve.append(currentPoints.last ?? start)
        }
        pendingCurve += [c1, c2, point]
      case .close:
        appendPendingCurve()
        currentPoints.append(start)
      case .quad:
        break
      }
    }
    appendPendingPoints()
    guard let distance, distance != 0 else { return sets }
    return sets.compactMap { set in
      let simplified = simplify(set, distance)
      return simplified.isEmpty ? nil : simplified
    }
  }
}
