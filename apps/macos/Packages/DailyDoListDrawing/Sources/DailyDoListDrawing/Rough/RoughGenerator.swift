import Foundation

/// Rough.js's `RoughGenerator`: shapes as op sets, ready to draw. Each call takes a fresh options
/// object (like `_o(options)`), whose random generator starts from `options.seed`.
public enum RoughGenerator {
  typealias Point = DrawingPoint

  /// `defaultOptions` with Excalidraw's overrides applied by the caller.
  public static func options(_ configure: (RoughOptions) -> Void = { _ in }) -> RoughOptions {
    let options = RoughOptions()
    configure(options)
    return options
  }

  public static func line(
    _ x1: Double, _ y1: Double, _ x2: Double, _ y2: Double, _ options: RoughOptions
  ) -> RoughDrawable {
    let o = options.copy()
    return drawable("line", [RoughRenderer.line(x1, y1, x2, y2, o)], o)
  }

  public static func rectangle(
    _ x: Double, _ y: Double, _ width: Double, _ height: Double, _ options: RoughOptions
  ) -> RoughDrawable {
    let o = options.copy()
    var paths: [RoughOpSet] = []
    let outline = RoughRenderer.rectangle(x, y, width, height, o)
    if o.fill != nil {
      let points = [
        Point(x, y), Point(x + width, y), Point(x + width, y + height), Point(x, y + height),
      ]
      if o.fillStyle == "solid" {
        paths.append(RoughRenderer.solidFillPolygon([points], o))
      } else {
        paths.append(RoughRenderer.patternFillPolygons([points], o))
      }
    }
    if o.stroke != "none" { paths.append(outline) }
    return drawable("rectangle", paths, o)
  }

  public static func ellipse(
    _ x: Double, _ y: Double, _ width: Double, _ height: Double, _ options: RoughOptions
  ) -> RoughDrawable {
    let o = options.copy()
    var paths: [RoughOpSet] = []
    let params = RoughRenderer.generateEllipseParams(width, height, o)
    let response = RoughRenderer.ellipseWithParams(x, y, o, params)
    if o.fill != nil {
      if o.fillStyle == "solid" {
        var shape = RoughRenderer.ellipseWithParams(x, y, o, params).opset
        shape.kind = .fillPath
        paths.append(shape)
      } else {
        paths.append(RoughRenderer.patternFillPolygons([response.estimatedPoints], o))
      }
    }
    if o.stroke != "none" { paths.append(response.opset) }
    return drawable("ellipse", paths, o)
  }

  public static func circle(
    _ x: Double, _ y: Double, _ diameter: Double, _ options: RoughOptions
  ) -> RoughDrawable {
    var result = ellipse(x, y, diameter, diameter, options)
    result.shape = "circle"
    return result
  }

  public static func linearPath(_ points: [DrawingPoint], _ options: RoughOptions) -> RoughDrawable
  {
    let o = options.copy()
    return drawable("linearPath", [RoughRenderer.linearPath(points, close: false, o)], o)
  }

  public static func curve(_ points: [DrawingPoint], _ options: RoughOptions) -> RoughDrawable {
    let o = options.copy()
    var paths: [RoughOpSet] = []
    let outline = RoughRenderer.curve(points, o)
    if let fill = o.fill, fill != "none", points.count >= 3 {
      if o.fillStyle == "solid" {
        let fillOptions = o.copy()
        fillOptions.disableMultiStroke = true
        fillOptions.roughness = o.roughness != 0 ? (o.roughness + o.fillShapeRoughnessGain) : 0
        let fillShape = RoughRenderer.curve(points, fillOptions)
        paths.append(RoughOpSet(.fillPath, mergedShape(fillShape.ops)))
      } else {
        let bcurve = PointsOnCurve.curveToBezier(points)
        let polyPoints = PointsOnCurve.pointsOnBezierCurves(
          bcurve, tolerance: 10, distance: (1 + o.roughness) / 2)
        paths.append(RoughRenderer.patternFillPolygons([polyPoints], o))
      }
    }
    if o.stroke != "none" { paths.append(outline) }
    return drawable("curve", paths, o)
  }

  public static func polygon(_ points: [DrawingPoint], _ options: RoughOptions) -> RoughDrawable {
    let o = options.copy()
    var paths: [RoughOpSet] = []
    let outline = RoughRenderer.linearPath(points, close: true, o)
    if o.fill != nil {
      if o.fillStyle == "solid" {
        paths.append(RoughRenderer.solidFillPolygon([points], o))
      } else {
        paths.append(RoughRenderer.patternFillPolygons([points], o))
      }
    }
    if o.stroke != "none" { paths.append(outline) }
    return drawable("polygon", paths, o)
  }

  /// `path(d)` for a path already parsed and absolutized.
  public static func path(_ segments: [RoughPathSegment], _ options: RoughOptions) -> RoughDrawable
  {
    let o = options.copy()
    var paths: [RoughOpSet] = []
    guard !segments.isEmpty else { return drawable("path", paths, o) }
    let normalized = RoughPathSegment.normalize(segments)
    let hasFill = o.fill != nil && o.fill != "transparent" && o.fill != "none"
    let hasStroke = o.stroke != "none"
    let distance = (1 + o.roughness) / 2
    let sets = PointsOnCurve.pointsOnPath(normalized, tolerance: 1, distance: distance)
    let shape = RoughRenderer.svgPath(normalized, o)
    if hasFill {
      if o.fillStyle == "solid" {
        if sets.count == 1 {
          let fillOptions = o.copy()
          fillOptions.disableMultiStroke = true
          fillOptions.roughness = o.roughness != 0 ? (o.roughness + o.fillShapeRoughnessGain) : 0
          let fillShape = RoughRenderer.svgPath(normalized, fillOptions)
          paths.append(RoughOpSet(.fillPath, mergedShape(fillShape.ops)))
        } else {
          paths.append(RoughRenderer.solidFillPolygon(sets, o))
        }
      } else {
        paths.append(RoughRenderer.patternFillPolygons(sets, o))
      }
    }
    if hasStroke { paths.append(shape) }
    return drawable("path", paths, o)
  }

  static func mergedShape(_ input: [RoughOp]) -> [RoughOp] {
    input.enumerated().filter { index, op in index == 0 || op.kind != .move }.map(\.element)
  }

  private static func drawable(_ shape: String, _ sets: [RoughOpSet], _ o: RoughOptions)
    -> RoughDrawable
  {
    RoughDrawable(shape: shape, sets: sets, options: o.resolved)
  }
}
