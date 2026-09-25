import CoreGraphics
import Foundation

/// One path of a generated shape and how it's painted: Rough.js's `path` (stroked),
/// `fillPath` (filled) and `fillSketch` (hachure lines stroked in the fill color).
public struct ShapePart: @unchecked Sendable {
  public enum Paint: Hashable, Sendable {
    case stroke(color: String, width: Double, dash: [Double]?)
    case fill(color: String, evenOdd: Bool)
    case sketch(color: String, width: Double)
  }

  public var path: CGPath
  public var paint: Paint

  /// The parts of a Rough.js drawable, as `RoughCanvas.draw` paints them.
  static func parts(of drawable: RoughDrawable) -> [ShapePart] {
    let o = drawable.options
    let evenOdd = ["curve", "polygon", "path"].contains(drawable.shape)
    return drawable.sets.compactMap { set in
      switch set.kind {
      case .path:
        guard o.stroke != "none" else { return nil }
        return ShapePart(
          path: set.cgPath,
          paint: .stroke(color: o.stroke, width: o.strokeWidth, dash: o.strokeLineDash))
      case .fillPath:
        return ShapePart(path: set.cgPath, paint: .fill(color: o.fill ?? "", evenOdd: evenOdd))
      case .fillSketch:
        let weight = o.fillWeight < 0 ? o.strokeWidth / 2 : o.fillWeight
        return ShapePart(path: set.cgPath, paint: .sketch(color: o.fill ?? "", width: weight))
      }
    }
  }
}

/// Generated shapes and text layouts per element, reused until something that changes the shape
/// changes (moving an element doesn't: shapes are in the element's own coordinates).
public final class ElementRenderCache: @unchecked Sendable {
  /// What the drawing of an element depends on, besides its position and rotation.
  struct Inputs: Equatable {
    var type: ElementType
    var width: Double
    var height: Double
    var strokeColor: String
    var backgroundColor: String
    var fillStyle: FillStyle
    var strokeWidth: Double
    var strokeStyle: StrokeStyle
    var roughness: Double
    var roundness: Roundness?
    var seed: Int
    var points: [DrawingPoint]
    var startArrowhead: Arrowhead?
    var endArrowhead: Arrowhead?
    var elbowed: Bool
    var pressures: [Double]
    var simulatePressure: Bool
    var finished: Bool
    var text: TextProperties?

    init(_ element: ExcalidrawElement) {
      type = element.type
      width = element.width
      height = element.height
      strokeColor = element.strokeColor
      backgroundColor = element.backgroundColor
      fillStyle = element.fillStyle
      strokeWidth = element.strokeWidth
      strokeStyle = element.strokeStyle
      roughness = element.roughness
      roundness = element.roundness
      seed = element.seed
      points = element.points
      startArrowhead = element.startArrowhead
      endArrowhead = element.endArrowhead
      elbowed = element.elbowed
      pressures = element.pressures
      simulatePressure = element.simulatePressure
      finished = element.lastCommittedPoint != nil
      text = element.text
    }
  }

  /// What drawing an element needs.
  public struct Entry: @unchecked Sendable {
    var version: Int
    var nonce: Int
    var inputs: Inputs
    public var parts: [ShapePart]
    public var freedrawPath: CGPath?
    public var textLayout: TextLayout?
    /// The bounds of `points` (linear and freehand elements), relative to the element.
    public var pointBounds: DrawingRect?
  }

  private let lock = NSLock()
  private var entries: [String: Entry] = [:]
  public private(set) var generatedCount = 0

  public init() {}

  public func entry(for element: ExcalidrawElement) -> Entry {
    if let entry = lock.withLock({ entries[element.id] }) {
      if entry.version == element.version && entry.nonce == element.versionNonce { return entry }
      let inputs = Inputs(element)
      if entry.inputs == inputs {
        var updated = entry
        updated.version = element.version
        updated.nonce = element.versionNonce
        lock.withLock { entries[element.id] = updated }
        return updated
      }
    }
    let entry = Self.make(element)
    lock.withLock {
      entries[element.id] = entry
      generatedCount += 1
    }
    return entry
  }

  /// Forgets elements that are gone.
  public func retain(ids: Set<String>) {
    lock.withLock { entries = entries.filter { ids.contains($0.key) } }
  }

  public func removeAll() {
    lock.withLock { entries.removeAll() }
  }

  static func make(_ element: ExcalidrawElement) -> Entry {
    var parts: [ShapePart] = []
    for drawable in ExcalidrawShapes.drawables(element) {
      parts += ShapePart.parts(of: drawable)
    }
    return Entry(
      version: element.version, nonce: element.versionNonce, inputs: Inputs(element), parts: parts,
      freedrawPath: element.type == .freedraw ? FreedrawOutline.path(of: element) : nil,
      textLayout: element.text.map(TextLayout.init),
      pointBounds: element.type.hasPoints ? DrawingRect(points: element.points) : nil)
  }
}
