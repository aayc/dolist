import Foundation

/// Rough.js's fillers (hachure, cross-hatch, zigzag, dashed, zigzag-line, dots) over the scan-line
/// hachure of `hachure-fill`.
enum RoughFillers {
  typealias Point = DrawingPoint

  static func fillPolygons(_ polygonList: [[Point]], _ o: RoughOptions) -> RoughOpSet {
    var polygons = polygonList
    switch o.fillStyle {
    case "zigzag": return zigzag(&polygons, o)
    case "cross-hatch": return crossHatch(&polygons, o)
    case "dots": return dots(&polygons, o)
    case "dashed": return dashed(&polygons, o)
    case "zigzag-line": return zigzagLine(&polygons, o)
    default: return hachure(&polygons, o)
    }
  }

  // MARK: Fillers

  static func hachure(_ polygons: inout [[Point]], _ o: RoughOptions) -> RoughOpSet {
    let lines = polygonHachureLines(&polygons, o)
    return RoughOpSet(.fillSketch, renderLines(lines, o))
  }

  static func crossHatch(_ polygons: inout [[Point]], _ o: RoughOptions) -> RoughOpSet {
    var set = hachure(&polygons, o)
    let o2 = o.copy()
    o2.hachureAngle = o.hachureAngle + 90
    let set2 = hachure(&polygons, o2)
    set.ops += set2.ops
    return set
  }

  static func zigzag(_ polygons: inout [[Point]], _ o: RoughOptions) -> RoughOpSet {
    var gap = o.hachureGap
    if gap < 0 { gap = o.strokeWidth * 4 }
    gap = max(gap, 0.1)
    let o2 = o.copy()
    o2.hachureGap = gap
    let lines = polygonHachureLines(&polygons, o2)
    let zigZagAngle = (Double.pi / 180) * o.hachureAngle
    var zigzagLines: [(Point, Point)] = []
    let dgx = gap * 0.5 * cos(zigZagAngle)
    let dgy = gap * 0.5 * sin(zigZagAngle)
    for (p1, p2) in lines where lineLength(p1, p2) != 0 {
      zigzagLines.append((Point(p1.x - dgx, p1.y + dgy), p2))
      zigzagLines.append((Point(p1.x + dgx, p1.y - dgy), p2))
    }
    return RoughOpSet(.fillSketch, renderLines(zigzagLines, o))
  }

  static func dots(_ polygons: inout [[Point]], _ o: RoughOptions) -> RoughOpSet {
    let o = o.copy()
    o.hachureAngle = 0
    let lines = polygonHachureLines(&polygons, o)
    var ops: [RoughOp] = []
    var gap = o.hachureGap
    if gap < 0 { gap = o.strokeWidth * 4 }
    gap = max(gap, 0.1)
    var fweight = o.fillWeight
    if fweight < 0 { fweight = o.strokeWidth / 2 }
    let ro = gap / 4
    for line in lines {
      let length = lineLength(line.0, line.1)
      let dl = length / gap
      let count = Int(ceil(dl)) - 1
      let offset = length - (Double(count) * gap)
      let x = ((line.0.x + line.1.x) / 2) - (gap / 4)
      let minY = min(line.0.y, line.1.y)
      for i in 0..<max(count, 0) {
        let y = minY + offset + (Double(i) * gap)
        // Rough.js uses Math.random here; the seeded generator keeps renders stable.
        let cx = (x - ro) + RoughRenderer.random(o) * 2 * ro
        let cy = (y - ro) + RoughRenderer.random(o) * 2 * ro
        ops += RoughRenderer.ellipse(cx, cy, fweight, fweight, o).ops
      }
    }
    return RoughOpSet(.fillSketch, ops)
  }

