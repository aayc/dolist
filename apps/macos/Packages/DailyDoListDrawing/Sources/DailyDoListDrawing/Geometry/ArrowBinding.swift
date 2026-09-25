import Foundation

/// Arrows attached to shapes, as Excalidraw 0.18's `binding.ts` does it: an arrow's end binds to
/// the shape under it (within a gap that grows with the shape), remembering where it points
/// (`focus`, −1…1 off the center) and how far it stays from the outline (`gap`); when the shape
/// or the arrow's other points move, the end is placed again on the outline.
public enum ArrowBinding {
  typealias P = DrawingPoint

  /// `BINDING_HIGHLIGHT_THICKNESS` + `BINDING_HIGHLIGHT_OFFSET`.
  static let highlightGap: Double = 14

  /// `maxBindingGap`.
  public static func maxBindingGap(_ element: ExcalidrawElement, zoom: Double = 1) -> Double {
    let zoomValue = zoom < 1 ? zoom : 1
    let shapeRatio = element.type == .diamond ? 1 / sqrt(2) : 1
    let smaller = shapeRatio * min(element.width, element.height)
    return max(16, min(0.25 * smaller, 32), 10 / zoomValue + 4)
  }

  /// `distanceToBindableElement`: distance from a scene point to the element's outline.
  public static func distance(to element: ExcalidrawElement, _ point: DrawingPoint) -> Double {
    let local = ElementGeometry.unrotate(point, in: element) - P(element.x, element.y)
    switch element.type {
    case .diamond:
      let polygon = ElementGeometry.diamondPoints(element)
      return HitTest.polylineDistance(local, polygon + [polygon[0]])
    case .ellipse:
      return abs(HitTest.ellipseDistance(local, element))
    default:
      return abs(HitTest.roundedRectDistance(local, element))
    }
  }

  /// `bindingBorderTest`: near the outline, or inside a solidly filled shape.
  public static func borderTest(_ element: ExcalidrawElement, _ point: DrawingPoint, zoom: Double)
    -> Bool
  {
    if distance(to: element, point) <= maxBindingGap(element, zoom: zoom) { return true }
    let fallsThrough =
      element.fillStyle != .solid || DrawingColor.isTransparent(element.backgroundColor)
    guard !fallsThrough else { return false }
    return HitTest.hits(element, point, threshold: 0)
  }

  /// The top-most shape an arrow's end at `point` would bind to.
  public static func bindableElement(
    at point: DrawingPoint, in elements: [ExcalidrawElement], excluding excluded: Set<String>,
    zoom: Double
  ) -> ExcalidrawElement? {
    for element in elements.reversed()
    where !element.isDeleted && !element.locked && element.type.isBindable
      && !element.type.isFrameLike && !excluded.contains(element.id)
    {
      if element.type == .text, element.containerId != nil { continue }
      if borderTest(element, point, zoom: zoom) { return element }
    }
    return nil
  }

  /// `FIXED_BINDING_DISTANCE`: how far outside the outline an end released near it sits.
  static let fixedBindingDistance: Double = 5

  /// `bindPointToSnapToElementOutline`: an end released on or near the shape's outline (inside or
  /// out, within the binding gap) goes `fixedBindingDistance` outside it, along the arrow's last
  /// segment, which leaves Excalidraw's small gap before the tip. Nil for an end deep inside
  /// (it points at the shape's focus instead).
  static func snappedToOutline(
    _ arrow: ExcalidrawElement, end: ArrowEnd, target: ExcalidrawElement, zoom: Double = 1
  ) -> P? {
    guard arrow.points.count >= 2, !arrow.elbowed else { return nil }
    let edge = absolutePoint(arrow, end == .start ? 0 : arrow.points.count - 1)
    let adjacent = absolutePoint(arrow, end == .start ? 1 : arrow.points.count - 2)
    guard distance(to: target, edge) <= maxBindingGap(target, zoom: zoom) else { return nil }
    let direction = edge - adjacent
    let length = hypot(direction.x, direction.y)
    guard length > 0 else { return nil }
    let reach = length + max(target.width, target.height) * 2
    let far = adjacent + direction * (reach / length)
    return intersections(target, adjacent, far, offset: fixedBindingDistance)
      .min { $0.distance(to: adjacent) < $1.distance(to: adjacent) }
  }

