import DailyDoListDrawingModel
import Foundation
import Testing

@testable import DailyDoListDrawing

/// The port against Rough.js 4.6.4 itself: `fixtures/rough-parity.jsonl` holds the op sets the
/// JavaScript generator produced for each shape, seed and set of options (lines, linear paths,
/// polygons, rectangles, ellipses, circles, curves, Excalidraw's rounded-rectangle and diamond
/// paths; hachure, cross-hatch, zigzag, dashed, zigzag-line and solid fills; sloppiness 0–2).
@Suite("Rough.js parity")
struct RoughParityTests {
  struct Case: Sendable, CustomTestStringConvertible {
    var line: Int
    var object: JSONObject

    var testDescription: String {
      "#\(line) \(object["shape"]?.stringValue ?? "?") seed \(object["options"]?.objectValue?["seed"]?.numberValue ?? 0)"
    }
  }

  static let cases: [Case] = {
    guard let text = try? Fixtures.text("rough-parity.jsonl") else { return [] }
    return text.split(separator: "\n").enumerated().compactMap { index, line in
      (try? JSONParser.parse(String(line)))?.objectValue.map { Case(line: index + 1, object: $0) }
    }
  }()

  @Test func fixturesAreThere() {
    #expect(Self.cases.count == 24)
  }

  @Test(arguments: cases)
  func matchesRoughJS(_ sample: Case) throws {
    let object = sample.object
    let shape = try #require(object["shape"]?.stringValue)
    let args = try #require(object["args"]?.arrayValue)
    let optionsObject = try #require(object["options"]?.objectValue)
    let options = Self.options(optionsObject)
    let drawable: RoughDrawable
    func number(_ index: Int) -> Double { args[index].numberValue ?? .nan }
    func points(_ index: Int) -> [DrawingPoint] {
      (args[index].arrayValue ?? []).map {
        DrawingPoint($0.arrayValue?[0].numberValue ?? .nan, $0.arrayValue?[1].numberValue ?? .nan)
      }
    }
    switch shape {
    case "line": drawable = RoughGenerator.line(number(0), number(1), number(2), number(3), options)
    case "linearPath": drawable = RoughGenerator.linearPath(points(0), options)
    case "polygon": drawable = RoughGenerator.polygon(points(0), options)
    case "curve": drawable = RoughGenerator.curve(points(0), options)
    case "rectangle":
      drawable = RoughGenerator.rectangle(number(0), number(1), number(2), number(3), options)
    case "ellipse":
      drawable = RoughGenerator.ellipse(number(0), number(1), number(2), number(3), options)
    case "circle": drawable = RoughGenerator.circle(number(0), number(1), number(2), options)
    case "path":
      let d = try #require(args[0].stringValue)
      let segments = try #require(RoughPathSegment.parse(d))
      drawable = RoughGenerator.path(segments, options)
    default:
      Issue.record("unknown shape \(shape)")
      return
    }
    #expect(drawable.shape == object["drawable"]?.stringValue)
    let expectedSets = try #require(object["sets"]?.arrayValue)
    try #require(drawable.sets.count == expectedSets.count, "set count")
    for (set, expectedValue) in zip(drawable.sets, expectedSets) {
      let expected = try #require(expectedValue.objectValue)
      #expect(set.kind.rawValue == expected["type"]?.stringValue)
      let expectedOps = try #require(expected["ops"]?.arrayValue)
      try #require(set.ops.count == expectedOps.count, "op count in a \(set.kind) set")
      var worst = 0.0
      for (op, expectedOp) in zip(set.ops, expectedOps) {
        let items = try #require(expectedOp.arrayValue)
        #expect(op.kind.rawValue == items[0].stringValue)
        let data = items.dropFirst().map { $0.numberValue ?? .nan }
        try #require(op.data.count == data.count)
        for (value, reference) in zip(op.data, data) { worst = max(worst, abs(value - reference)) }
      }
      #expect(worst < 1e-7, "largest difference \(worst)")
    }
  }

  static func options(_ object: JSONObject) -> RoughOptions {
    RoughGenerator.options { o in
      for (key, value) in object {
        switch key {
        case "seed": o.seed = value.numberValue ?? 0
        case "roughness": o.roughness = value.numberValue ?? 1
        case "strokeWidth": o.strokeWidth = value.numberValue ?? 1
        case "fill": o.fill = value.stringValue
        case "fillStyle": o.fillStyle = value.stringValue ?? "hachure"
        case "fillWeight": o.fillWeight = value.numberValue ?? -1
        case "hachureGap": o.hachureGap = value.numberValue ?? -1
        case "curveFitting": o.curveFitting = value.numberValue ?? 0.95
        case "preserveVertices": o.preserveVertices = value.boolValue ?? false
        case "disableMultiStroke": o.disableMultiStroke = value.boolValue ?? false
        case "stroke": o.stroke = value.stringValue ?? "#000"
        case "strokeLineDash": o.strokeLineDash = value.arrayValue?.compactMap(\.numberValue)
        default: Issue.record("unhandled option \(key)")
        }
      }
    }
  }
}
