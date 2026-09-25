import Foundation

/// A resize handle of the selection box.
public enum TransformHandle: String, CaseIterable, Hashable, Sendable {
  case nw, n, ne, e, se, s, sw, w

  var isCorner: Bool { self == .nw || self == .ne || self == .se || self == .sw }
  var movesLeft: Bool { self == .nw || self == .w || self == .sw }
  var movesRight: Bool { self == .ne || self == .e || self == .se }
  var movesTop: Bool { self == .nw || self == .n || self == .ne }
  var movesBottom: Bool { self == .sw || self == .s || self == .se }
}

/// What the selection looks like on screen: its box (rotated with a single rotated element), the
/// resize handles, and for a single line or arrow its points instead.
public struct SelectionFrame: Sendable {
  /// The unrotated box around the selection, in scene coordinates.
  public var rect: DrawingRect
  public var angle: Double
  /// Handles by kind, in scene coordinates (rotated).
  public var handles: [TransformHandle: DrawingPoint]
  /// A single line's or arrow's points (draggable), in scene coordinates.
  public var pointHandles: [DrawingPoint]
  /// Several elements: each one's box is outlined too.
  public var elementRects: [(rect: DrawingRect, angle: Double)]

  public var center: DrawingPoint { rect.center }

  /// The box's corners in scene coordinates, rotated.
  public var corners: [DrawingPoint] {
    [
      DrawingPoint(rect.minX, rect.minY), DrawingPoint(rect.maxX, rect.minY),
      DrawingPoint(rect.maxX, rect.maxY), DrawingPoint(rect.minX, rect.maxY),
    ].map { $0.rotated(around: rect.center, by: angle) }
  }

  /// Excalidraw's handles: 8 around the box (sides only when there's room), a few screen pixels
  /// outside it.
  static func make(for elements: [ExcalidrawElement], zoom: Double) -> SelectionFrame? {
    guard !elements.isEmpty else { return nil }
    let padding = 5 / zoom
    if elements.count == 1, let element = elements.first {
      let box = ElementGeometry.unrotatedBounds(element)
      if element.type.isLinear && element.points.count >= 2 {
        let points = element.points.map {
          DrawingPoint(element.x + $0.x, element.y + $0.y).rotated(
            around: box.center, by: element.angle)
        }
        return SelectionFrame(
          rect: box.insetBy(-padding), angle: element.angle, handles: [:], pointHandles: points,
          elementRects: [])
      }
      let rect = box.insetBy(-padding)
      return SelectionFrame(
        rect: rect, angle: element.angle, handles: handles(rect, angle: element.angle, zoom: zoom),
        pointHandles: [], elementRects: [])
    }
    guard let union = ElementGeometry.bounds(of: elements) else { return nil }
    let rect = union.insetBy(-padding)
    return SelectionFrame(
      rect: rect, angle: 0, handles: handles(rect, angle: 0, zoom: zoom, cornersOnly: true),
      pointHandles: [],
      elementRects: elements.map { (ElementGeometry.unrotatedBounds($0), $0.angle) })
  }

  static func handles(_ rect: DrawingRect, angle: Double, zoom: Double, cornersOnly: Bool = false)
    -> [TransformHandle: DrawingPoint]
  {
    let (minX, minY, maxX, maxY) = (rect.minX, rect.minY, rect.maxX, rect.maxY)
    let midX = (minX + maxX) / 2
    let midY = (minY + maxY) / 2
    var result: [TransformHandle: DrawingPoint] = [
      .nw: DrawingPoint(minX, minY), .ne: DrawingPoint(maxX, minY),
      .se: DrawingPoint(maxX, maxY), .sw: DrawingPoint(minX, maxY),
    ]
    // Side handles only where they don't crowd the corners (about 40 screen pixels).
    if !cornersOnly {
      if rect.width * zoom > 40 {
        result[.n] = DrawingPoint(midX, minY)
        result[.s] = DrawingPoint(midX, maxY)
      }
      if rect.height * zoom > 40 {
        result[.w] = DrawingPoint(minX, midY)
        result[.e] = DrawingPoint(maxX, midY)
      }
    }
    return result.mapValues { $0.rotated(around: rect.center, by: angle) }
  }

  /// The handle within `radius` of a point.
  func handle(at point: DrawingPoint, radius: Double) -> TransformHandle? {
    TransformHandle.allCases.first { kind in
      handles[kind].map { $0.distance(to: point) <= radius } ?? false
    }
  }

  func pointHandle(at point: DrawingPoint, radius: Double) -> Int? {
    pointHandles.indices.min {
      pointHandles[$0].distance(to: point) < pointHandles[$1].distance(to: point)
    }
    .flatMap { pointHandles[$0].distance(to: point) <= radius ? $0 : nil }
  }
}
