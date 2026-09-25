import Foundation

/// Whether a point hits an element, and how far a point is from an element's outline: filled
/// shapes, text and images are hit inside, outlines within a threshold, lines and freehand
/// strokes near their path.
public enum HitTest {
  typealias P = DrawingPoint

  /// - Parameter threshold: in scene units (about 10 screen pixels).
  public static func hits(_ element: ExcalidrawElement, _ point: DrawingPoint, threshold: Double)
    -> Bool
  {
    let local = ElementGeometry.unrotate(point, in: element) - DrawingPoint(element.x, element.y)
    let t = threshold + element.strokeWidth / 2
    switch element.type {
    case .rectangle, .embeddable, .iframe:
      if isFilled(element), insideRect(local, element, margin: t) { return true }
      return abs(roundedRectDistance(local, element)) <= t
    case .text, .image:
      return insideRect(local, element, margin: t)
    case .frame, .magicframe:
      let nameArea =
        local.y >= -24 && local.y <= 0 && local.x >= 0 && local.x <= max(element.width, 60)
      return nameArea || abs(roundedRectDistance(local, element)) <= t
    case .ellipse:
      let d = ellipseDistance(local, element)
      return isFilled(element) ? d <= t : abs(d) <= t
    case .diamond:
      let polygon = ElementGeometry.diamondPoints(element)
      if isFilled(element), pointInPolygon(local, polygon) { return true }
      return polylineDistance(local, polygon + [polygon[0]]) <= t
    case .line, .arrow:
      let path = sampledPath(element)
      if element.type == .line, ElementGeometry.isPathALoop(element.points), isFilled(element),
        pointInPolygon(local, path)
      {
        return true
      }
      return polylineDistance(local, path) <= t
    case .freedraw:
      return polylineDistance(local, element.points.isEmpty ? [.zero] : element.points)
        <= t + element.strokeWidth * 2
    default:
      return insideRect(local, element, margin: t)
    }
  }

  /// A filled shape can be grabbed anywhere inside.
  static func isFilled(_ element: ExcalidrawElement) -> Bool {
    !DrawingColor.isTransparent(element.backgroundColor)
  }

  static func insideRect(_ p: P, _ element: ExcalidrawElement, margin: Double) -> Bool {
    let minX = min(0, element.width) - margin
    let maxX = max(0, element.width) + margin
    let minY = min(0, element.height) - margin
    let maxY = max(0, element.height) + margin
    return p.x >= minX && p.x <= maxX && p.y >= minY && p.y <= maxY
  }

  /// Signed distance to the element's (rounded) rectangle, negative inside.
  static func roundedRectDistance(_ p: P, _ element: ExcalidrawElement) -> Double {
    let w = abs(element.width)
    let h = abs(element.height)
    let r = min(ElementGeometry.cornerRadius(min(w, h), element), min(w, h) / 2)
    let qx = abs(p.x - w / 2) - (w / 2 - r)
    let qy = abs(p.y - h / 2) - (h / 2 - r)
    return hypot(max(qx, 0), max(qy, 0)) + min(max(qx, qy), 0) - r
  }

  /// Approximate signed distance to the ellipse inscribed in the element's box.
  static func ellipseDistance(_ p: P, _ element: ExcalidrawElement) -> Double {
    let a = max(abs(element.width) / 2, 0.5)
    let b = max(abs(element.height) / 2, 0.5)
    let x = p.x - element.width / 2
    let y = p.y - element.height / 2
    let normalized = hypot(x / a, y / b)
    guard normalized > 0 else { return -min(a, b) }
    let radial = hypot(x, y)
    return radial - radial / normalized
  }

  static func pointInPolygon(_ p: P, _ polygon: [P]) -> Bool {
    guard polygon.count >= 3 else { return false }
    var inside = false
    var j = polygon.count - 1
    for i in polygon.indices {
      let a = polygon[i]
      let b = polygon[j]
      if (a.y > p.y) != (b.y > p.y), p.x < (b.x - a.x) * (p.y - a.y) / (b.y - a.y) + a.x {
        inside.toggle()
      }
      j = i
    }
    return inside
  }

  static func segmentDistance(_ p: P, _ a: P, _ b: P) -> Double {
    sqrt(PointsOnCurve.distanceToSegmentSq(p, a, b))
  }

  static func polylineDistance(_ p: P, _ points: [P]) -> Double {
    guard let first = points.first else { return .infinity }
    guard points.count > 1 else { return p.distance(to: first) }
    var best = Double.infinity
    for i in 1..<points.count {
      best = min(best, segmentDistance(p, points[i - 1], points[i]))
    }
    return best
  }

  /// The path of a line or arrow (its curve, sampled, when rounded), in element coordinates.
  public static func sampledPath(_ element: ExcalidrawElement) -> [DrawingPoint] {
    let points = element.points.isEmpty ? [DrawingPoint.zero] : element.points
    guard element.roundness != nil, points.count >= 3, !element.elbowed else { return points }
    let bezier = PointsOnCurve.curveToBezier(points)
    var result: [DrawingPoint] = [bezier[0]]
    var index = 0
    while index + 3 < bezier.count {
      let (p0, p1, p2, p3) = (
        bezier[index], bezier[index + 1], bezier[index + 2], bezier[index + 3]
      )
      for step in 1...12 {
        let t = Double(step) / 12
        let u = 1 - t
        let x = u * u * u * p0.x + 3 * u * u * t * p1.x + 3 * u * t * t * p2.x + t * t * t * p3.x
        let y = u * u * u * p0.y + 3 * u * u * t * p1.y + 3 * u * t * t * p2.y + t * t * t * p3.y
        result.append(DrawingPoint(x, y))
      }
      index += 3
    }
    return result
  }

  /// The top-most element under a point (labels count as their container), skipping locked and
  /// deleted elements.
  public static func topElement(
    at point: DrawingPoint, in elements: [ExcalidrawElement], byId: [String: ExcalidrawElement],
    threshold: Double, excluding excluded: Set<String> = []
  ) -> ExcalidrawElement? {
    for element in elements.reversed() where !element.isDeleted && !element.locked {
      guard !excluded.contains(element.id), hits(element, point, threshold: threshold) else {
        continue
      }
      if let containerId = element.containerId, let container = byId[containerId],
        !container.isDeleted
      {
        return container
      }
      return element
    }
    return nil
  }
}
