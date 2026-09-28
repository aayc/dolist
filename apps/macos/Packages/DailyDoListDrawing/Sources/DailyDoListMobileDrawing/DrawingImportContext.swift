import DailyDoListDrawingCore
import DailyDoListModels
import Foundation

public enum MobileDrawingImportError: LocalizedError, Equatable, Sendable {
  case uploadTooLarge, readOnly, targetUnavailable
  public var errorDescription: String? {
    switch self {
    case .uploadTooLarge:
      "This would make the drawing too large to sync: the host accepts at most 5 MB per save, including the drawing's text and every embedded image. Choose a smaller image or fewer shapes. The drawing was left unchanged."
    case .readOnly: "This drawing is no longer editable. The import was not applied."
    case .targetUnavailable:
      "The image to replace was removed or locked meanwhile. The drawing was left unchanged."
    }
  }
}

/// What the drawing's next sync request will carry besides the scene. The document owner supplies
/// its latest file (frontmatter, other sections, text elements) and the conditional version, so
/// the measurement is the exact `WriteNoteRequest` body the daemon will receive.
public struct DrawingImportContext: Sendable {
  /// The daemon's request body limit (`WIRE_LIMITS.bodyBytes`); a body of exactly this size passes.
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
