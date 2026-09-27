#if canImport(UIKit)
  import DailyDoListEditorCore
  import DailyDoListMobileDrawing
  import Foundation

  public struct MobileEditorAttachment: Sendable {
    public var path: String
    public var data: Data
    public var mimeType: String
    /// The host's version/hash; changes whenever the bytes change.
    public var version: String
    public init(path: String, data: Data, mimeType: String, version: String) {
      self.path = path
      self.data = data
      self.mimeType = mimeType
      self.version = version
    }
  }

  public enum MobileEditorAttachmentState: Sendable {
    case missing, unavailable
    case ready(MobileEditorAttachment)
  }

  /// Host operations retain authentication, path resolution, offline storage and scene persistence.
  /// Set a new identity when either the host credentials or the owning note changes.
  @MainActor
  public struct MobileEditorEmbedHost {
    public var loadDrawing: ((String) async -> EditorDrawingState)?
    public var loadAttachment: ((String) async -> MobileEditorAttachmentState)?
    public var onDependenciesChanged: ((Set<String>, Set<String>) -> Void)?
    public var onOpenDrawing: ((String) -> Void)?
    public var drawingController: ((String) -> MobileDrawingController?)?
    public var onOpenAttachment: ((MobileEditorAttachment) -> Void)?
    /// Upload returns the vault-relative target only after the host acknowledges persistence.
    public var importAttachment: ((Data, String, String) async throws -> String)?
    public var onOpenLink: ((EditorLinkPreview.Target) -> Void)?
    public init() {}
  }
#endif
