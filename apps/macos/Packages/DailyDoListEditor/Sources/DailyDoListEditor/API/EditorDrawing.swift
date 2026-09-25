import DailyDoListDrawing
import Foundation

/// A drawing file an embed names, as the host has it now.
public struct EditorDrawing: Equatable, Sendable {
  /// The file's vault path (`Excalidraw/Plan.excalidraw.md`).
  public var path: String
  public var scene: ExcalidrawScene
  /// Identifies this version of the drawing: previews are cached by it, so it must change
  /// whenever the scene does (`DrawingContentHash.hash(text)` of the file, or of the scene).
  public var contentHash: UInt64

  public init(path: String, scene: ExcalidrawScene, contentHash: UInt64) {
    self.path = path
    self.scene = scene
    self.contentHash = contentHash
  }

  public static func == (lhs: EditorDrawing, rhs: EditorDrawing) -> Bool {
    lhs.path == rhs.path && lhs.contentHash == rhs.contentHash
  }
}

/// What the host knows about the drawing an embed names (`MarkdownEditorDelegate`'s
/// `editor(_:drawingFor:)`).
public enum EditorDrawingState: Equatable, Sendable {
  /// Being read: a placeholder the drawing's size is kept for.
  case loading
  /// No such file in the vault.
  case missing
  /// The file exists but its scene couldn't be read.
  case unreadable
  case ready(EditorDrawing)

  public var drawing: EditorDrawing? {
    if case .ready(let drawing) = self { return drawing }
    return nil
  }
}
