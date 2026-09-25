import CoreGraphics
import Foundation

/// A global screen point: origin at the top-left of the main display, y grows downward (the
/// coordinate space of CoreGraphics events, the window list and the accessibility API).
public struct Point: Hashable, Sendable {
  public var x: Double
  public var y: Double

  public init(x: Double, y: Double) {
    self.x = x
    self.y = y
  }

  var cgPoint: CGPoint { CGPoint(x: x, y: y) }
}

public struct Size: Hashable, Sendable {
  public var width: Double
  public var height: Double

  public init(width: Double, height: Double) {
    self.width = width
    self.height = height
  }
}

/// A rectangle in global screen points.
public struct Rect: Hashable, Sendable {
  public var x: Double
  public var y: Double
  public var width: Double
  public var height: Double

  public init(x: Double, y: Double, width: Double, height: Double) {
    self.x = x
    self.y = y
    self.width = width
    self.height = height
  }

  init(_ rect: CGRect) {
    self.init(
      x: Double(rect.origin.x), y: Double(rect.origin.y), width: Double(rect.width),
      height: Double(rect.height))
  }

  /// Half-open: the right and bottom edges belong to the next rectangle.
  public func contains(_ point: Point) -> Bool {
    width > 0 && height > 0 && point.x >= x && point.x < x + width && point.y >= y
      && point.y < y + height
  }

  /// Whether both rectangles have the same frame, give or take `tolerance` points per edge.
  func matches(_ other: Rect, tolerance: Double = 2) -> Bool {
    abs(x - other.x) <= tolerance && abs(y - other.y) <= tolerance
      && abs(width - other.width) <= tolerance && abs(height - other.height) <= tolerance
  }

  var json: JSONValue {
    [
      "x": .number(Self.round(x)), "y": .number(Self.round(y)),
      "width": .number(Self.round(width)), "height": .number(Self.round(height)),
    ]
  }

  static func round(_ value: Double) -> Double { (value * 100).rounded() / 100 }
}
