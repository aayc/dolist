import Foundation

/// A point in scene coordinates (y grows downward), or relative to an element's `x`/`y`.
public struct DrawingPoint: Hashable, Sendable {
  public var x: Double
  public var y: Double

  public init(_ x: Double, _ y: Double) {
    self.x = x
    self.y = y
  }

  public static let zero = DrawingPoint(0, 0)

  public static func + (lhs: DrawingPoint, rhs: DrawingPoint) -> DrawingPoint {
    DrawingPoint(lhs.x + rhs.x, lhs.y + rhs.y)
  }

  public static func - (lhs: DrawingPoint, rhs: DrawingPoint) -> DrawingPoint {
    DrawingPoint(lhs.x - rhs.x, lhs.y - rhs.y)
  }

  public static func * (lhs: DrawingPoint, rhs: Double) -> DrawingPoint {
    DrawingPoint(lhs.x * rhs, lhs.y * rhs)
  }

  public func distance(to other: DrawingPoint) -> Double {
    hypot(x - other.x, y - other.y)
  }

  /// Rotated by `angle` radians around `center` (clockwise on screen, as in Excalidraw).
  public func rotated(around center: DrawingPoint, by angle: Double) -> DrawingPoint {
    guard angle != 0 else { return self }
    let cosine = cos(angle)
    let sine = sin(angle)
    let dx = x - center.x
    let dy = y - center.y
    return DrawingPoint(dx * cosine - dy * sine + center.x, dx * sine + dy * cosine + center.y)
  }
}

/// An axis-aligned rectangle in scene coordinates.
public struct DrawingRect: Hashable, Sendable {
  public var minX: Double
  public var minY: Double
  public var maxX: Double
  public var maxY: Double

  public init(minX: Double, minY: Double, maxX: Double, maxY: Double) {
    self.minX = minX
    self.minY = minY
    self.maxX = maxX
    self.maxY = maxY
  }

  public init(x: Double, y: Double, width: Double, height: Double) {
    self.init(
      minX: min(x, x + width), minY: min(y, y + height), maxX: max(x, x + width),
      maxY: max(y, y + height))
  }

  /// The smallest rectangle holding every point; nil for none.
  public init?(points: some Sequence<DrawingPoint>) {
    var iterator = points.makeIterator()
    guard let first = iterator.next() else { return nil }
    var rect = DrawingRect(minX: first.x, minY: first.y, maxX: first.x, maxY: first.y)
    while let point = iterator.next() { rect.include(point) }
    self = rect
  }

  public var width: Double { maxX - minX }
  public var height: Double { maxY - minY }
  public var center: DrawingPoint { DrawingPoint((minX + maxX) / 2, (minY + maxY) / 2) }

  public mutating func include(_ point: DrawingPoint) {
    minX = min(minX, point.x)
    minY = min(minY, point.y)
    maxX = max(maxX, point.x)
    maxY = max(maxY, point.y)
  }

  public func union(_ other: DrawingRect) -> DrawingRect {
    DrawingRect(
      minX: min(minX, other.minX), minY: min(minY, other.minY), maxX: max(maxX, other.maxX),
      maxY: max(maxY, other.maxY))
  }

  public func insetBy(_ amount: Double) -> DrawingRect {
    DrawingRect(minX: minX + amount, minY: minY + amount, maxX: maxX - amount, maxY: maxY - amount)
  }

  public func contains(_ point: DrawingPoint) -> Bool {
    point.x >= minX && point.x <= maxX && point.y >= minY && point.y <= maxY
  }

  public func contains(_ rect: DrawingRect) -> Bool {
    rect.minX >= minX && rect.maxX <= maxX && rect.minY >= minY && rect.maxY <= maxY
  }

  public func intersects(_ other: DrawingRect) -> Bool {
    minX <= other.maxX && maxX >= other.minX && minY <= other.maxY && maxY >= other.minY
  }
}

/// An entry of `boundElements`: an arrow bound to this element, or its text label.
public struct BoundElement: Hashable, Sendable {
  public var id: String
  /// `"arrow"` or `"text"`.
  public var type: String

  public init(id: String, type: String) {
    self.id = id
    self.type = type
  }
}

/// `startBinding` / `endBinding`: which element an arrow's end is attached to.
public struct PointBinding: Hashable, Sendable {
  public var elementId: String
  /// -1…1: how far off the element's center the arrow points (0 at the center).
  public var focus: Double
  /// Distance kept between the arrow's end and the element's outline.
  public var gap: Double
  /// Other fields (`fixedPoint` of elbow arrows, a newer Excalidraw's), kept as they were.
  public var extra: JSONObject

  public init(elementId: String, focus: Double, gap: Double, extra: JSONObject = JSONObject()) {
    self.elementId = elementId
    self.focus = focus
    self.gap = gap
    self.extra = extra
  }
}

/// The text of a `text` element and how it's set.
public struct TextProperties: Hashable, Sendable {
  /// What's drawn: `originalText` wrapped to the container.
  public var text: String
  public var fontSize: Double
  public var fontFamily: Int
  public var textAlign: TextAlign
  public var verticalAlign: VerticalAlign
  /// The shape or arrow this label is bound to.
  public var containerId: String?
  /// What the user typed, before wrapping.
  public var originalText: String
  /// The width follows the text (false: the text wraps to `width`).
  public var autoResize: Bool
  /// Unitless (× `fontSize` for pixels).
  public var lineHeight: Double

  public init(
    text: String, fontSize: Double = 20, fontFamily: Int = FontFamily.excalifont,
    textAlign: TextAlign = .left, verticalAlign: VerticalAlign = .top, containerId: String? = nil,
    originalText: String? = nil, autoResize: Bool = true, lineHeight: Double? = nil
  ) {
    self.text = text
    self.fontSize = fontSize
    self.fontFamily = fontFamily
    self.textAlign = textAlign
    self.verticalAlign = verticalAlign
    self.containerId = containerId
    self.originalText = originalText ?? text
    self.autoResize = autoResize
    self.lineHeight = lineHeight ?? FontFamily.lineHeight(fontFamily)
  }

  public var lineHeightPx: Double { fontSize * lineHeight }
}
