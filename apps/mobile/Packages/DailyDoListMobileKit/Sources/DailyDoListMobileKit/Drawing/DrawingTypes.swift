import DailyDoListDrawingModel
import Foundation

public enum DrawingRepositoryError: Error, Equatable, Sendable {
  case unreadableFile
  case unsupportedFormat
  case invalidScene
  case unsupportedElementChanged
}

public struct LocalDrawing: Sendable {
  public let path: String
  /// Exact durable file, including frontmatter and every non-scene section.
  public let content: String
  public let document: ExcalidrawMarkdown
  public let localRevision: Int64
  public let acknowledgedRevision: Int64
  public let baseVersion: String?
  public let state: NoteSyncState
  public let reviewReason: ReviewReason?
  public let editingError: DrawingRepositoryError?
  public let recoveryCopies: [URL]
  public let workingFile: URL
  public var canEdit: Bool { editingError == nil }
}

enum DrawingValidation {
  static func error(_ document: ExcalidrawMarkdown) -> DrawingRepositoryError? {
    guard document.readable, document.problems.isEmpty else { return .unreadableFile }
    return error(document.scene)
  }

  static func error(_ scene: ExcalidrawScene) -> DrawingRepositoryError? {
    guard scene.type == "excalidraw", scene.version == 2 else { return .unsupportedFormat }
    let encoded = SceneCodec.encodeObject(scene)
    // The shared decoder deliberately preserves malformed/newer known fields as fallbacks.
    // A tolerant decoded default must not authorize writing over that original raw value.
    if let type = encoded["type"], type != .string("excalidraw") { return .unsupportedFormat }
    if let version = encoded["version"], version != .number(2) { return .unsupportedFormat }
    if let state = encoded["appState"], state.objectValue == nil { return .invalidScene }
    guard scene.files.objectValue != nil else { return .invalidScene }
    guard Set(scene.elements.map(\.id)).count == scene.elements.count,
      scene.elements.allSatisfy({
        !$0.id.isEmpty && $0.x.isFinite && $0.y.isFinite && $0.width.isFinite && $0.height.isFinite
          && $0.angle.isFinite
      })
    else { return .invalidScene }
    return nil
  }

  static func serialized(_ scene: ExcalidrawScene, previous: ExcalidrawMarkdown?) throws -> String {
    if let error = previous.flatMap(error) ?? error(scene) { throw error }
    // Unsupported placeholders are retained verbatim while known elements remain editable.
    for element in previous?.scene.elements ?? [] where !element.type.isSupported {
      guard scene.elements.contains(element) else {
        throw DrawingRepositoryError.unsupportedElementChanged
      }
    }
    return try ExcalidrawMarkdown.serialize(scene, previous: previous)
  }
}
