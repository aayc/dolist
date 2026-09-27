import Foundation

/// Compatible with .excalidrawlib v2. Private names/files are additive fields ignored by older
/// web libraries; unknown item metadata remains intact when exporting imported libraries.
public struct DrawingLibraryItem: Identifiable, Hashable, Sendable {
  public var id: String
  public var name: String
  public var created: Double
  public var scene: ExcalidrawScene
  public var metadata: JSONObject
  public init(
    id: String = UUID().uuidString, name: String,
    created: Double = Date().timeIntervalSince1970 * 1000, scene: ExcalidrawScene,
    metadata: JSONObject = JSONObject()
  ) {
    self.id = id
    self.name = name
    self.created = created
    self.scene = scene
    self.metadata = metadata
  }
}

public enum DrawingLibraryCodec {
  public static func decode(_ data: Data) throws -> [DrawingLibraryItem] {
    guard data.count <= DrawingClipboard.maximumBytes else { throw DrawingTransferError.tooLarge }
    guard let text = String(data: data, encoding: .utf8),
      let object = try JSONParser.parse(text).objectValue,
      object["type"]?.stringValue == "excalidrawlib"
    else { throw DrawingTransferError.invalid }
    let values = object["libraryItems"]?.arrayValue ?? object["library"]?.arrayValue ?? []
    guard values.count <= 1000 else { throw DrawingTransferError.tooLarge }
    return try values.enumerated().map { index, value in
      var metadata = value.objectValue ?? JSONObject()
      let elements = metadata["elements"] ?? (value.arrayValue.map(JSONValue.array))
      guard let elements else { throw DrawingTransferError.invalid }
      var sceneObject = JSONObject([
        ("elements", elements), ("files", metadata["files"] ?? .object(JSONObject())),
      ])
      sceneObject["type"] = .string("excalidraw")
      let scene = try DrawingClipboard.decode(JSONWriter.string(.object(sceneObject)))
      let id = metadata["id"]?.stringValue ?? UUID().uuidString
      let name = metadata["name"]?.stringValue ?? "Shape \(index + 1)"
      let created = metadata["created"]?.numberValue ?? 0
      metadata["elements"] = nil
      metadata["files"] = nil
      return DrawingLibraryItem(
        id: id, name: name, created: created, scene: scene, metadata: metadata)
    }
  }

  public static func encode(_ items: [DrawingLibraryItem]) -> Data {
    let values = items.map { item -> JSONValue in
      var object = item.metadata
      object["id"] = .string(item.id)
      object["name"] = .string(item.name)
      object["created"] = .number(item.created)
      if object["status"] == nil { object["status"] = .string("unpublished") }
      object["elements"] = .array(item.scene.elements.map { .object(ElementCodec.encode($0)) })
      if item.scene.files.objectValue?.isEmpty == false { object["files"] = item.scene.files }
      return .object(object)
    }
    return Data(
      JSONWriter.string(
        .object(
          JSONObject([
            ("type", .string("excalidrawlib")), ("version", .number(2)),
            ("source", .string("https://github.com/aayc/dolist")), ("libraryItems", .array(values)),
          ]))
      ).utf8)
  }
}