  /// `calculateFocusAndGap` then `normalizePointBinding`.
  static func binding(
    for arrow: ExcalidrawElement, end: ArrowEnd, to target: ExcalidrawElement, zoom: Double = 1
  ) -> PointBinding {
    let edgeIndex = end == .start ? 0 : arrow.points.count - 1
    let adjacentIndex = end == .start ? 1 : arrow.points.count - 2
    let edge = absolutePoint(arrow, edgeIndex)
    let adjacent = absolutePoint(arrow, max(0, min(arrow.points.count - 1, adjacentIndex)))
    let focus = determineFocusDistance(target, adjacent, edge)
    var gap = max(1, distance(to: target, edge))
    if gap > maxBindingGap(target) { gap = highlightGap }
    return PointBinding(elementId: target.id, focus: focus, gap: gap)
  }

  public enum ArrowEnd: Sendable {
    case start
    case end
  }

  static func absolutePoint(_ arrow: ExcalidrawElement, _ index: Int) -> P {
    let point = arrow.points.isEmpty ? P.zero : arrow.points[index]
    let absolute = P(arrow.x + point.x, arrow.y + point.y)
    return arrow.angle == 0
      ? absolute : absolute.rotated(around: ElementGeometry.center(arrow), by: arrow.angle)
  }

  static func cross(_ a: P, _ b: P) -> Double { a.x * b.y - b.x * a.y }

  /// Segment–segment intersection (`lineSegmentIntersectionPoints`).
  static func segmentIntersection(_ a1: P, _ a2: P, _ b1: P, _ b2: P) -> P? {
    let r = a2 - a1
    let s = b2 - b1
    let denominator = cross(r, s)
    guard abs(denominator) > 1e-12 else { return nil }
    let t = cross(b1 - a1, s) / denominator
    let u = cross(b1 - a1, r) / denominator
    guard t >= -1e-9, t <= 1 + 1e-9, u >= -1e-9, u <= 1 + 1e-9 else { return nil }
    return a1 + r * t
  }

  /// `determineFocusDistance(element, a, b)`: a is the arrow's adjacent point, b its end.
  static func determineFocusDistance(_ element: ExcalidrawElement, _ a: P, _ b: P) -> Double {
    let center = P(element.x + element.width / 2, element.y + element.height / 2)
    if a == b { return 0 }
    let rotatedA = a.rotated(around: center, by: -element.angle)
    let rotatedB = b.rotated(around: center, by: -element.angle)
    // Math.sign(cross) * -1, with `a` unrotated as in Excalidraw.
    let turn = cross(rotatedB - a, rotatedB - center)
    let sign: Double = turn > 0 ? -1 : (turn < 0 ? 1 : 0)
    let direction = rotatedA - rotatedB
    let length = hypot(direction.x, direction.y)
    guard length > 0 else { return 0 }
    let reach = max(element.width * 2, element.height * 2)
    let interceptorEnd = rotatedB + direction * (reach / length)
    let (x, y, w, h) = (element.x, element.y, element.width, element.height)
    let axes: [(P, P)]
    let interceptees: [(P, P)]
    if element.type == .diamond {
      axes = [(P(x + w / 2, y), P(x + w / 2, y + h)), (P(x, y + h / 2), P(x + w, y + h / 2))]
      interceptees = [
        (P(x + w / 2, y - h), P(x + w / 2, y + h * 2)),
        (P(x - w, y + h / 2), P(x + w * 2, y + h / 2)),
      ]
    } else {
      axes = [(P(x, y), P(x + w, y + h)), (P(x + w, y), P(x, y + h))]
      interceptees = [
        (P(x - w, y - h), P(x + w * 2, y + h * 2)), (P(x + w * 2, y - h), P(x - w, y + h * 2)),
      ]
    }
    var candidates: [(point: P, axis: Int)] = []
    for (index, line) in interceptees.enumerated() {
      if let point = segmentIntersection(rotatedB, interceptorEnd, line.0, line.1) {
        candidates.append((point, index))
      }
    }
    candidates.sort { $0.point.distance(to: b) < $1.point.distance(to: b) }
    let ratios = candidates.enumerated().map { rank, candidate -> Double in
      let half =
        element.type == .diamond
        ? axes[rank].0.distance(to: axes[rank].1) / 2 : sqrt(w * w + h * h) / 2
      return sign * center.distance(to: candidate.point) / half
    }.sorted { abs($0) < abs($1) }
    return ratios.first ?? 0
  }

