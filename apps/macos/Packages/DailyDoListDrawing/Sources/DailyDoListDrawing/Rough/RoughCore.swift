// A port of Rough.js 4.6.4 (https://github.com/rough-stuff/rough, MIT, © 2019 Preet Shihn), the
// version Excalidraw 0.18 draws with, with its dependencies hachure-fill 0.5.2, points-on-curve
// 0.2.0 and points-on-path 0.2.1 (MIT, same author). The structure, names and the order of
// operations follow the JavaScript, so the same seed and options give the same strokes.

import Foundation

/// Rough.js's seeded generator: `Math.imul(48271, seed)` masked to 31 bits.
final class RoughRandom {
  private var seed: Int32

  init(seed: Double) {
    self.seed = jsToInt32(seed)
  }

  func next() -> Double {
    if seed != 0 {
      seed = seed &* 48271
      return Double(Int32.max & seed) / 2_147_483_648
    }
    return Double.random(in: 0..<1)
  }
}

/// ECMAScript ToInt32.
func jsToInt32(_ value: Double) -> Int32 {
  guard value.isFinite else { return 0 }
  let truncated = value.rounded(.towardZero)
  let modulo = truncated.truncatingRemainder(dividingBy: 4_294_967_296)
  let positive = modulo < 0 ? modulo + 4_294_967_296 : modulo
  return Int32(bitPattern: UInt32(positive))
}

/// `Math.round`: halves round toward +∞.
func jsRound(_ value: Double) -> Double {
  let floor = value.rounded(.down)
  return value - floor >= 0.5 ? floor + 1 : floor
}

/// One drawing operation (`{ op, data }`): a move, a cubic Bézier or a line.
public struct RoughOp: Hashable, Sendable {
  public enum Kind: String, Hashable, Sendable {
    case move
    case bcurveTo
    case lineTo
  }

  public var kind: Kind
  /// `[x, y]` for moves and lines, `[x1, y1, x2, y2, x, y]` for curves.
  public var data: [Double]

  public init(_ kind: Kind, _ data: [Double]) {
    self.kind = kind
    self.data = data
  }
}

/// A list of operations drawn in one go: stroked (`path`), filled (`fillPath`), or stroked with
/// the fill color and weight (`fillSketch`, hachure lines).
public struct RoughOpSet: Hashable, Sendable {
  public enum Kind: String, Hashable, Sendable {
    case path
    case fillPath
    case fillSketch
  }

  public var kind: Kind
  public var ops: [RoughOp]

  public init(_ kind: Kind, _ ops: [RoughOp]) {
    self.kind = kind
    self.ops = ops
  }
}

/// A generated shape: what it is (for the fill rule), its op sets, and the options it used.
public struct RoughDrawable: Sendable {
  public var shape: String
  public var sets: [RoughOpSet]
  public var options: RoughOptions.Resolved
}

/// Rough.js options. A class, like the JavaScript object it ports: the generator hands the same
/// instance around, and the random generator it creates on first use is shared by its copies.
public final class RoughOptions: @unchecked Sendable {
  public var maxRandomnessOffset: Double = 2
  public var roughness: Double = 1
  public var bowing: Double = 1
  /// `"none"` draws no outline.
  public var stroke: String = "#000"
  public var strokeWidth: Double = 1
  public var curveTightness: Double = 0
  public var curveFitting: Double = 0.95
  public var curveStepCount: Double = 9
  public var fillStyle: String = "hachure"
  public var fillWeight: Double = -1
  public var hachureAngle: Double = -41
  public var hachureGap: Double = -1
  public var dashOffset: Double = -1
  public var dashGap: Double = -1
  public var zigzagOffset: Double = -1
  public var seed: Double = 0
  public var disableMultiStroke = false
  public var disableMultiStrokeFill = false
  public var preserveVertices = false
  public var fillShapeRoughnessGain: Double = 0.8
  public var fill: String?
  public var strokeLineDash: [Double]?
  var randomizer: RoughRandom?

  public init() {}

  /// `Object.assign({}, o)`: every field, the random generator included.
  func copy() -> RoughOptions {
    let other = RoughOptions()
    other.maxRandomnessOffset = maxRandomnessOffset
    other.roughness = roughness
    other.bowing = bowing
    other.stroke = stroke
    other.strokeWidth = strokeWidth
    other.curveTightness = curveTightness
    other.curveFitting = curveFitting
    other.curveStepCount = curveStepCount
    other.fillStyle = fillStyle
    other.fillWeight = fillWeight
    other.hachureAngle = hachureAngle
    other.hachureGap = hachureGap
    other.dashOffset = dashOffset
    other.dashGap = dashGap
    other.zigzagOffset = zigzagOffset
    other.seed = seed
    other.disableMultiStroke = disableMultiStroke
    other.disableMultiStrokeFill = disableMultiStrokeFill
    other.preserveVertices = preserveVertices
    other.fillShapeRoughnessGain = fillShapeRoughnessGain
    other.fill = fill
    other.strokeLineDash = strokeLineDash
    other.randomizer = randomizer
    return other
  }

  /// What drawing needs from the options, as a value.
  public struct Resolved: Hashable, Sendable {
    public var stroke: String
    public var strokeWidth: Double
    public var fill: String?
    public var fillWeight: Double
    public var strokeLineDash: [Double]?
  }

  var resolved: Resolved {
    Resolved(
      stroke: stroke, strokeWidth: strokeWidth, fill: fill, fillWeight: fillWeight,
      strokeLineDash: strokeLineDash)
  }
}
