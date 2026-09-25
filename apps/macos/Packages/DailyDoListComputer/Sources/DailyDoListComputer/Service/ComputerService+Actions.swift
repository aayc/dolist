import Foundation

extension ComputerService {
  static let maxTextLength = 10_000
  static let maxCoordinate = 1_000_000.0

  /// `press` `{pid, snapshotId, elementId, action? = "press"}` → `{"ok": true, "stale": bool}`:
  /// performs the element's accessibility action in the background (no activation).
  func press(_ params: Params) async throws -> JSONValue {
    let pid = try params.pid()
    let (snapshotId, elementId) = try requiredElementReference(params)
    let action =
      try params.choice("action", from: ElementAction.allCases.map(\.rawValue))
      .flatMap(ElementAction.init(rawValue:)) ?? .press
    let app = try await targetApp(pid)
    try requireAccessibility()
    let entry = try snapshots.entry(pid: pid, snapshotId: snapshotId, elementId: elementId)
    try await refuseIfShowingDailyDoList(app)
    try verifyUnchanged(entry, id: elementId, app: app)
    do {
      try system.accessibility.performAction(action.accessibilityName, on: entry.element)
    } catch {
      throw failure(error, doing: action.rawValue, on: elementId, in: app)
    }
    return ["ok": true, "stale": .bool(snapshots.invalidate(pid: pid))]
  }

  /// `setValue` `{pid, snapshotId, elementId, value}` → `{"ok": true, "value": <read back>,
  /// "stale": bool}`. A secure text field's value is never read back (`null`).
  func setValue(_ params: Params) async throws -> JSONValue {
    let pid = try params.pid()
    let (snapshotId, elementId) = try requiredElementReference(params)
    let requested = try newValue(params)
    let app = try await targetApp(pid)
    try requireAccessibility()
    let entry = try snapshots.entry(pid: pid, snapshotId: snapshotId, elementId: elementId)
    try await refuseIfShowingDailyDoList(app)
    try verifyUnchanged(entry, id: elementId, app: app)
    let api = system.accessibility
    do {
      guard try api.isSettable(AX.value, of: entry.element) else {
        throw ComputerError.unsupported(
          "\(elementId) (\(entry.info.role)) has no value that can be set.")
      }
      var value = requested
      if case .string(let text) = requested, !entry.info.isSecure,
        case .number = try? api.attributes([AX.value], of: entry.element)[AX.value],
        let number = Double(text.trimmingCharacters(in: .whitespaces))
      {
        value = .number(number)
      }
      try api.setAttribute(AX.value, to: value, on: entry.element)
    } catch let error as AccessibilityError {
      throw failure(error, doing: "set its value", on: elementId, in: app)
    }
    var readBack: JSONValue = .null
    if !entry.info.isSecure {
      switch try? api.attributes([AX.value], of: entry.element)[AX.value] {
      case .string(let text):
        readBack = .string(ElementReader.truncate(text, to: Self.maxTextLength))
      case .number(let number): readBack = .number(number)
      case .bool(let bool): readBack = .bool(bool)
      case .url(let url): readBack = .string(url.absoluteString)
      default: break
      }
    }
    return ["ok": true, "value": readBack, "stale": .bool(snapshots.invalidate(pid: pid))]
  }