  static func dashed(_ polygons: inout [[Point]], _ o: RoughOptions) -> RoughOpSet {
    let lines = polygonHachureLines(&polygons, o)
    let offset =
      o.dashOffset < 0 ? (o.hachureGap < 0 ? (o.strokeWidth * 4) : o.hachureGap) : o.dashOffset
    let gap = o.dashGap < 0 ? (o.hachureGap < 0 ? (o.strokeWidth * 4) : o.hachureGap) : o.dashGap
    var ops: [RoughOp] = []
    for line in lines {
      let length = lineLength(line.0, line.1)
      let count = Int((length / (offset + gap)).rounded(.down))
      let startOffset = (length + gap - (Double(count) * (offset + gap))) / 2
      var p1 = line.0
      var p2 = line.1
      if p1.x > p2.x {
        p1 = line.1
        p2 = line.0
      }
      let alpha = atan((p2.y - p1.y) / (p2.x - p1.x))
      for i in 0..<max(count, 0) {
        let lstart = Double(i) * (offset + gap)
        let lend = lstart + offset
        let start = Point(
          p1.x + (lstart * cos(alpha)) + (startOffset * cos(alpha)),
          p1.y + lstart * sin(alpha) + (startOffset * sin(alpha)))
        let end = Point(
          p1.x + (lend * cos(alpha)) + (startOffset * cos(alpha)),
          p1.y + (lend * sin(alpha)) + (startOffset * sin(alpha)))
        ops += RoughRenderer.doubleLineFillOps(start.x, start.y, end.x, end.y, o)
      }
    }
    return RoughOpSet(.fillSketch, ops)
  }

  static func zigzagLine(_ polygons: inout [[Point]], _ o: RoughOptions) -> RoughOpSet {
    let gap = o.hachureGap < 0 ? (o.strokeWidth * 4) : o.hachureGap
    let zo = o.zigzagOffset < 0 ? gap : o.zigzagOffset
    let o = o.copy()
    o.hachureGap = gap + zo
    let lines = polygonHachureLines(&polygons, o)
    var ops: [RoughOp] = []
    for line in lines {
      let length = lineLength(line.0, line.1)
      let count = Int(jsRound(length / (2 * zo)))
      var p1 = line.0
      var p2 = line.1
      if p1.x > p2.x {
        p1 = line.1
        p2 = line.0
      }
      let alpha = atan((p2.y - p1.y) / (p2.x - p1.x))
      for i in 0..<max(count, 0) {
        let lstart = Double(i) * 2 * zo
        let lend = Double(i + 1) * 2 * zo
        let dz = sqrt(2 * pow(zo, 2))
        let start = Point(p1.x + (lstart * cos(alpha)), p1.y + lstart * sin(alpha))
        let end = Point(p1.x + (lend * cos(alpha)), p1.y + (lend * sin(alpha)))
        let middle = Point(
          start.x + dz * cos(alpha + Double.pi / 4), start.y + dz * sin(alpha + Double.pi / 4))
        ops += RoughRenderer.doubleLineFillOps(start.x, start.y, middle.x, middle.y, o)
        ops += RoughRenderer.doubleLineFillOps(middle.x, middle.y, end.x, end.y, o)
      }
    }
    return RoughOpSet(.fillSketch, ops)
  }

  static func renderLines(_ lines: [(Point, Point)], _ o: RoughOptions) -> [RoughOp] {
    var ops: [RoughOp] = []
    for line in lines {
      ops += RoughRenderer.doubleLineFillOps(line.0.x, line.0.y, line.1.x, line.1.y, o)
    }
    return ops
  }

  static func lineLength(_ p1: Point, _ p2: Point) -> Double {
    sqrt(pow(p1.x - p2.x, 2) + pow(p1.y - p2.y, 2))
  }

  /// `polygonHachureLines` (scan-line-hachure.ts).
  static func polygonHachureLines(_ polygons: inout [[Point]], _ o: RoughOptions) -> [(
    Point, Point
  )] {
    let angle = o.hachureAngle + 90
    var gap = o.hachureGap
    if gap < 0 { gap = o.strokeWidth * 4 }
    gap = max(gap, 0.1)
    var skipOffset: Double = 1
    if o.roughness >= 1 {
      var value = o.randomizer?.next() ?? 0
      if value == 0 { value = Double.random(in: 0..<1) }
      if value > 0.7 { skipOffset = gap }
    }
    return HachureFill.hachureLines(&polygons, gap, angle, skipOffset != 0 ? skipOffset : 1)
  }
}

/// `hachure-fill` 0.5.2: parallel lines across polygons at an angle, by scan conversion.
enum HachureFill {
  typealias Point = DrawingPoint

  static func rotatePoints(_ points: inout [Point], _ center: Point, _ degrees: Double) {
    guard !points.isEmpty else { return }
    let angle = (Double.pi / 180) * degrees
    let cosine = cos(angle)
    let sine = sin(angle)
    for index in points.indices {
      let x = points[index].x
      let y = points[index].y
      points[index].x = ((x - center.x) * cosine) - ((y - center.y) * sine) + center.x
      points[index].y = ((x - center.x) * sine) + ((y - center.y) * cosine) + center.y
    }
  }

