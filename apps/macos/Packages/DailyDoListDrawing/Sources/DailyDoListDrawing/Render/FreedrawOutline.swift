// Freehand strokes: a port of perfect-freehand 1.2.0 (https://github.com/steveruizok/perfect-freehand,
// MIT, © 2021 Stephen Ruiz Ltd) with the options Excalidraw 0.18 passes it (`getFreeDrawSvgPath`).

import CoreGraphics
import Foundation

/// The outline of a freehand stroke, filled with the stroke color.
enum FreedrawOutline {
  typealias Vec = DrawingPoint

  struct StrokePoint {
    var point: Vec
    var pressure: Double
    var vector: Vec
    var distance: Double
    var runningLength: Double
  }

  /// Excalidraw's options: size 4.25 × stroke width, thinning 0.6, smoothing and streamline 0.5,
  /// ease-out-sine pressure, and `last` once the stroke is finished.
  static func outline(of element: ExcalidrawElement) -> [Vec] {
    var input: [(Vec, Double?)]
    if element.points.isEmpty {
      input = [(Vec(0, 0), 0.5)]
    } else if element.simulatePressure {
      input = element.points.map { ($0, nil) }
    } else {
      input = element.points.enumerated().map { index, point in
        (point, index < element.pressures.count ? element.pressures[index] : nil)
      }
    }
    let size = element.strokeWidth * 4.25
    let last = element.lastCommittedPoint != nil
    let points = strokePoints(input, size: size, streamline: 0.5, isComplete: last)
    return outlinePoints(
      points, size: size, smoothing: 0.5, thinning: 0.6, simulatePressure: element.simulatePressure,
      isComplete: last)
  }

  /// `getSvgPathFromStroke`: quadratic curves through the midpoints, as a closed path. Excalidraw
  /// truncates the path's numbers to two decimals; so does this.
  static func path(of element: ExcalidrawElement) -> CGPath {
    let points = outline(of: element).map {
      CGPoint(x: truncate($0.x), y: truncate($0.y))
    }
    let path = CGMutablePath()
    guard let first = points.first else { return path }
    path.move(to: first)
    for index in points.indices {
      let point = points[index]
      let next = index == points.count - 1 ? first : points[index + 1]
      let middle = CGPoint(
        x: truncate((point.x + next.x) / 2), y: truncate((point.y + next.y) / 2))
      path.addQuadCurve(to: middle, control: point)
    }
    path.addLine(to: first)
    path.closeSubpath()
    return path
  }

  private static func truncate(_ value: Double) -> Double {
    (value * 100).rounded(.towardZero) / 100
  }

  private static func lrp(_ a: Vec, _ b: Vec, _ t: Double) -> Vec { a + (b - a) * t }
  private static func per(_ a: Vec) -> Vec { Vec(a.y, -a.x) }
  private static func dpr(_ a: Vec, _ b: Vec) -> Double { a.x * b.x + a.y * b.y }
  private static func uni(_ a: Vec) -> Vec {
    let length = hypot(a.x, a.y)
    return Vec(a.x / length, a.y / length)
  }
  private static func dist(_ a: Vec, _ b: Vec) -> Double { hypot(a.y - b.y, a.x - b.x) }
  private static func dist2(_ a: Vec, _ b: Vec) -> Double {
    let d = a - b
    return d.x * d.x + d.y * d.y
  }
  private static func rotAround(_ a: Vec, _ c: Vec, _ r: Double) -> Vec {
    let s = sin(r)
    let co = cos(r)
    let px = a.x - c.x
    let py = a.y - c.y
    return Vec(px * co - py * s + c.x, px * s + py * co + c.y)
  }
  private static func prj(_ a: Vec, _ b: Vec, _ c: Double) -> Vec { a + b * c }

  /// `getStrokePoints`.
  static func strokePoints(
    _ input: [(Vec, Double?)], size: Double, streamline: Double, isComplete: Bool
  ) -> [StrokePoint] {
    guard !input.isEmpty else { return [] }
    let t = 0.15 + (1 - streamline) * 0.85
    var pts = input
    if pts.count == 2 {
      let last = pts[1]
      pts = [pts[0]]
      // `lrp` keeps x and y only: the added points have no pressure.
      for i in 1..<5 { pts.append((lrp(pts[0].0, last.0, Double(i) / 4), nil)) }
    }
    if pts.count == 1 {
      pts.append((pts[0].0 + Vec(1, 1), pts[0].1))
    }
    var strokePoints = [
      StrokePoint(
        point: pts[0].0, pressure: pressure(pts[0].1, fallback: 0.25), vector: Vec(1, 1),
        distance: 0, runningLength: 0)
    ]
    var hasReachedMinimumLength = false
    var runningLength: Double = 0
    var prev = strokePoints[0]
    let max = pts.count - 1
    for i in 1..<pts.count {
      let point = isComplete && i == max ? pts[i].0 : lrp(prev.point, pts[i].0, t)
      if prev.point == point { continue }
      let distance = dist(point, prev.point)
      runningLength += distance
      if i < max && !hasReachedMinimumLength {
        if runningLength < size { continue }
        hasReachedMinimumLength = true
      }
      prev = StrokePoint(
        point: point, pressure: pressure(pts[i].1, fallback: 0.5), vector: uni(prev.point - point),
        distance: distance, runningLength: runningLength)
      strokePoints.append(prev)
    }
    strokePoints[0].vector = strokePoints.count > 1 ? strokePoints[1].vector : Vec(0, 0)
    return strokePoints
  }