  /// `typeText` `{pid, text, snapshotId?, elementId?}` → `{"ok": true, "stale": bool}`: focuses
  /// the element when given, then posts the text to the app as key events.
  func typeText(_ params: Params) async throws -> JSONValue {
    let pid = try params.pid()
    let text = try params.requiredString("text", maxLength: Self.maxTextLength)
    if text.unicodeScalars.contains(where: Self.isDisallowedControl) {
      throw ComputerError.invalid(
        "typeText: \"text\" contains control characters; use key for special keys.")
    }
    let reference = try elementReference(params, required: false)
    let app = try await targetApp(pid)
    try requireAccessibility()
    let entry = try reference.map {
      try snapshots.entry(pid: pid, snapshotId: $0.snapshotId, elementId: $0.elementId)
    }
    try await refuseIfShowingDailyDoList(app)
    if let entry, let elementId = reference?.elementId {
      try verifyUnchanged(entry, id: elementId, app: app)
      do {
        try system.accessibility.setAttribute(AX.focused, to: .bool(true), on: entry.element)
      } catch {
        throw failure(error, doing: "take focus", on: elementId, in: app)
      }
      try await pause(configuration.focusSettle)
    }
    for step in TypingPlan.steps(for: text) {
      switch step {
      case .text(let chunk):
        try post(.text(chunk, down: true), to: pid)
        try post(.text(chunk, down: false), to: pid)
      case .key(let code):
        try post(.key(code: code, down: true, flags: 0), to: pid)
        try post(.key(code: code, down: false, flags: 0), to: pid)
      }
      try await pause(configuration.keyInterval)
    }
    return ["ok": true, "stale": .bool(snapshots.invalidate(pid: pid))]
  }

  /// `key` `{pid, combo}` → `{"ok": true, "stale": bool}`, e.g. `return`, `cmd+k`, `shift+tab`.
  func key(_ params: Params) async throws -> JSONValue {
    let pid = try params.pid()
    let text = try params.requiredString("combo", maxLength: 64)
    let combo: KeyCombo
    do {
      combo = try KeyCombo.parse(text)
    } catch {
      throw ComputerError.invalid(error.message)
    }
    let app = try await targetApp(pid)
    try requireAccessibility()
    try await refuseIfShowingDailyDoList(app)
    for step in combo.events {
      try post(.key(code: step.code, down: step.down, flags: step.flags), to: pid)
      try await pause(configuration.keyInterval)
    }
    return ["ok": true, "stale": .bool(snapshots.invalidate(pid: pid))]
  }

  /// `click` `{pid, x, y, button? = "left", count? = 1}` → `{"ok": true, "stale": bool}`: mouse
  /// events posted to the app at a point inside one of its windows, without moving the cursor.
  func click(_ params: Params) async throws -> JSONValue {
    let pid = try params.pid()
    let point = try self.point(params)
    let button =
      try params.choice("button", from: MouseButton.allCases.map(\.rawValue))
      .flatMap(MouseButton.init(rawValue:)) ?? .left
    let count = try params.integer("count", in: 1...3) ?? 1
    let app = try await targetApp(pid)
    try requireAccessibility()
    try await refuseIfShowingDailyDoList(app)
    let window = try window(at: point, of: app)
    for click in 1...count {
      try post(
        .mouse(button: button, down: true, at: point, clickCount: click, windowID: window.id),
        to: pid)
      try post(
        .mouse(button: button, down: false, at: point, clickCount: click, windowID: window.id),
        to: pid)
      if click < count { try await pause(configuration.clickInterval) }
    }
    return ["ok": true, "stale": .bool(snapshots.invalidate(pid: pid))]
  }

  /// `scroll` `{pid, x, y, dx, dy}` (lines; positive `dy` scrolls down) → `{"ok": true}`.
  func scroll(_ params: Params) async throws -> JSONValue {
    let pid = try params.pid()
    let point = try self.point(params)
    let range = -Double(ScrollPlan.maxLines)...Double(ScrollPlan.maxLines)
    let dx = try params.requiredNumber("dx", in: range)
    let dy = try params.requiredNumber("dy", in: range)
    let app = try await targetApp(pid)
    try requireAccessibility()
    try await refuseIfShowingDailyDoList(app)
    let window = try window(at: point, of: app)
    for step in ScrollPlan.steps(dx: Int(dx.rounded()), dy: Int(dy.rounded())) {
      try post(.scroll(dx: step.dx, dy: step.dy, at: point, windowID: window.id), to: pid)
      try await pause(configuration.scrollInterval)
    }
    return ["ok": true]
  }

  // MARK: - Helpers

