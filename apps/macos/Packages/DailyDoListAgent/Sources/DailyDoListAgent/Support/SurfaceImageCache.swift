import AppKit
import DailyDoListAgentCore
import DailyDoListModels

/// The view owns its decoded frame, so closing a live view releases its image immediately.
@MainActor
final class SurfaceImageCache {
  private var frame: SurfaceFrame?
  private var decoded: NSImage?

  func image(for frame: SurfaceFrame) -> NSImage? {
    if self.frame == frame { return decoded }
    self.frame = frame
    decoded = frame.imageData.flatMap(NSImage.init(data:))
    return decoded
  }
}
