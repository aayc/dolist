import Foundation

/// Geometry Excalidraw derives from an element: corner radii, diamond vertices, bounds, and the
/// center it rotates around.
public enum ElementGeometry {
  public static let defaultProportionalRadius = 0.25
  public static let defaultAdaptiveRadius: Double = 32

  /// `getCornerRadius(x, element)`.
  public static func cornerRadius(_ x: Double, _ element: ExcalidrawElement) -> Double {
    guard let roundness = element.roundness else { return 0 }
    switch roundness.type {
    case Roundness.proportionalRadius, Roundness.legacy:
      return x * defaultProportionalRadius
    case Roundness.adaptiveRadius:
      let fixedRadiusSize = roundness.value ?? defaultAdaptiveRadius
      let cutoffSize = fixedRadiusSize / defaultProportionalRadius
      if x <= cutoffSize { return x * defaultProportionalRadius }
      return fixedRadiusSize
    default:
      return 0
    }
  }

  /// `getDiamondPoints`: top, right, bottom, left, relative to the element.
  public static func diamondPoints(_ element: ExcalidrawElement) -> [DrawingPoint] {
    let topX = (element.width / 2).rounded(.down) + 1
    let rightY = (element.height / 2).rounded(.down) + 1
    return [
      DrawingPoint(topX, 0), DrawingPoint(element.width, rightY),
      DrawingPoint(topX, element.height), DrawingPoint(0, rightY),
    ]
  }

  /// `isPathALoop`: a line whose ends meet closes into a fillable shape.
  public static func isPathALoop(_ points: [DrawingPoint], zoom: Double = 1) -> Bool {
    guard points.count >= 3, let first = points.first, let last = points.last else { return false }
    return first.distance(to: last) <= 8 / zoom
  }

  /// The element's unrotated box in scene coordinates (`getElementAbsoluteCoords`, without the
  /// curve refinement for rounded lines).
  public static func unrotatedBounds(_ element: ExcalidrawElement) -> DrawingRect {
    if element.type.hasPoints, let local = DrawingRect(points: element.points) {
      return DrawingRect(
        minX: local.minX + element.x, minY: local.minY + element.y, maxX: local.maxX + element.x,
        maxY: local.maxY + element.y)
    }
    return DrawingRect(x: element.x, y: element.y, width: element.width, height: element.height)
  }

  /// The point the element rotates around.
  public static func center(_ element: ExcalidrawElement) -> DrawingPoint {
    unrotatedBounds(element).center
  }

  /// The axis-aligned box of the rotated element.
  public static func bounds(_ element: ExcalidrawElement) -> DrawingRect {
    let box = unrotatedBounds(element)
    guard element.angle != 0 else { return box }
    let center = box.center
    if element.type.hasPoints {
      let points = element.points.map {
        DrawingPoint($0.x + element.x, $0.y + element.y).rotated(around: center, by: element.angle)
      }
      return DrawingRect(points: points) ?? box
    }
    let corners = [
      DrawingPoint(box.minX, box.minY), DrawingPoint(box.maxX, box.minY),
      DrawingPoint(box.maxX, box.maxY), DrawingPoint(box.minX, box.maxY),
    ].map { $0.rotated(around: center, by: element.angle) }
    return DrawingRect(points: corners) ?? box
  }

  /// Bounds of several elements; nil for none.
  public static func bounds(of elements: some Sequence<ExcalidrawElement>) -> DrawingRect? {
    var result: DrawingRect?
    for element in elements {
      let box = bounds(element)
      result = result.map { $0.union(box) } ?? box
    }
    return result
  }

  /// A point in scene coordinates in the element's own frame (its rotation undone).
  public static func unrotate(_ point: DrawingPoint, in element: ExcalidrawElement) -> DrawingPoint
  {
    point.rotated(around: center(element), by: -element.angle)
  }

  /// `getSizeFromPoints` and the normalization Excalidraw applies after editing points: the
  /// first point at 0,0 is kept as is; `x`/`y` stay, width and height follow the points.
  public static func sizeFromPoints(_ points: [DrawingPoint]) -> (width: Double, height: Double) {
    guard let rect = DrawingRect(points: points) else { return (0, 0) }
    return (rect.width, rect.height)
  }
}