  /// `snapshotId` and `elementId`, both required.
  private func requiredElementReference(_ params: Params) throws -> (
    snapshotId: String, elementId: String
  ) {
    guard let reference = try elementReference(params, required: true) else {
      throw ComputerError.invalid(
        "\(params.method): \"snapshotId\" and \"elementId\" are required.")
    }
    return reference
  }

  /// `snapshotId` and `elementId`, which come together; nil when both are absent and optional.
  private func elementReference(_ params: Params, required: Bool) throws -> (
    snapshotId: String, elementId: String
  )? {
    let snapshotId = try params.snapshotID()
    let elementId = try params.elementID()
    switch (snapshotId, elementId) {
    case (let snapshotId?, let elementId?): return (snapshotId, elementId)
    case (nil, nil) where !required: return nil
    default:
      throw ComputerError.invalid(
        "\(params.method): \"snapshotId\" and \"elementId\" are "
          + (required ? "required." : "needed together."))
    }
  }

  private func newValue(_ params: Params) throws -> AccessibilityValue {
    switch params.value("value") {
    case .string:
      return .string(
        try params.requiredString("value", maxLength: Self.maxTextLength, allowEmpty: true))
    case .number(let number) where number.isFinite: return .number(number)
    case .bool(let bool): return .bool(bool)
    case nil: throw ComputerError.invalid("setValue: \"value\" is required.")
    default:
      throw ComputerError.invalid("setValue: \"value\" must be a string, a number or a boolean.")
    }
  }

  private func point(_ params: Params) throws -> Point {
    let range = -Self.maxCoordinate...Self.maxCoordinate
    return Point(
      x: try params.requiredNumber("x", in: range), y: try params.requiredNumber("y", in: range))
  }

  /// The app's frontmost window under `point`; `invalid` when the point is outside its windows.
  private func window(at point: Point, of app: RunningApp) throws -> WindowInfo {
    guard
      let window = system.windows.onScreenWindows().first(where: {
        $0.pid == app.pid && $0.alpha > 0 && $0.frame.contains(point)
      })
    else {
      throw ComputerError.invalid(
        "(\(JSONValue.format(point.x)), \(JSONValue.format(point.y))) isn't inside any window of "
          + "\(app.name).")
    }
    return window
  }

  /// Re-reads the element and refuses (`stale`) if it's gone or has become another control since
  /// the snapshot, so an action always hits the element whose label the caller saw.
  private func verifyUnchanged(_ entry: SnapshotEntry, id: String, app: RunningApp) throws {
    let current: ElementInfo
    do {
      current = try ElementReader.read(entry.element, using: system.accessibility)
    } catch {
      if error == .invalidElement {
        snapshots.invalidate(pid: app.pid)
        throw ComputerError.stale("\(id) is gone: read the app again.")
      }
      throw error.asAppError(appName: app.name)
    }
    guard current.isSameControl(as: entry.info) else {
      snapshots.invalidate(pid: app.pid)
      throw ComputerError.stale("\(id) has changed since the snapshot: read the app again.")
    }
  }

  private func failure(
    _ error: AccessibilityError, doing action: String, on id: String, in app: RunningApp
  ) -> ComputerError {
    switch error {
    case .invalidElement:
      snapshots.invalidate(pid: app.pid)
      return .stale("\(id) is gone: read the app again.")
    case .actionUnsupported, .attributeUnsupported, .illegalArgument, .notImplemented, .noValue:
      return .unsupported("\(id) can't \(action).")
    case .apiDisabled:
      return .accessibilityMissing
    case .cannotComplete:
      snapshots.invalidate(pid: app.pid)
      return .failed(
        "\(app.name) didn't confirm in time (it may have opened a dialog); read it again to see "
          + "what happened.")
    case .failure(let code):
      return .failed("\(app.name) couldn't \(action) \(id) (error \(code)).")
    }
  }

  /// Control characters other than tab and line breaks (which become key presses).
  private static func isDisallowedControl(_ scalar: Unicode.Scalar) -> Bool {
    switch scalar.value {
    case 0x09, 0x0A, 0x0D: false
    case 0x00...0x1F, 0x7F: true
    default: false
    }
  }
}
