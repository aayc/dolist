import Foundation
import Testing

@testable import DailyDoListComputer

/// A `ComputerService` over fakes, with helpers to call methods the way the daemon does.
struct Harness {
  let accessibility = FakeAccessibility()
  let workspace = FakeWorkspace()
  let windows = FakeWindows()
  let events = FakeEvents()
  let capture = FakeCapture()
  let clock = FakeClock()
  var permissions = FakePermissions()
  var processes = FakeProcessTree()
  var targets = ProtectedTargets.standard()

  var system: ComputerSystem {
    ComputerSystem(
      accessibility: accessibility, workspace: workspace, windows: windows, events: events,
      capture: capture, permissions: permissions, processes: processes, clock: clock)
  }

  func makeService() -> ComputerService {
    ComputerService(system: system, configuration: ComputerConfiguration(protectedTargets: targets))
  }

  /// A running Dock app.
  @discardableResult
  func run(
    pid: Int32, name: String, bundleId: String?, active: Bool = false, hidden: Bool = false,
    kind: RunningApp.Kind = .regular
  ) -> RunningApp {
    let app = RunningApp(
      pid: pid, localizedName: name, bundleId: bundleId,
      bundleURL: URL(fileURLWithPath: "/Applications/\(name).app"), kind: kind, isActive: active,
      isHidden: hidden)
    workspace.addRunning(app)
    return app
  }

  func install(name: String, bundleId: String, folder: String = "/Applications") {
    workspace.addInstalled(
      InstalledApp(
        name: name, bundleId: bundleId, url: URL(fileURLWithPath: "\(folder)/\(name).app")))
  }
}

extension ComputerService {
  /// The method's result, failing the test on an error.
  func result(
    _ method: String, _ params: JSONObject = [:], sourceLocation: SourceLocation = #_sourceLocation
  ) async throws -> JSONObject {
    switch await call(method: method, params: params) {
    case .success(let value):
      return try #require(value.objectValue, sourceLocation: sourceLocation)
    case .failure(let error):
      Issue.record("\(method) failed: \(error)", sourceLocation: sourceLocation)
      throw error
    }
  }

  /// The method's error, failing the test when it succeeds.
  func failure(
    _ method: String, _ params: JSONObject = [:], sourceLocation: SourceLocation = #_sourceLocation
  ) async -> ComputerError? {
    switch await call(method: method, params: params) {
    case .success(let value):
      Issue.record("\(method) succeeded: \(value.serialized)", sourceLocation: sourceLocation)
      return nil
    case .failure(let error):
      return error
    }
  }
}

extension JSONObject {
  func string(_ key: String) -> String? {
    if case .string(let value) = self[key] { return value }
    return nil
  }

  func number(_ key: String) -> Double? {
    if case .number(let value) = self[key] { return value }
    return nil
  }

  func bool(_ key: String) -> Bool? {
    if case .bool(let value) = self[key] { return value }
    return nil
  }

  func objects(_ key: String) -> [JSONObject] {
    guard case .array(let values) = self[key] else { return [] }
    return values.compactMap(\.objectValue)
  }

  func object(_ key: String) -> JSONObject? { self[key]?.objectValue }
}
