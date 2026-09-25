import Foundation

/// Reads and writes elements as JSON objects. Unknown fields and element types survive a round
/// trip where they were; a modeled field keeps its source value until it changes; fields that
/// were absent stay absent while they hold the value their absence means.
public enum ElementCodec {
  /// Reads an element; nil when the object has no string `id` and `type`.
  public static func decode(_ object: JSONObject) -> ExcalidrawElement? {
    guard let id = object["id"]?.stringValue, let typeName = object["type"]?.stringValue else {
      return nil
    }
    var element = ExcalidrawElement(id: id, type: ElementType(rawValue: typeName))
    let known = knownKeys(for: element.type)
    let read = Reader(object: object)

    element.x = read.number("x") ?? 0
    element.y = read.number("y") ?? 0
    element.width = read.number("width") ?? 0
    element.height = read.number("height") ?? 0
    element.angle = read.number("angle") ?? 0
    element.strokeColor = read.string("strokeColor") ?? "#1e1e1e"
    element.backgroundColor = read.string("backgroundColor") ?? "transparent"
    element.fillStyle = read.string("fillStyle").map(FillStyle.init(rawValue:)) ?? .solid
    element.strokeWidth = read.number("strokeWidth") ?? 2
    element.strokeStyle = read.string("strokeStyle").map(StrokeStyle.init(rawValue:)) ?? .solid
    element.roughness = read.number("roughness") ?? 1
    element.opacity = read.number("opacity") ?? 100
    element.groupIds = read.stringArray("groupIds") ?? []
    element.frameId = read.string("frameId")
    element.index = read.string("index")
    element.roundness = read.roundness("roundness")
    element.seed = read.integer("seed") ?? 1
    element.version = read.integer("version") ?? 1
    element.versionNonce = read.integer("versionNonce") ?? 0
    element.isDeleted = read.bool("isDeleted") ?? false
    element.boundElements = read.boundElements("boundElements")
    element.updated = read.integer("updated") ?? 1
    element.link = read.string("link")
    element.locked = read.bool("locked") ?? false

    switch element.type {
    case .text:
      let text = read.string("text") ?? ""
      let fontSize = read.number("fontSize") ?? 20
      let fontFamily = read.integer("fontFamily") ?? FontFamily.excalifont
      var properties = TextProperties(
        text: text, fontSize: fontSize, fontFamily: fontFamily,
        textAlign: read.string("textAlign").map(TextAlign.init(rawValue:)) ?? .left,
        verticalAlign: read.string("verticalAlign").map(VerticalAlign.init(rawValue:)) ?? .top,
        containerId: read.string("containerId"),
        originalText: read.string("originalText") ?? text,
        autoResize: read.bool("autoResize") ?? true)
      if let lineHeight = read.number("lineHeight"), lineHeight > 0 {
        properties.lineHeight = lineHeight
      } else {
        // Scenes older than `lineHeight`: Excalidraw's restore measures it from the height.
        let lines = Double(text.split(separator: "\n", omittingEmptySubsequences: false).count)
        let detected = element.height / lines / fontSize
        properties.lineHeight =
          detected.isFinite && detected > 0 ? detected : FontFamily.lineHeight(fontFamily)
      }
      element.text = properties
    case .line, .arrow:
      element.points = read.points("points") ?? []
      element.lastCommittedPoint = read.point("lastCommittedPoint")
      element.startBinding = read.binding("startBinding")
      element.endBinding = read.binding("endBinding")
      element.startArrowhead = read.string("startArrowhead").map(Arrowhead.init(rawValue:))
      if object.contains("endArrowhead") || element.type == .line {
        element.endArrowhead = read.string("endArrowhead").map(Arrowhead.init(rawValue:))
      } else {
        // An arrow saved before arrowheads were stored ends in an arrowhead.
        element.endArrowhead = .arrow
      }
      element.elbowed = read.bool("elbowed") ?? false
    case .freedraw:
      element.points = read.points("points") ?? []
      element.pressures = read.numberArray("pressures") ?? []
      element.simulatePressure = read.bool("simulatePressure") ?? false
      element.lastCommittedPoint = read.point("lastCommittedPoint")
    case .frame, .magicframe:
      element.name = read.string("name")
    default:
      break
    }

    var preserved = PreservedFields()
    preserved.wasRead = true
    preserved.keyOrder = object.keys
    for (key, value) in object where !known.contains(key) {
      preserved.extra[key] = value
    }
    let written = knownValues(of: element)
    for key in known {
      let unchanged = written[key]
      let raw = object[key]
      if raw != unchanged, let unchanged {
        preserved.fallbacks[key] = .init(raw: raw, unchanged: unchanged)
      }
    }
    element.preserved = preserved
    return element
  }

