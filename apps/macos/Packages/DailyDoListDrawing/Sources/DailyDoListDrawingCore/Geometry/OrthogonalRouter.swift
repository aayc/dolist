import Foundation

/// A small rectilinear visibility graph for elbow connectors. Excalidraw routes around the two
/// bound endpoint shapes, not every unrelated canvas object; this graph has a bounded node count.
enum OrthogonalRouter {
  static func route(from start: DrawingPoint, to end: DrawingPoint, avoiding boxes: [DrawingRect])
    -> [DrawingPoint]?
  {
    guard [start.x, start.y, end.x, end.y].allSatisfy({ $0.isFinite && abs($0) <= 1e9 }),
      boxes.count <= 2
    else { return nil }
    let xs = Array(Set([start.x, end.x] + boxes.flatMap { [$0.minX, $0.maxX] })).sorted()
    let ys = Array(Set([start.y, end.y] + boxes.flatMap { [$0.minY, $0.maxY] })).sorted()
    let width = xs.count
    let points = ys.flatMap { y in xs.map { DrawingPoint($0, y) } }
    func blocked(_ point: DrawingPoint) -> Bool {
      boxes.contains {
        point.x > $0.minX && point.x < $0.maxX && point.y > $0.minY && point.y < $0.maxY
      }
    }
    func crosses(_ a: DrawingPoint, _ b: DrawingPoint) -> Bool {
      boxes.contains { box in
        if a.x == b.x {
          return a.x > box.minX && a.x < box.maxX && max(a.y, b.y) > box.minY
            && min(a.y, b.y) < box.maxY
        }
        return a.y > box.minY && a.y < box.maxY && max(a.x, b.x) > box.minX
          && min(a.x, b.x) < box.maxX
      }
    }
    guard let source = points.firstIndex(of: start), let target = points.firstIndex(of: end),
      !blocked(start), !blocked(end)
    else { return nil }
    // State includes the incoming axis so the least-cost route also minimizes unnecessary bends.
    var costs = [Double](repeating: .infinity, count: points.count * 2)
    var parents = [Int: Int]()
    var pending: Set<Int> = [source * 2, source * 2 + 1]
    costs[source * 2] = 0
    costs[source * 2 + 1] = 0
    var destination: Int?
    while let state = pending.min(by: { a, b in costs[a] == costs[b] ? a < b : costs[a] < costs[b] }
    ) {
      pending.remove(state)
      let index = state / 2
      let incomingAxis = state % 2
      if index == target {
        destination = state
        break
      }
      let row = index / width
      let column = index % width
      let neighbors = [
        (column > 0 ? index - 1 : -1, 0), (column + 1 < width ? index + 1 : -1, 0),
        (row > 0 ? index - width : -1, 1), (row + 1 < ys.count ? index + width : -1, 1),
      ]
      for (next, axis) in neighbors where next >= 0 {
        guard !blocked(points[next]), !crosses(points[index], points[next]) else { continue }
        let nextState = next * 2 + axis
        let cost =
          costs[state] + abs(points[next].x - points[index].x)
          + abs(points[next].y - points[index].y)
          + (axis == incomingAxis ? 0 : 16)
        if cost < costs[nextState] {
          costs[nextState] = cost
          parents[nextState] = state
          pending.insert(nextState)
        }
      }
    }
    guard var state = destination else { return nil }
    var result = [points[state / 2]]
    while let previous = parents[state] {
      result.append(points[previous / 2])
      state = previous
    }
    return corners(result.reversed())
  }

  static func corners<S: Sequence>(_ values: S) -> [DrawingPoint] where S.Element == DrawingPoint {
    var result: [DrawingPoint] = []
    for point in values {
      if result.last == point { continue }
      if result.count >= 2 {
        let a = result[result.count - 2]
        let b = result[result.count - 1]
        if (a.x == b.x && b.x == point.x && (b.y - a.y) * (point.y - b.y) >= 0)
          || (a.y == b.y && b.y == point.y && (b.x - a.x) * (point.x - b.x) >= 0)
        {
          result.removeLast()
        }
      }
      result.append(point)
    }
    return result
  }
}