  /// Rotates the polygons in place and back like the JavaScript (the round trip's rounding
  /// matters to a second pass over the same polygons).
  static func hachureLines(
    _ polygons: inout [[Point]], _ hachureGap: Double, _ hachureAngle: Double,
    _ hachureStepOffset: Double = 1
  ) -> [(Point, Point)] {
    let angle = hachureAngle
    let gap = max(hachureGap, 0.1)
    let center = Point(0, 0)
    if angle != 0 {
      for index in polygons.indices { rotatePoints(&polygons[index], center, angle) }
    }
    var lines = straightHachureLines(polygons, gap, hachureStepOffset)
    if angle != 0 {
      for index in polygons.indices { rotatePoints(&polygons[index], center, -angle) }
      var points = lines.flatMap { [$0.0, $0.1] }
      rotatePoints(&points, center, -angle)
      lines = stride(from: 0, to: points.count, by: 2).map { (points[$0], points[$0 + 1]) }
    }
    return lines
  }

  private final class Edge {
    let ymin: Double
    let ymax: Double
    var x: Double
    let islope: Double

    init(ymin: Double, ymax: Double, x: Double, islope: Double) {
      self.ymin = ymin
      self.ymax = ymax
      self.x = x
      self.islope = islope
    }
  }

  /// A stable sort by a JavaScript-style comparator (negative, zero, positive).
  static func stableSorted<T>(_ items: [T], by compare: (T, T) -> Double) -> [T] {
    items.enumerated().sorted { a, b in
      let order = compare(a.element, b.element)
      return order != 0 ? order < 0 : a.offset < b.offset
    }.map(\.element)
  }

  static func straightHachureLines(
    _ polygons: [[Point]], _ gap: Double, _ hachureStepOffset: Double
  )
    -> [(Point, Point)]
  {
    var vertexArray: [[Point]] = []
    for polygon in polygons where !polygon.isEmpty {
      var vertices = polygon
      if vertices[0] != vertices[vertices.count - 1] {
        vertices.append(vertices[0])
      }
      if vertices.count > 2 { vertexArray.append(vertices) }
    }
    var lines: [(Point, Point)] = []
    let gap = max(gap, 0.1)
    var edges: [Edge] = []
    for vertices in vertexArray {
      for i in 0..<(vertices.count - 1) {
        let p1 = vertices[i]
        let p2 = vertices[i + 1]
        if p1.y != p2.y {
          let ymin = min(p1.y, p2.y)
          edges.append(
            Edge(
              ymin: ymin, ymax: max(p1.y, p2.y), x: ymin == p1.y ? p1.x : p2.x,
              islope: (p2.x - p1.x) / (p2.y - p1.y)))
        }
      }
    }
    edges = stableSorted(edges) { e1, e2 in
      if e1.ymin < e2.ymin { return -1 }
      if e1.ymin > e2.ymin { return 1 }
      if e1.x < e2.x { return -1 }
      if e1.x > e2.x { return 1 }
      if e1.ymax == e2.ymax { return 0 }
      return (e1.ymax - e2.ymax) / abs(e1.ymax - e2.ymax)
    }
    guard !edges.isEmpty else { return lines }
    var activeEdges: [(s: Double, edge: Edge)] = []
    var y = edges[0].ymin
    var iteration: Double = 0
    while !activeEdges.isEmpty || !edges.isEmpty {
      if !edges.isEmpty {
        var ix = -1
        for i in edges.indices {
          if edges[i].ymin > y { break }
          ix = i
        }
        for edge in edges.prefix(ix + 1) { activeEdges.append((y, edge)) }
        edges.removeFirst(ix + 1)
      }
      activeEdges = activeEdges.filter { $0.edge.ymax > y }
      activeEdges = stableSorted(activeEdges) { a, b in
        if a.edge.x == b.edge.x { return 0 }
        return (a.edge.x - b.edge.x) / abs(a.edge.x - b.edge.x)
      }
      if hachureStepOffset != 1 || iteration.truncatingRemainder(dividingBy: gap) == 0 {
        if activeEdges.count > 1 {
          var i = 0
          while i < activeEdges.count {
            let next = i + 1
            if next >= activeEdges.count { break }
            let ce = activeEdges[i].edge
            let ne = activeEdges[next].edge
            lines.append((Point(jsRound(ce.x), y), Point(jsRound(ne.x), y)))
            i += 2
          }
        }
      }
      y += hachureStepOffset
      for active in activeEdges {
        active.edge.x = active.edge.x + (hachureStepOffset * active.edge.islope)
      }
      iteration += 1
    }
    return lines
  }
}