  /// Writes an element: its source keys in their order, then new keys in Excalidraw's order.
  public static func encode(_ element: ExcalidrawElement) -> JSONObject {
    let values = knownValues(of: element)
    let preserved = element.preserved
    var output = JSONObject()
    func value(for key: String) -> JSONValue? {
      guard let current = values[key] else { return preserved.extra[key] }
      if let fallback = preserved.fallbacks[key], fallback.unchanged == current {
        return fallback.raw
      }
      return current
    }
    for key in preserved.keyOrder {
      if let item = value(for: key) { output[key] = item }
    }
    for key in canonicalOrder(for: element.type) where !output.contains(key) {
      if let item = value(for: key) { output[key] = item }
    }
    for key in preserved.extra.keys where !output.contains(key) {
      output[key] = preserved.extra[key]
    }
    return output
  }

  // MARK: Keys

  static let baseKeys = [
    "id", "type", "x", "y", "width", "height", "angle", "strokeColor", "backgroundColor",
    "fillStyle", "strokeWidth", "strokeStyle", "roughness", "opacity", "groupIds", "frameId",
    "index", "roundness", "seed", "version", "versionNonce", "isDeleted", "boundElements",
    "updated", "link", "locked",
  ]
  static let textKeys = [
    "text", "fontSize", "fontFamily", "textAlign", "verticalAlign", "containerId", "originalText",
    "autoResize", "lineHeight",
  ]
  static let linearKeys = [
    "points", "lastCommittedPoint", "startBinding", "endBinding", "startArrowhead", "endArrowhead",
  ]
  static let freedrawKeys = ["points", "pressures", "simulatePressure", "lastCommittedPoint"]

  /// Excalidraw's field order for a new element of a type (`newElement.ts`).
  static func canonicalOrder(for type: ElementType) -> [String] {
    switch type {
    case .text: baseKeys + textKeys
    case .line: baseKeys + linearKeys
    case .arrow: baseKeys + linearKeys + ["elbowed"]
    case .freedraw: baseKeys + freedrawKeys
    case .frame, .magicframe: baseKeys + ["name"]
    default: baseKeys
    }
  }

  static func knownKeys(for type: ElementType) -> Set<String> {
    Set(canonicalOrder(for: type))
  }

  /// Every modeled field of the element as it writes it.
  static func knownValues(of element: ExcalidrawElement) -> [String: JSONValue] {
    var values: [String: JSONValue] = [
      "id": .string(element.id),
      "type": .string(element.type.rawValue),
      "x": .number(element.x),
      "y": .number(element.y),
      "width": .number(element.width),
      "height": .number(element.height),
      "angle": .number(element.angle),
      "strokeColor": .string(element.strokeColor),
      "backgroundColor": .string(element.backgroundColor),
      "fillStyle": .string(element.fillStyle.rawValue),
      "strokeWidth": .number(element.strokeWidth),
      "strokeStyle": .string(element.strokeStyle.rawValue),
      "roughness": .number(element.roughness),
      "opacity": .number(element.opacity),
      "groupIds": .array(element.groupIds.map(JSONValue.string)),
      "frameId": optional(element.frameId),
      "index": optional(element.index),
      "roundness": element.roundness.map(encode) ?? .null,
      "seed": .number(Double(element.seed)),
      "version": .number(Double(element.version)),
      "versionNonce": .number(Double(element.versionNonce)),
      "isDeleted": .bool(element.isDeleted),
      "boundElements": element.boundElements.map {
        .array(
          $0.map { .object(JSONObject([("id", .string($0.id)), ("type", .string($0.type))])) })
      } ?? .null,
      "updated": .number(Double(element.updated)),
      "link": optional(element.link),
      "locked": .bool(element.locked),
    ]
    switch element.type {
    case .text:
      let text = element.text ?? TextProperties(text: "")
      values["text"] = .string(text.text)
      values["fontSize"] = .number(text.fontSize)
      values["fontFamily"] = .number(Double(text.fontFamily))
      values["textAlign"] = .string(text.textAlign.rawValue)
      values["verticalAlign"] = .string(text.verticalAlign.rawValue)
      values["containerId"] = optional(text.containerId)
      values["originalText"] = .string(text.originalText)
      values["autoResize"] = .bool(text.autoResize)
      values["lineHeight"] = .number(text.lineHeight)
    case .line, .arrow:
      values["points"] = encode(element.points)
      values["lastCommittedPoint"] = element.lastCommittedPoint.map(encode) ?? .null
      values["startBinding"] = element.startBinding.map(encode) ?? .null
      values["endBinding"] = element.endBinding.map(encode) ?? .null
      values["startArrowhead"] = optional(element.startArrowhead?.rawValue)
      values["endArrowhead"] = optional(element.endArrowhead?.rawValue)
      if element.type == .arrow { values["elbowed"] = .bool(element.elbowed) }
    case .freedraw:
      values["points"] = encode(element.points)
      values["pressures"] = .array(element.pressures.map(JSONValue.number))
      values["simulatePressure"] = .bool(element.simulatePressure)
      values["lastCommittedPoint"] = element.lastCommittedPoint.map(encode) ?? .null
    case .frame, .magicframe:
      values["name"] = optional(element.name)
    default:
      break
    }
    return values
  }

