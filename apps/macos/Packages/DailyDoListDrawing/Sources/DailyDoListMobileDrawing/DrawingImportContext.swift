import DailyDoListDrawingCore
import DailyDoListModels
import Foundation

public enum MobileDrawingImportError: LocalizedError, Equatable, Sendable {
  case uploadTooLarge, readOnly
  public var errorDescription: String? {
    switch self {
    case .uploadTooLarge:
      "This import would make the drawing too large to sync with the host's 5 MB request limit. Choose a smaller image or fewer shapes. The drawing was left unchanged."
    case .readOnly: "This drawing is no longer editable. The import was not applied."
    }
  }
}

/// The document owner supplies its latest preserved source and conditional version at commit time.
/// This includes frontmatter, other sections, retained tombstones/files and JSON string escaping.
public struct DrawingImportContext: Sendable {
  public static let maximumRequestBytes = 5 * 1024 * 1024
  public var previous: ExcalidrawMarkdown?
  public var baseVersion: String?
  public init(previous: ExcalidrawMarkdown? = nil, baseVersion: String? = nil) {
    self.previous = previous
    self.baseVersion = baseVersion
  }
  public func requestBytes(for scene: ExcalidrawScene) throws -> Int {
    let content = try ExcalidrawMarkdown.serialize(scene, previous: previous)
    return try JSONEncoder.daemon.encode(
      WriteNoteRequest(
        content: content, baseVersion: baseVersion.map { .match($0) } ?? .createOnly)
    ).count
  }
  public func validate(_ scene: ExcalidrawScene) throws {
    guard try requestBytes(for: scene) <= Self.maximumRequestBytes else {
      throw MobileDrawingImportError.uploadTooLarge
    }
  }
}
