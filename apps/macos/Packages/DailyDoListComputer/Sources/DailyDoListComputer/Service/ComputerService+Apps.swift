import Foundation

extension ComputerService {
  /// `hello` → `{"version": 1, "pid": <helper pid>}`.
  func hello() -> JSONValue {
    [
      "version": .number(Double(Self.protocolVersion)),
      "pid": .number(Double(system.processes.currentPID)),
    ]
  }

  /// `permissions` → `{"accessibility": bool, "screenRecording": bool}`, without prompting.
  func permissions() -> JSONValue {
    [
      "accessibility": .bool(system.permissions.accessibility()),
      "screenRecording": .bool(system.permissions.screenRecording()),
    ]
  }

  /// `apps`: running Dock apps, the active one first, then by their frontmost window, then the
  /// rest by name. Needs no permission.
  func apps() async -> JSONValue {
    let running = await system.workspace.runningApplications().filter { $0.kind == .regular }
    var windowRank: [Int32: Int] = [:]
    for window in system.windows.onScreenWindows() where window.layer == 0 {
      if windowRank[window.pid] == nil { windowRank[window.pid] = windowRank.count }
    }
    let ordered = running.sorted { lhs, rhs in
      if lhs.isActive != rhs.isActive { return lhs.isActive }
      switch (windowRank[lhs.pid], windowRank[rhs.pid]) {
      case (let left?, let right?): return left < right
      case (.some, nil): return true
      case (nil, .some): return false
      case (nil, nil): return lhs.name.localizedStandardCompare(rhs.name) == .orderedAscending
      }
    }
    return [
      "apps": .array(
        ordered.map { app in
          [
            "name": .string(app.name), "bundleId": .string(app.bundleId),
            "pid": .number(Double(app.pid)), "active": .bool(app.isActive),
            "hidden": .bool(app.isHidden),
          ]
        })
    ]
  }

  /// `installedApps` → `{"apps": [{"name", "bundleId", "path"}]}`.
  func installedApps() async -> JSONValue {
    let apps = await system.workspace.installedApplications()
    return [
      "apps": .array(
        apps.map { app in
          [
            "name": .string(app.name), "bundleId": .string(app.bundleId),
            "path": .string(app.url.path),
          ]
        })
    ]
  }

  /// `resolveApp` `{name | bundleId | pid}` → `{"name", "bundleId", "pid", "launched"}`. An app
  /// that isn't running is launched without being brought to the front.
  func resolveApp(_ params: Params) async throws -> JSONValue {
    let name = try params.string("name", maxLength: 200)
    let bundleId = try params.string("bundleId", maxLength: 255)
    let pid = try params.optionalPID()
    guard [name != nil, bundleId != nil, pid != nil].filter({ $0 }).count == 1 else {
      throw ComputerError.invalid("resolveApp: pass exactly one of name, bundleId or pid.")
    }
    if let pid {
      return resolved(try await targetApp(pid), launched: false)
    }
    if let bundleId {
      guard
        bundleId.allSatisfy({ $0.isASCII && ($0.isLetter || $0.isNumber || "-._".contains($0)) })
      else { throw ComputerError.invalid("resolveApp: \"bundleId\" isn't a bundle id.") }
      // Several instances: the active one, else a Dock one.
      func rank(_ app: RunningApp) -> Int {
        (app.isActive ? 0 : 2) + (app.kind == .regular ? 0 : 1)
      }
      let running = await system.workspace.runningApplications()
        .filter { $0.bundleId?.caseInsensitiveCompare(bundleId) == .orderedSame }
        .sorted { rank($0) < rank($1) }
      if let app = running.first {
        try await refuseIfProtected(app.identity)
        return resolved(app, launched: false)
      }
      guard let url = await system.workspace.applicationURL(bundleIdentifier: bundleId),
        let app = await system.workspace.installedApplication(at: url)
      else { throw ComputerError.notFound("No app with bundle id \(bundleId) is installed.") }
      return try await launch(app)
    }
    let query = name ?? ""
    let candidates = AppResolver.candidates(
      running: await system.workspace.runningApplications(),
      installed: await system.workspace.installedApplications())
    switch AppResolver.resolve(query, among: candidates) {
    case .none:
      throw ComputerError.notFound("No app named \"\(query.prefix(100))\" is running or installed.")
    case .ambiguous(let matches):
      throw ComputerError.invalid(AppResolver.ambiguityMessage(query: query, candidates: matches))
    case .match(let candidate):
      try await refuseIfProtected(candidate.identity)
      if let running = candidate.running { return resolved(running, launched: false) }
      guard let installed = candidate.installed else {
        throw ComputerError.notFound("No app named \"\(query.prefix(100))\" is installed.")
      }
      return try await launch(installed)
    }
  }

  private func launch(_ app: InstalledApp) async throws -> JSONValue {
    try await refuseIfProtected(app.identity)
    let deadline = system.clock.now + configuration.launchTimeout
    let pid: Int32
    do {
      pid = try await system.workspace.openApplication(at: app.url)
    } catch {
      throw ComputerError.failed("Couldn't open \(app.name): \(error.localizedDescription)")
    }
    while true {
      if let running = await system.workspace.runningApplication(pid: pid),
        running.isFinishedLaunching
      {
        try await refuseIfProtected(running.identity)
        return resolved(running, launched: true)
      }
      guard system.clock.now < deadline else {
        throw ComputerError.failed(
          "\(app.name) didn't finish launching within \(configuration.launchTimeout.components.seconds) "
            + "seconds.")
      }
      try await pause(configuration.launchPollInterval)
    }
  }

  private func resolved(_ app: RunningApp, launched: Bool) -> JSONValue {
    [
      "name": .string(app.name), "bundleId": .string(app.bundleId),
      "pid": .number(Double(app.pid)), "launched": .bool(launched),
    ]
  }

  /// `activate` `{pid}` → `{"ok": true}`: brings the app to the front, only when asked to.
  func activate(_ params: Params) async throws -> JSONValue {
    let app = try await targetApp(try params.pid())
    try requireAccessibility()
    try await refuseIfShowingDailyDoList(app)
    guard await system.workspace.activate(pid: app.pid) else {
      throw ComputerError.failed("macOS didn't bring \(app.name) to the front.")
    }
    let deadline = system.clock.now + configuration.activationTimeout
    while await system.workspace.runningApplication(pid: app.pid)?.isActive != true {
      guard system.clock.now < deadline else {
        throw ComputerError.failed("\(app.name) didn't come to the front.")
      }
      try await pause(configuration.launchPollInterval)
    }
    return ["ok": true]
  }

  /// Keys, clicks and scrolls only reach the app in front: macOS routes them to the key window,
  /// and an inactive app has none, so events posted to it vanish without an error.
  func bringToFrontForInput(_ app: RunningApp) async throws {
    if await system.workspace.runningApplication(pid: app.pid)?.isActive == true { return }
    guard await system.workspace.activate(pid: app.pid) else {
      throw ComputerError.failed(
        "macOS didn't bring \(app.name) to the front, so no input was sent.")
    }
    let deadline = system.clock.now + configuration.activationTimeout
    while await system.workspace.runningApplication(pid: app.pid)?.isActive != true {
      guard system.clock.now < deadline else {
        throw ComputerError.failed(
          "\(app.name) didn't come to the front, so no input was sent.")
      }
      try await pause(configuration.launchPollInterval)
    }
    try await pause(configuration.activationSettle)
  }
}
