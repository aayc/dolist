import Foundation

/// Why a scene couldn't be read.
public enum SceneCodecError: Error, Equatable, CustomStringConvertible {
  case invalidJSON(JSONParseError)
  case notAnObject
  case missingElements

  public var description: String {
    switch self {
    case .invalidJSON(let error): "The drawing isn't valid JSON (\(error))."
    case .notAnObject: "The drawing isn't a JSON object."
    case .missingElements: "The drawing has no elements list."
    }
  }
}

/// Excalidraw scene JSON: reads a scene (or Excalidraw's clipboard payload) and writes it the way
/// `JSON.stringify(scene, null, "\t")` does in the Obsidian plugin.
public enum SceneCodec {
  public static func decode(_ text: String) throws -> ExcalidrawScene {
    let value: JSONValue
    do {
      value = try JSONParser.parse(text)
    } catch let error as JSONParseError {
      throw SceneCodecError.invalidJSON(error)
    }
    return try decode(value)
  }

  public static func decode(_ value: JSONValue) throws -> ExcalidrawScene {
    guard let object = value.objectValue else { throw SceneCodecError.notAnObject }
    guard let items = object["elements"]?.arrayValue else { throw SceneCodecError.missingElements }
    var elements: [ExcalidrawElement] = []
    var unreadable = JSONObject()
    elements.reserveCapacity(items.count)
    for (offset, item) in items.enumerated() {
      if let element = item.objectValue.flatMap(ElementCodec.decode) {
        elements.append(element)
      } else {
        // Not an element this engine can place: keep it where it was.
        unreadable[String(offset)] = item
      }
    }
    var scene = ExcalidrawScene(
      elements: elements, appState: object["appState"]?.objectValue ?? JSONObject(),
      files: object["files"] ?? .object(JSONObject()), source: object["source"]?.stringValue)
    scene.type = object["type"]?.stringValue ?? "excalidraw"
    scene.version = object["version"]?.numberValue.flatMap { Int(exactly: $0) } ?? 2
    var preserved = PreservedFields()
    preserved.keyOrder = object.keys
    for (key, item) in object where !sceneKeys.contains(key) { preserved.extra[key] = item }
    for key in sceneKeys {
      let unchanged = knownValues(of: scene)[key]
      if object[key] != unchanged, let unchanged, key != "elements" {
        preserved.fallbacks[key] = .init(raw: object[key], unchanged: unchanged)
      }
    }
    if !unreadable.isEmpty { preserved.extra[unreadableKey] = .object(unreadable) }
    scene.preserved = preserved
    return scene
  }

  /// The scene's JSON, tab-indented like the Obsidian plugin writes it.
  public static func encode(_ scene: ExcalidrawScene, indent: String = "\t") -> String {
    JSONWriter.string(.object(encodeObject(scene)), indent: indent)
  }

  public static func encodeObject(_ scene: ExcalidrawScene) -> JSONObject {
    var values = knownValues(of: scene)
    var elements = scene.elements.map { JSONValue.object(ElementCodec.encode($0)) }
    if let unreadable = scene.preserved.extra[unreadableKey]?.objectValue {
      for (key, item) in unreadable.sorted(by: { Int($0.key)! < Int($1.key)! }) {
        elements.insert(item, at: min(Int(key)!, elements.count))
      }
    }
    values["elements"] = .array(elements)
    let preserved = scene.preserved
    func value(for key: String) -> JSONValue? {
      guard let current = values[key] else { return preserved.extra[key] }
      if let fallback = preserved.fallbacks[key], fallback.unchanged == current {
        return fallback.raw
      }
      return current
    }
    var output = JSONObject()
    for key in preserved.keyOrder + sceneKeys where !output.contains(key) {
      if let item = value(for: key) { output[key] = item }
    }
    for (key, item) in preserved.extra where key != unreadableKey && !output.contains(key) {
      output[key] = item
    }
    return output
  }

  static let sceneKeys = ["type", "version", "source", "elements", "appState", "files"]
  /// Where array entries that aren't elements wait to be written back (never written itself).
  static let unreadableKey = "\u{0}unreadable"

  private static func knownValues(of scene: ExcalidrawScene) -> [String: JSONValue] {
    var values: [String: JSONValue] = [
      "type": .string(scene.type),
      "version": .number(Double(scene.version)),
      "appState": .object(scene.appState),
      "files": scene.files,
    ]
    if let source = scene.source { values["source"] = .string(source) }
    return values
  }
}
