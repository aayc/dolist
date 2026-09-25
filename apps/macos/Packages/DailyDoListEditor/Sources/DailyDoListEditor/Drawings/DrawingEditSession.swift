import AppKit
import DailyDoListDrawing

/// A drawing being edited in place: the canvas that replaced the embed's box, its tool bar, and
/// how tall the box has grown while drawing.
@MainActor
final class DrawingEditSession {
  /// The embed's line start (followed through edits).
  var lineStart: Int
  let path: String
  let canvas: DrawingCanvasView
  var toolbar: NSView?
  /// The box's height while editing: at least `EmbedGeometry.minEditingHeight`, growing with the
  /// drawing.
  var height: CGFloat
  /// Identifies the last scene reported to the host (a new scene from the host that differs came
  /// from somewhere else).
  var reportedHash: UInt64
  var responderObservation: NSKeyValueObservation?
  /// Measures the drawing as it grows (its shape cache makes each measure cheap).
  let renderer = SceneRenderer()

  init(lineStart: Int, path: String, canvas: DrawingCanvasView, height: CGFloat, hash: UInt64) {
    self.lineStart = lineStart
    self.path = path
    self.canvas = canvas
    self.height = height
    reportedHash = hash
  }

  /// Whether a view is the canvas or inside it (its inline text editor).
  func contains(_ responder: NSResponder?) -> Bool {
    guard let view = responder as? NSView else { return false }
    return view === canvas || view.isDescendant(of: canvas)
      || (toolbar.map { view.isDescendant(of: $0) } ?? false)
  }
}
