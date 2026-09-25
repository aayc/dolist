import CoreGraphics
import Foundation

/// A captured image. `CGImage` is immutable, so sharing it across tasks is safe.
public struct CapturedImage: @unchecked Sendable {
  public let image: CGImage

  public init(_ image: CGImage) {
    self.image = image
  }
}

/// Window and display capture (ScreenCaptureKit, falling back to `screencapture`). Needs Screen
/// Recording; callers check it first, so a capture never triggers the permission prompt.
public protocol ScreenCapturing: Sendable {
  /// One window of `pid` by itself, even when other windows cover it: the one whose frame
  /// matches `frame` (else the app's frontmost window).
  func captureWindow(pid: Int32, frame: Rect, title: String) async throws -> CapturedImage
  /// The main display, and its bounds in global points.
  func captureMainDisplay() async throws -> (image: CapturedImage, bounds: Rect)
}
