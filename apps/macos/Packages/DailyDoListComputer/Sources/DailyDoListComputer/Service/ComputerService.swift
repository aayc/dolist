import Foundation

/// The helper's methods (see the protocol in `apps/macos/README.md`). One request runs at a time;
/// every method that reads another app's UI or acts on it checks, in order: its params
/// (`invalid`), that the app runs (`not_found`), the protected targets (`protected`), the
/// permission it needs (`permission`), the snapshot and element (`stale`, `not_found`), and the
/// windows the input may reach (`protected`).
public actor ComputerService {
  public static let protocolVersion = 1

  public enum Method: String, CaseIterable, Sendable {
    case hello, permissions, apps, installedApps, resolveApp, activate, snapshot, screenshot
    case press, setValue, typeText, key, click, scroll

    /// The params each method accepts; anything else is `invalid`.
    var parameters: Set<String> {
      switch self {
      case .hello, .permissions, .apps, .installedApps: []
      case .resolveApp: ["name", "bundleId", "pid"]
      case .activate: ["pid"]
      case .snapshot: ["pid", "elementId", "snapshotId", "maxNodes", "maxDepth"]
      case .screenshot: ["pid", "maxWidth"]
      case .press: ["pid", "snapshotId", "elementId", "action"]
      case .setValue: ["pid", "snapshotId", "elementId", "value"]
      case .typeText: ["pid", "text", "snapshotId", "elementId"]
      case .key: ["pid", "combo"]
      case .click: ["pid", "x", "y", "button", "count"]
      case .scroll: ["pid", "x", "y", "dx", "dy"]
      }
    }
  }

  let system: ComputerSystem
  let configuration: ComputerConfiguration
  var snapshots = SnapshotStore()
  /// Apps whose Electron accessibility switch was already tried.
  var probedForElectron: Set<Int32> = []
  private var hostGuard: TargetGuard?

  public init(
    system: ComputerSystem, configuration: ComputerConfiguration = ComputerConfiguration()
  ) {
    self.system = system
    self.configuration = configuration
  }

  public func call(method name: String, params: JSONObject) async -> Result<
    JSONValue, ComputerError
  > {
    guard let method = Method(rawValue: name) else {
      return .failure(.invalid("Unknown method \"\(name.prefix(64))\"."))
    }
    do {
      let params = try Params(method: name, object: params, allowed: method.parameters)
      return .success(try await perform(method, params))
    } catch let error as ComputerError {
      return .failure(error)
    } catch {
      return .failure(.failed("\(name) failed: \(error.localizedDescription)"))
    }
  }

  private func perform(_ method: Method, _ params: Params) async throws -> JSONValue {
    switch method {
    case .hello: hello()
    case .permissions: permissions()
    case .apps: await apps()
    case .installedApps: await installedApps()
    case .resolveApp: try await resolveApp(params)
    case .activate: try await activate(params)
    case .snapshot: try await snapshot(params)
    case .screenshot: try await screenshot(params)
    case .press: try await press(params)
    case .setValue: try await setValue(params)
    case .typeText: try await typeText(params)
    case .key: try await key(params)
    case .click: try await click(params)
    case .scroll: try await scroll(params)
    }
  }

  // MARK: - Shared checks

  /// The running app `pid`, unless it's protected.
  func targetApp(_ pid: Int32) async throws -> RunningApp {
    guard let app = await system.workspace.runningApplication(pid: pid) else {
      throw ComputerError.notFound("No app is running with pid \(pid).")
    }
    try await refuseIfProtected(app.identity)
    return app
  }

  /// Throws `protected` for a protected app: its bundle id and names, whether it hosts the
  /// helper, and where it came from (its parent processes).
  func refuseIfProtected(_ target: ProcessIdentity) async throws {
    let hosts = await hostGuardian()
    var ancestors: [ProcessIdentity] = []
    if let pid = target.pid {
      for ancestor in system.processes.ancestors(of: pid) {
        ancestors.append(await identity(of: ancestor))
      }
    }
    if let refusal = hosts.refusal(for: target, ancestors: ancestors) { throw refusal }
  }

  private func hostGuardian() async -> TargetGuard {
    if let hostGuard { return hostGuard }
    let helper = system.processes.currentPID
    var hosts: [ProcessIdentity] = []
    for pid in system.processes.ancestors(of: helper) {
      hosts.append(await identity(of: pid))
    }
    let made = TargetGuard(targets: configuration.protectedTargets, helper: helper, hosts: hosts)
    hostGuard = made
    return made
  }

  private func identity(of pid: Int32) async -> ProcessIdentity {
    await system.workspace.runningApplication(pid: pid)?.identity
      ?? ProcessIdentity(pid: pid, bundleId: nil, names: [])
  }

  func requireAccessibility() throws {
    guard system.permissions.accessibility() else { throw ComputerError.accessibilityMissing }
  }

  func requireScreenRecording() throws {
    guard system.permissions.screenRecording() else { throw ComputerError.screenRecordingMissing }
  }

  var webGuard: WebUIGuard {
    WebUIGuard(
      targets: configuration.protectedTargets, api: system.accessibility, clock: system.clock)
  }

  /// Refuses input to an app while any of its windows shows Daily Do List (keys and clicks may
  /// land in any of them).
  func refuseIfShowingDailyDoList(_ app: RunningApp) async throws {
    await enableElectronAccessibility(app)
    try webGuard.check(
      app: system.accessibility.applicationElement(pid: app.pid), appName: app.name)
  }

  /// Refuses to read a window that shows Daily Do List.
  func refuseIfShowingDailyDoList(window: AccessibilityElement, of app: RunningApp) throws {
    do {
      try webGuard.check(window: window, appName: app.name)
    } catch let error as AccessibilityError {
      throw error.asAppError(appName: app.name)
    }
  }

  /// Electron apps (and Chromium) only expose their web content to accessibility clients that
  /// set `AXManualAccessibility`, the switch assistive apps use. Other apps reject it.
  func enableElectronAccessibility(_ app: RunningApp) async {
    guard probedForElectron.insert(app.pid).inserted else { return }
    let element = system.accessibility.applicationElement(pid: app.pid)
    do {
      try system.accessibility.setAttribute(AX.manualAccessibility, to: .bool(true), on: element)
      try? await system.clock.sleep(for: configuration.electronWarmUp)
    } catch {
      // Not an Electron app.
    }
  }

  /// The window a snapshot or screenshot reads: the focused window, else the main window, else
  /// the first; nil when the app has none.
  func scopeWindow(of app: RunningApp) throws -> AccessibilityElement? {
    let element = system.accessibility.applicationElement(pid: app.pid)
    let attributes: [String: AccessibilityValue]
    do {
      attributes = try system.accessibility.attributes(
        [AX.focusedWindow, AX.mainWindow, AX.windows], of: element)
    } catch {
      if error == .invalidElement { throw ComputerError.notFound("\(app.name) quit.") }
      throw error.asAppError(appName: app.name)
    }
    if let window = attributes[AX.focusedWindow]?.elementValue { return window }
    if let window = attributes[AX.mainWindow]?.elementValue { return window }
    if case .elements(let windows) = attributes[AX.windows] { return windows.first }
    return nil
  }

  /// Pauses between synthesized events; a cancelled request stops early.
  func pause(_ duration: Duration) async throws {
    try await system.clock.sleep(for: duration)
  }

  func post(_ event: InputEvent, to pid: Int32) throws {
    do {
      try system.events.post(event, to: pid)
    } catch let error as ComputerError {
      throw error
    } catch {
      throw ComputerError.failed("Couldn't send input: \(error.localizedDescription)")
    }
  }
}