  private static func optional(_ value: String?) -> JSONValue {
    value.map(JSONValue.string) ?? .null
  }

  private static func encode(_ point: DrawingPoint) -> JSONValue {
    .array([.number(point.x), .number(point.y)])
  }

  private static func encode(_ points: [DrawingPoint]) -> JSONValue {
    .array(points.map(encode))
  }

  private static func encode(_ roundness: Roundness) -> JSONValue {
    var object = JSONObject([("type", .number(Double(roundness.type)))])
    if let value = roundness.value { object["value"] = .number(value) }
    return .object(object)
  }

  private static func encode(_ binding: PointBinding) -> JSONValue {
    var object = JSONObject([
      ("elementId", .string(binding.elementId)), ("focus", .number(binding.focus)),
      ("gap", .number(binding.gap)),
    ])
    for (key, value) in binding.extra { object[key] = value }
    return .object(object)
  }

  /// Typed reads that return nil for a missing key or a value of the wrong type.
  private struct Reader {
    let object: JSONObject

    func number(_ key: String) -> Double? { object[key]?.numberValue }
    func string(_ key: String) -> String? { object[key]?.stringValue }
    func bool(_ key: String) -> Bool? { object[key]?.boolValue }

    func integer(_ key: String) -> Int? {
      guard let value = number(key) else { return nil }
      return Int(exactly: value)
    }

    func stringArray(_ key: String) -> [String]? {
      guard let items = object[key]?.arrayValue else { return nil }
      let strings = items.compactMap(\.stringValue)
      return strings.count == items.count ? strings : nil
    }

    func numberArray(_ key: String) -> [Double]? {
      guard let items = object[key]?.arrayValue else { return nil }
      let numbers = items.compactMap(\.numberValue)
      return numbers.count == items.count ? numbers : nil
    }

    static func point(_ value: JSONValue) -> DrawingPoint? {
      guard let pair = value.arrayValue, pair.count == 2, let x = pair[0].numberValue,
        let y = pair[1].numberValue
      else { return nil }
      return DrawingPoint(x, y)
    }

    func point(_ key: String) -> DrawingPoint? {
      object[key].flatMap(Self.point)
    }

    func points(_ key: String) -> [DrawingPoint]? {
      guard let items = object[key]?.arrayValue else { return nil }
      let points = items.compactMap(Self.point)
      return points.count == items.count ? points : nil
    }

    func roundness(_ key: String) -> Roundness? {
      guard let object = object[key]?.objectValue, let type = object["type"]?.numberValue,
        let typeValue = Int(exactly: type),
        object.keys.allSatisfy({ $0 == "type" || $0 == "value" })
      else { return nil }
      if let value = object["value"] {
        guard let number = value.numberValue else { return nil }
        return Roundness(type: typeValue, value: number)
      }
      return Roundness(type: typeValue)
    }

    func boundElements(_ key: String) -> [BoundElement]? {
      guard let items = object[key]?.arrayValue else { return nil }
      let bound = items.compactMap { item -> BoundElement? in
        guard let entry = item.objectValue, entry.count == 2, let id = entry["id"]?.stringValue,
          let type = entry["type"]?.stringValue
        else { return nil }
        return BoundElement(id: id, type: type)
      }
      return bound.count == items.count ? bound : nil
    }

    func binding(_ key: String) -> PointBinding? {
      guard let object = object[key]?.objectValue, let elementId = object["elementId"]?.stringValue
      else { return nil }
      var extra = JSONObject()
      for (field, value) in object where !["elementId", "focus", "gap"].contains(field) {
        extra[field] = value
      }
      return PointBinding(
        elementId: elementId, focus: object["focus"]?.numberValue ?? 0,
        gap: object["gap"]?.numberValue ?? 0, extra: extra)
    }
  }
}