  private static func pressure(_ value: Double?, fallback: Double) -> Double {
    if let value, value >= 0 { return value }
    return fallback
  }

  static let rateOfPressureChange = 0.275
  static let fixedPi = Double.pi + 0.0001

  /// `getStrokeOutlinePoints` with no tapers and round caps.
  static func outlinePoints(
    _ points: [StrokePoint], size: Double, smoothing: Double, thinning: Double,
    simulatePressure: Bool, isComplete: Bool
  ) -> [Vec] {
    guard !points.isEmpty, size > 0 else { return [] }
    let easing = { (t: Double) in sin(t * Double.pi / 2) }
    func radius(_ pressure: Double) -> Double { size * easing(0.5 - thinning * (0.5 - pressure)) }
    let totalLength = points[points.count - 1].runningLength
    let minDistance = pow(size * smoothing, 2)
    var leftPts: [Vec] = []
    var rightPts: [Vec] = []
    var prevPressure = points.prefix(10).reduce(points[0].pressure) { acc, current in
      var pressure = current.pressure
      if simulatePressure {
        let sp = min(1, current.distance / size)
        let rp = min(1, 1 - sp)
        pressure = min(1, acc + (rp - acc) * (sp * rateOfPressureChange))
      }
      return (acc + pressure) / 2
    }
    var currentRadius = radius(points[points.count - 1].pressure)
    var firstRadius: Double?
    var prevVector = points[0].vector
    var pl = points[0].point
    var pr = pl
    var tl = pl
    var tr = pr
    var isPrevPointSharpCorner = false

    for i in points.indices {
      var pressure = points[i].pressure
      let point = points[i].point
      let vector = points[i].vector
      let distance = points[i].distance
      let runningLength = points[i].runningLength
      if i < points.count - 1 && totalLength - runningLength < 3 { continue }
      if thinning != 0 {
        if simulatePressure {
          let sp = min(1, distance / size)
          let rp = min(1, 1 - sp)
          pressure = min(1, prevPressure + (rp - prevPressure) * (sp * rateOfPressureChange))
        }
        currentRadius = radius(pressure)
      } else {
        currentRadius = size / 2
      }
      if firstRadius == nil { firstRadius = currentRadius }
      currentRadius = max(0.01, currentRadius)

      let nextVector = (i < points.count - 1 ? points[i + 1] : points[i]).vector
      let nextDpr = i < points.count - 1 ? dpr(vector, nextVector) : 1.0
      let prevDpr = dpr(vector, prevVector)
      let isPointSharpCorner = prevDpr < 0 && !isPrevPointSharpCorner
      let isNextPointSharpCorner = nextDpr < 0
      if isPointSharpCorner || isNextPointSharpCorner {
        let offset = per(prevVector) * currentRadius
        let step = 1.0 / 13
        var t = 0.0
        while t <= 1 {
          tl = rotAround(point - offset, point, fixedPi * t)
          leftPts.append(tl)
          tr = rotAround(point + offset, point, fixedPi * -t)
          rightPts.append(tr)
          t += step
        }
        pl = tl
        pr = tr
        if isNextPointSharpCorner { isPrevPointSharpCorner = true }
        continue
      }
      isPrevPointSharpCorner = false
      if i == points.count - 1 {
        let offset = per(vector) * currentRadius
        leftPts.append(point - offset)
        rightPts.append(point + offset)
        continue
      }
      let offset = per(lrp(nextVector, vector, nextDpr)) * currentRadius
      tl = point - offset
      if i <= 1 || dist2(pl, tl) > minDistance {
        leftPts.append(tl)
        pl = tl
      }
      tr = point + offset
      if i <= 1 || dist2(pr, tr) > minDistance {
        rightPts.append(tr)
        pr = tr
      }
      prevPressure = pressure
      prevVector = vector
    }

    let firstPoint = points[0].point
    let lastPoint = points.count > 1 ? points[points.count - 1].point : points[0].point + Vec(1, 1)
    var startCap: [Vec] = []
    var endCap: [Vec] = []
    if points.count == 1 {
      let start = prj(firstPoint, uni(per(firstPoint - lastPoint)), -(firstRadius ?? currentRadius))
      var dotPts: [Vec] = []
      let step = 1.0 / 13
      var t = step
      while t <= 1 {
        dotPts.append(rotAround(start, firstPoint, fixedPi * 2 * t))
        t += step
      }
      return dotPts
    }
    if let first = rightPts.first {
      let step = 1.0 / 13
      var t = step
      while t <= 1 {
        startCap.append(rotAround(first, firstPoint, fixedPi * t))
        t += step
      }
    }
    let direction = per(Vec(-points[points.count - 1].vector.x, -points[points.count - 1].vector.y))
    let start = prj(lastPoint, direction, currentRadius)
    let step = 1.0 / 29
    var t = step
    while t < 1 {
      endCap.append(rotAround(start, lastPoint, fixedPi * 3 * t))
      t += step
    }
    return leftPts + endCap + rightPts.reversed() + startCap
  }
}
