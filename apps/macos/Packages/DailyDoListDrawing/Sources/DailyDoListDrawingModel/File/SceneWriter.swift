import Foundation

/// The scene object a drawing file stores (`sceneForWriting` in `@ddl/core`): `type`, `version`,
/// `source`, `elements`, `appState`, `files`, then other keys; fields the scene lacks come from
/// the previous file, in the previous order.
enum SceneWriter {
  /// Where the plugin's `source` points, followed by its version.
  static let pluginSourcePrefix =
    "https://github.com/zsviczian/obsidian-excalidraw-plugin/releases/tag/"
  static let sceneKeys: Set<String> = [
    "type", "version", "source", "elements", "appState", "files",
  ]

  static func object(for scene: ExcalidrawScene, previous: ExcalidrawScene?) -> JSONObject {
    let current = SceneCodec.encodeObject(scene)
    let old = previous.map(SceneCodec.encodeObject)
    let merged = old.map { mergeFields(current, $0) } ?? current

    var previousElements: [String: JSONObject] = [:]
    for item in old?["elements"]?.arrayValue ?? [] {
      if let element = item.objectValue, let id = element["id"]?.stringValue,
        previousElements[id] == nil
      {
        previousElements[id] = element
      }
    }
    let elements = (current["elements"]?.arrayValue ?? []).map { item -> JSONValue in
      guard let element = item.objectValue else { return item }
      let id = element["id"]?.stringValue ?? ""
      let before = previousElements[id]
      let merged = before.map { mergeFields(element, $0) } ?? element
      return .object(withFreshRawText(merged, previous: before))
    }
    let appState = mergeFields(
      current["appState"]?.objectValue ?? JSONObject(),
      old?["appState"]?.objectValue ?? JSONObject())
    let files: JSONObject
    if let currentFiles = current["files"]?.objectValue {
      files = mergeFiles(currentFiles, old?["files"]?.objectValue)
    } else {
      files = old?["files"]?.objectValue ?? JSONObject()
    }
    var output = JSONObject()
    output["type"] = .string(merged["type"]?.stringValue ?? "excalidraw")
    output["version"] = .number(merged["version"]?.numberValue ?? 2)
    output["source"] = .string(source(scene.source, previous: previous?.source))
    output["elements"] = .array(elements)
    output["appState"] = .object(appState)
    output["files"] = .object(files)
    for (key, value) in merged where !sceneKeys.contains(key) { output[key] = value }
    return output
  }

  /// A plugin `source` stays; anything else becomes the previous file's plugin source or ours.
  static func source(_ source: String?, previous: String?) -> String {
    if let source, source.hasPrefix(pluginSourcePrefix) { return source }
    if let previous, previous.hasPrefix(pluginSourcePrefix) { return previous }
    return ExcalidrawScene.defaultSource
  }

  /// Keys of `previous` in its order (values from `next` when it has them), then `next`'s others.
  static func mergeFields(_ next: JSONObject, _ previous: JSONObject) -> JSONObject {
    var output = JSONObject()
    for (key, value) in previous { output[key] = next[key] ?? value }
    for (key, value) in next where !output.contains(key) { output[key] = value }
    return output
  }

  static func mergeFiles(_ files: JSONObject, _ previous: JSONObject?) -> JSONObject {
    var output = JSONObject()
    for (id, file) in files {
      if let file = file.objectValue, let old = previous?[id]?.objectValue {
        output[id] = .object(mergeFields(file, old))
      } else {
        output[id] = file
      }
    }
    return output
  }

  /// `rawText` follows the text once it differs from the previous file's (editors that don't
  /// know `rawText` would otherwise have the plugin restore the old text).
  static func withFreshRawText(_ element: JSONObject, previous: JSONObject?) -> JSONObject {
    guard element["type"]?.stringValue == "text", let raw = element["rawText"]?.stringValue,
      let previous
    else { return element }
    let text = displayText(element)
    if displayText(previous) != text && raw != text {
      var updated = element
      updated["rawText"] = .string(text)
      return updated
    }
    return element
  }

  static func displayText(_ element: JSONObject) -> String {
    if let original = element["originalText"]?.stringValue, !original.isEmpty { return original }
    return element["text"]?.stringValue ?? ""
  }

  /// `## Text Elements` for the written scene: live text elements in scene order.
  static func textEntries(_ scene: JSONObject) -> [TextElementEntry] {
    (scene["elements"]?.arrayValue ?? []).compactMap { item in
      guard let element = item.objectValue, element["type"]?.stringValue == "text",
        element["isDeleted"]?.boolValue != true, let id = element["id"]?.stringValue
      else { return nil }
      let raw = element["rawText"]?.stringValue ?? ""
      return TextElementEntry(id: id, text: raw.isEmpty ? displayText(element) : raw)
    }
  }
}