  /// `determineFocusPoint`.
  static func determineFocusPoint(_ element: ExcalidrawElement, _ focus: Double, _ adjacent: P) -> P
  {
    let center = P(element.x + element.width / 2, element.y + element.height / 2)
    if focus == 0 { return center }
    let (x, y, w, h) = (element.x, element.y, element.width, element.height)
    let corners: [P] =
      element.type == .diamond
      ? [P(x, y + h / 2), P(x + w / 2, y), P(x + w, y + h / 2), P(x + w / 2, y + h)]
      : [P(x, y), P(x + w, y), P(x + w, y + h), P(x, y + h)]
    let c = corners.map { ($0 - center) * abs(focus) + center }.map {
      $0.rotated(around: center, by: element.angle)
    }
    func side(_ i: Int) -> Double { cross(adjacent - c[i], c[(i + 1) % 4] - c[i]) }
    let selected = [
      side(0) > 0 && (focus > 0 ? side(1) < 0 : side(3) < 0),
      side(1) > 0 && (focus > 0 ? side(2) < 0 : side(0) < 0),
      side(2) > 0 && (focus > 0 ? side(3) < 0 : side(1) < 0),
      side(3) > 0 && (focus > 0 ? side(0) < 0 : side(2) < 0),
    ]
    if selected[0] { return focus > 0 ? c[1] : c[0] }
    if selected[1] { return focus > 0 ? c[2] : c[1] }
    if selected[2] { return focus > 0 ? c[3] : c[2] }
    return focus > 0 ? c[0] : c[3]
  }

  /// Where a segment crosses the element's outline pushed out by `offset`
  /// (`intersectElementWithLineSegment`).
  static func intersections(_ element: ExcalidrawElement, _ a: P, _ b: P, offset: Double) -> [P] {
    let center = P(element.x + element.width / 2, element.y + element.height / 2)
    let ra = a.rotated(around: center, by: -element.angle)
    let rb = b.rotated(around: center, by: -element.angle)
    var points: [P] = []
    switch element.type {
    case .ellipse:
      // Excalidraw intersects the whole line with the ellipse.
      let rx = element.width / 2 + offset
      let ry = element.height / 2 + offset
      let d = rb - ra
      let o = ra - center
      let qa = d.x * d.x / (rx * rx) + d.y * d.y / (ry * ry)
      let qb = 2 * (o.x * d.x / (rx * rx) + o.y * d.y / (ry * ry))
      let qc = o.x * o.x / (rx * rx) + o.y * o.y / (ry * ry) - 1
      let discriminant = qb * qb - 4 * qa * qc
      guard qa > 0, discriminant >= 0 else { return [] }
      let root = sqrt(discriminant)
      for t in Set([(-qb - root) / (2 * qa), (-qb + root) / (2 * qa)]) {
        points.append(ra + d * t)
      }
    default:
      let outline = offsetOutline(element, offset: offset)
      for i in outline.indices {
        if let point = segmentIntersection(ra, rb, outline[i], outline[(i + 1) % outline.count]) {
          if !points.contains(where: { $0.distance(to: point) < 1e-6 }) { points.append(point) }
        }
      }
    }
    return points.map { $0.rotated(around: center, by: element.angle) }
  }

