import AppKit
import DailyDoListAgent
import DailyDoListClient
import DailyDoListDaemon
import DailyDoListDomain
import DailyDoListEditor
import DailyDoListModels
import DailyDoListVim
import Foundation
import Testing

@testable import DailyDoListApp

struct TimeoutError: Error, CustomStringConvertible {
  let description: String
}

/// `DDL_TEST_THOROUGH=1` (`test.sh --thorough`) runs model-based and fuzz tests with every seed;
/// by default they run the first few.
let thoroughTests = ProcessInfo.processInfo.environment["DDL_TEST_THOROUGH"] == "1"

/// Polls `condition` (yielding to let async work progress) until it holds or `timeout` passes.
@MainActor
func eventually(
  _ what: String = "condition", timeout: TimeInterval = 3, _ condition: @MainActor () -> Bool
) async throws {
  let deadline = Date().addingTimeInterval(timeout)
  while !condition() {
    if Date() > deadline { throw TimeoutError(description: "timed out waiting for \(what)") }
    await Task.yield()
    try await Task.sleep(for: .milliseconds(2))
  }
}

/// Lets queued main-actor work run (tasks spawned by the code under test).
@MainActor
func settle(_ rounds: Int = 20) async {
  for _ in 0..<rounds {
    await Task.yield()
    try? await Task.sleep(for: .milliseconds(1))
  }
}

/// 2026-09-23 12:00 local time (a Wednesday).
let referenceNow: Date = LocalDate(year: 2026, month: 9, day: 23).date()

/// Isolated UserDefaults for one test.
func testDefaults(_ name: String = UUID().uuidString) -> UserDefaults {
  let suite = "ddl.tests.\(name)"
  let defaults = UserDefaults(suiteName: suite) ?? .standard
  defaults.removePersistentDomain(forName: suite)
  return defaults
}

/// A supervisor that answers `start()` with a canned result.
@MainActor
final class FakeSupervisor: DaemonSupervising {
  var state: DaemonSupervisorState = .idle {
    didSet { for observer in observers.values { observer.yield(state) } }
  }
  private var observers: [UUID: AsyncStream<DaemonSupervisorState>.Continuation] = [:]
  var observerCount: Int { observers.count }
  var logLines: [String] = []
  var lastError: DaemonSupervisorError?
  var configuration = DaemonLaunchConfiguration()
  var startResult: DaemonConnectionInfo?
  var failure: DaemonSupervisorError?
  private(set) var startCount = 0
  private(set) var stopCount = 0

  init(
    connection: DaemonConnectionInfo? = DaemonConnectionInfo(
      baseURL: URL(string: "http://127.0.0.1:7331")!, token: "test-token")
  ) {
    startResult = connection
  }

  func start() async -> DaemonConnectionInfo? {
    startCount += 1
    if let failure {
      lastError = failure
      state = .failed(reason: failure.message)
      return nil
    }
    if let startResult { state = .attached(connection: startResult) }
    return startResult
  }

  func stop() async {
    stopCount += 1
    state = .stopped
  }

  func restart() async -> DaemonConnectionInfo? {
    await stop()
    return await start()
  }

  func stateUpdates() -> AsyncStream<DaemonSupervisorState> {
    let (stream, continuation) = AsyncStream.makeStream(of: DaemonSupervisorState.self)
    let id = UUID()
    observers[id] = continuation
    continuation.onTermination = { [weak self] _ in Task { @MainActor in self?.observers[id] = nil }
    }
    continuation.yield(state)
    return stream
  }

  func terminateForAppExit() { state = .stopped }
  func clearLogs() { logLines = [] }
}

/// Test wiring for an `AppModel`: fake client/supervisor, manual time, isolated defaults, no OS
/// side effects.
@MainActor
func makeEnvironment(
  client: DaemonClient,
  supervisor: FakeSupervisor = FakeSupervisor(),
  mode: DaemonMode = .external,
  demo: Bool = false,
  demoClient: (@MainActor () -> DaemonClient)? = nil,
  scheduler: AppScheduler = ManualScheduler(),
  defaults: UserDefaults = testDefaults(),
  discover: (@MainActor (URL, Int?) throws -> DaemonEndpoint)? = nil,
  computerAccess: ComputerAccessSystem = .inert,
  now: @escaping @Sendable () -> Date = { referenceNow }
) -> AppEnvironment {
  let preferences = AppPreferences(defaults: defaults, environment: [:])
  preferences.daemonMode = mode
  return AppEnvironment(
    preferences: preferences,
    launchOptions: LaunchOptions(demo: demo),
    scheduler: scheduler,
    supervisor: supervisor,
    makeClient: { _ in client },
    makeDemoClient: demoClient,
    discoverEndpoint: discover ?? { _, _ in
      DaemonEndpoint(baseURL: URL(string: "http://127.0.0.1:7331")!, token: "test-token")
    },
    systemIntegration: UnavailableSystemIntegration(),
    now: now,
    enablesSystemServices: false,
    vimPasteboard: { SystemVimPasteboard(privatePasteboard()) },
    computerAccess: computerAccess)
}

/// A pasteboard of its own for one test (vim's clipboard registers never touch the user's).
@MainActor
func privatePasteboard() -> NSPasteboard {
  NSPasteboard(name: NSPasteboard.Name("ddl.tests.\(UUID().uuidString)"))
}

/// A workspace wired to `client` with manual time (no AppModel).
@MainActor
func makeWorkspace(
  client: DaemonClient, scheduler: ManualScheduler = ManualScheduler(),
  settings: AppSettings = .defaults, agent: AgentStore? = nil, vim: Vim? = nil
) -> Workspace {
  let settingsStore = SettingsStore()
  settingsStore.apply(settings)
  let preferences = AppPreferences(defaults: testDefaults(), environment: [:])
  let workspace = Workspace(
    client: client, settings: settingsStore, ui: UIState(preferences: preferences),
    toasts: ToastStore(scheduler: scheduler), scheduler: scheduler, vim: vim, now: { referenceNow })
  workspace.agent = agent
  return workspace
}

/// Simulates the user typing: replaces the editor text and reports the change like a keystroke.
@MainActor
func type(_ text: String, in workspace: Workspace) {
  let controller = workspace.editor.controller
  controller.setText(text)
  workspace.editor.editorTextDidChange(controller, text: text)
}

extension TaskAgentRecord {
  static func sample(
    _ taskId: String, note: String, text: String, line: Int, status: TaskAgentStatus,
    summary: String? = nil, threadId: String? = nil
  ) -> TaskAgentRecord {
    TaskAgentRecord(
      taskId: taskId, notePath: note, date: nil, text: text, line: line, status: status,
      summary: summary, threadId: threadId, updatedAt: 1_000, unread: 0)
  }
}
