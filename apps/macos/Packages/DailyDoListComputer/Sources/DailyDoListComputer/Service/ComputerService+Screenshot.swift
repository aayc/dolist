import Foundation

extension ComputerService {
  static let defaultScreenshotWidth = 1_280

  /// `screenshot` `{pid?, maxWidth? = 1280}` → `{"image", "mimeType", "width", "height", "scale",
  /// "origin", "app"?, "window"?}`: with a pid, that app's window by itself (even when covered),
  /// else the main display. The longer side is at most `maxWidth` pixels; `scale` is image pixels
  /// per screen point and `origin` the screen point of the image's top-left corner.
  func screenshot(_ params: Params) async throws -> JSONValue {
    let pid = try params.optionalPID()
    let maxWidth = try params.integer("maxWidth", in: 64...4_096) ?? Self.defaultScreenshotWidth
    try requireScreenRecording()
    guard let pid else {
      let (captured, bounds) = try await capture("the screen") {
        try await self.system.capture.captureMainDisplay()
      }
      let image = try ImageEncoder.jpeg(captured.image, maxSide: maxWidth)
      return .object(response(image, frame: bounds))
    }

    let app = try await targetApp(pid)
    try requireAccessibility()
    await enableElectronAccessibility(app)
    guard let window = try scopeWindow(of: app) else {
      throw ComputerError.notFound("\(app.name) has no open window to capture.")
    }
    try refuseIfShowingDailyDoList(window: window, of: app)
    let attributes: [String: AccessibilityValue]
    do {
      attributes = try system.accessibility.attributes(
        [AX.title, AX.position, AX.size], of: window)
    } catch {
      throw error.asAppError(appName: app.name)
    }
    guard case .point(let origin) = attributes[AX.position],
      case .size(let size) = attributes[AX.size], size.width > 0, size.height > 0
    else { throw ComputerError.notFound("\(app.name)'s window has no frame to capture.") }
    let frame = Rect(x: origin.x, y: origin.y, width: size.width, height: size.height)
    let title = attributes[AX.title]?.displayString ?? ""
    let captured = try await capture(app.name) {
      try await self.system.capture.captureWindow(pid: pid, frame: frame, title: title)
    }
    var result = response(try ImageEncoder.jpeg(captured.image, maxSide: maxWidth), frame: frame)
    result["app"] = app.summary.json
    result["window"] = WindowSummary(title: title, frame: frame).json
    return .object(result)
  }

  private func capture<Result: Sendable>(
    _ subject: String, _ work: @Sendable () async throws -> Result
  ) async throws -> Result {
    do {
      return try await work()
    } catch let error as ComputerError {
      throw error
    } catch {
      throw ComputerError.failed("Couldn't capture \(subject): \(error.localizedDescription)")
    }
  }

  private func response(_ image: EncodedImage, frame: Rect) -> JSONObject {
    [
      "image": .string(image.data.base64EncodedString()),
      "mimeType": "image/jpeg",
      "width": .number(Double(image.width)),
      "height": .number(Double(image.height)),
      "scale": .number((Double(image.width) / frame.width * 10_000).rounded() / 10_000),
      "origin": ["x": .number(Rect.round(frame.x)), "y": .number(Rect.round(frame.y))],
    ]
  }
}