  /// The outline pushed out by `offset`, as a polygon in scene coordinates (unrotated).
  static func offsetOutline(_ element: ExcalidrawElement, offset: Double) -> [P] {
    let origin = P(element.x, element.y)
    if element.type == .diamond {
      let d = ElementGeometry.diamondPoints(element).map { $0 + origin }
      // Each side moved out along its normal; corners where neighboring sides meet.
      var lines: [(P, P)] = []
      let center = P(element.x + element.width / 2, element.y + element.height / 2)
      for i in 0..<4 {
        let p1 = d[i]
        let p2 = d[(i + 1) % 4]
        let edge = p2 - p1
        let length = max(hypot(edge.x, edge.y), 1e-9)
        var normal = P(edge.y / length, -edge.x / length)
        if (normal.x * ((p1.x + p2.x) / 2 - center.x) + normal.y * ((p1.y + p2.y) / 2 - center.y))
          < 0
        {
          normal = normal * -1
        }
        lines.append((p1 + normal * offset, p2 + normal * offset))
      }
      return (0..<4).map { i in
        let l1 = lines[(i + 3) % 4]
        let l2 = lines[i]
        return lineIntersection(l1.0, l1.1, l2.0, l2.1) ?? l2.0
      }
    }
    let w = abs(element.width)
    let h = abs(element.height)
    let r = min(ElementGeometry.cornerRadius(min(w, h), element), min(w, h) / 2) + offset
    let minX = min(element.x, element.x + element.width) - offset
    let minY = min(element.y, element.y + element.height) - offset
    let maxX = minX + w + 2 * offset
    let maxY = minY + h + 2 * offset
    guard r > 0.5 else { return [P(minX, minY), P(maxX, minY), P(maxX, maxY), P(minX, maxY)] }
    var outline: [P] = []
    let corners = [
      (P(maxX - r, minY + r), -Double.pi / 2), (P(maxX - r, maxY - r), 0.0),
      (P(minX + r, maxY - r), Double.pi / 2), (P(minX + r, minY + r), Double.pi),
    ]
    for (center, start) in corners {
      for step in 0...6 {
        let angle = start + Double(step) / 6 * (Double.pi / 2)
        outline.append(P(center.x + r * cos(angle), center.y + r * sin(angle)))
      }
    }
    return outline
  }

  static func lineIntersection(_ a1: P, _ a2: P, _ b1: P, _ b2: P) -> P? {
    let r = a2 - a1
    let s = b2 - b1
    let denominator = cross(r, s)
    guard abs(denominator) > 1e-12 else { return nil }
    return a1 + r * (cross(b1 - a1, s) / denominator)
  }

  /// `updateBoundPoint`: where the bound end goes now, in scene coordinates; nil to leave it.
  static func updatedEndPoint(
    _ arrow: ExcalidrawElement, end: ArrowEnd, binding: PointBinding, target: ExcalidrawElement
  ) -> P? {
    guard arrow.points.count >= 2 else { return nil }
    let edgeIndex = end == .start ? 0 : arrow.points.count - 1
    let adjacentIndex = end == .start ? 1 : arrow.points.count - 2
    let adjacent = absolutePoint(arrow, adjacentIndex)
    if arrow.elbowed, let fixed = binding.extra["fixedPoint"]?.arrayValue, fixed.count == 2,
      let fx = fixed[0].numberValue, let fy = fixed[1].numberValue
    {
      let center = P(target.x + target.width / 2, target.y + target.height / 2)
      return P(target.x + fx * target.width, target.y + fy * target.height).rotated(
        around: center, by: target.angle)
    }
    let focusPoint = determineFocusPoint(target, binding.focus, adjacent)
    if binding.gap == 0 { return focusPoint }
    let edge = absolutePoint(arrow, edgeIndex)
    let center = P(target.x + target.width / 2, target.y + target.height / 2)
    let length =
      adjacent.distance(to: edge) + adjacent.distance(to: center) + max(target.width, target.height)
      * 2
    let direction = focusPoint - adjacent
    let norm = hypot(direction.x, direction.y)
    guard norm > 0 else { return edge }
    let far = adjacent + direction * (length / norm)
    let hits = intersections(target, adjacent, far, offset: binding.gap).sorted {
      $0.distance(to: adjacent) < $1.distance(to: adjacent)
    }
    if hits.count > 1 { return hits[0] }
    if hits.count == 1 { return focusPoint }
    return edge
  }
}
