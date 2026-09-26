import Foundation

/// An Excalidraw scene (`type: "excalidraw"`, `version: 2`): its elements in z-order (deleted
/// ones included, as tombstones for merges), the `appState` subset and the `files` map, both kept
/// verbatim, and any other top-level field.
public struct ExcalidrawScene: Hashable, Sendable {
  public var type: String = "excalidraw"
  public var version: Int = 2
  public var source: String?
  public var elements: [ExcalidrawElement]
  /// Kept as read: `viewBackgroundColor`, `gridSize`, the plugin's `currentItem…` defaults.
  public var appState: JSONObject
  /// Image data by file id, kept as read (images aren't drawn yet).
  public var files: JSONValue
  /// Other top-level keys and the order they came in.
  public internal(set) var preserved = PreservedFields()

  public init(
    elements: [ExcalidrawElement] = [], appState: JSONObject? = nil,
    files: JSONValue = .object(.init()),
    source: String? = ExcalidrawScene.defaultSource
  ) {
    self.elements = elements
    self.appState =
      appState ?? JSONObject([("gridSize", .null), ("viewBackgroundColor", .string("#ffffff"))])
    self.files = files
    self.source = source
  }

  /// `source` of scenes this app creates (`DRAWING_SCENE_SOURCE` in `@ddl/core`): the plugin reads
  /// its version from `source` and treats anything else as a pre-1.8.16 drawing, so it names the
  /// plugin version whose format we follow.
  public static let defaultSource =
    "https://github.com/zsviczian/obsidian-excalidraw-plugin/releases/tag/2.27.3"

  /// The canvas color (`appState.viewBackgroundColor`), white when unset.
  public var viewBackgroundColor: String {
    appState["viewBackgroundColor"]?.stringValue ?? "#ffffff"
  }

  /// Elements that aren't deleted, in z-order.
  public var visibleElements: [ExcalidrawElement] { elements.filter { !$0.isDeleted } }

  /// The element with an id (deleted or not).
  public func element(id: String) -> ExcalidrawElement? {
    elements.first { $0.id == id }
  }
}
