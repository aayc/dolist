import CoreGraphics
import Foundation
import ImageIO
import ScreenCaptureKit

/// ScreenCaptureKit (`SCScreenshotManager`), falling back to `screencapture` when it fails or
/// doesn't answer in time. Callers check Screen Recording first: both would prompt without it.
public struct LiveScreenCapture: ScreenCapturing {
  static let timeout: Duration = .seconds(5)
  private let commands: any CommandRunning
  private let windows: any WindowListing

  public init(
    commands: any CommandRunning = ProcessCommandRunner(),
    windows: any WindowListing = LiveWindowList()
  ) {
    self.commands = commands
    self.windows = windows
  }

  public func captureWindow(pid: Int32, frame: Rect, title: String) async throws -> CapturedImage {
    do {
      return try await withDeadline(Self.timeout) {
        try await Self.captureWindowWithScreenCaptureKit(pid: pid, frame: frame, title: title)
      }
    } catch {
      let candidates = windows.onScreenWindows().filter { $0.pid == pid }
      guard
        let window = candidates.first(where: { $0.frame.matches(frame) })
          ?? candidates.first(where: { $0.layer == 0 })
      else { throw error }
      return try await captureWithScreencapture(["-o", "-l\(window.id)"])
    }
  }

  public func captureMainDisplay() async throws -> (image: CapturedImage, bounds: Rect) {
    let bounds = Rect(CGDisplayBounds(CGMainDisplayID()))
    do {
      let image = try await withDeadline(Self.timeout) {
        try await Self.captureMainDisplayWithScreenCaptureKit()
      }
      return (image, bounds)
    } catch {
      return (try await captureWithScreencapture(["-m"]), bounds)
    }
  }

  private static func captureWindowWithScreenCaptureKit(pid: Int32, frame: Rect, title: String)
    async throws -> CapturedImage
  {
    let content = try await SCShareableContent.excludingDesktopWindows(
      false, onScreenWindowsOnly: false)
    let owned = content.windows.filter { $0.owningApplication?.processID == pid }
    guard
      let window = owned.first(where: { Rect($0.frame).matches(frame) && $0.title == title })
        ?? owned.first(where: { Rect($0.frame).matches(frame) })
        ?? owned.first(where: { $0.isOnScreen && $0.windowLayer == 0 })
    else { throw ComputerError.notFound("The window to capture wasn't found.") }
    let filter = SCContentFilter(desktopIndependentWindow: window)
    let configuration = SCStreamConfiguration()
    let scale = Double(filter.pointPixelScale)
    configuration.width = max(1, Int((Double(window.frame.width) * scale).rounded()))
    configuration.height = max(1, Int((Double(window.frame.height) * scale).rounded()))
    configuration.showsCursor = false
    configuration.ignoreShadowsSingleWindow = true
    let image = try await SCScreenshotManager.captureImage(
      contentFilter: filter, configuration: configuration)
    return CapturedImage(image)
  }

  private static func captureMainDisplayWithScreenCaptureKit() async throws -> CapturedImage {
    let content = try await SCShareableContent.excludingDesktopWindows(
      false, onScreenWindowsOnly: true)
    let mainID = CGMainDisplayID()
    guard let display = content.displays.first(where: { $0.displayID == mainID }) else {
      throw ComputerError.notFound("The main display wasn't found.")
    }
    let filter = SCContentFilter(display: display, excludingWindows: [])
    let configuration = SCStreamConfiguration()
    let scale = Double(filter.pointPixelScale)
    configuration.width = max(1, Int((Double(display.width) * scale).rounded()))
    configuration.height = max(1, Int((Double(display.height) * scale).rounded()))
    configuration.showsCursor = false
    let image = try await SCScreenshotManager.captureImage(
      contentFilter: filter, configuration: configuration)
    return CapturedImage(image)
  }

  /// `screencapture -x <options> -t png <file>` into a private temporary folder.
  private func captureWithScreencapture(_ options: [String]) async throws -> CapturedImage {
    let files = FileManager.default
    let folder = files.temporaryDirectory.appendingPathComponent(
      "ddl-computer-\(UUID().uuidString)", isDirectory: true)
    try files.createDirectory(
      at: folder, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
    defer { try? files.removeItem(at: folder) }
    let file = folder.appendingPathComponent("capture.png")
    let result = await commands.run(
      URL(fileURLWithPath: "/usr/sbin/screencapture"),
      arguments: ["-x"] + options + ["-t", "png", file.path], timeout: .seconds(10))
    guard result.status == 0, let source = CGImageSourceCreateWithURL(file as CFURL, nil),
      let image = CGImageSourceCreateImageAtIndex(source, 0, nil)
    else { throw ComputerError.failed("screencapture didn't produce an image.") }
    return CapturedImage(image)
  }
}
