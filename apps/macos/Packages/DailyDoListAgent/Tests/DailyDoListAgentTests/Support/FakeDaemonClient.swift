import DailyDoListClient
import DailyDoListModels
import Foundation

/// A value behind a lock (test doubles are called from arbitrary tasks).
final class Locked<Value>: @unchecked Sendable {
  private let lock = NSLock()
  private var value: Value

  init(_ value: Value) { self.value = value }

  var current: Value { lock.withLock { value } }

  func mutate<T>(_ body: (inout Value) -> T) -> T { lock.withLock { body(&value) } }
}

struct UnscriptedCall: Error, Equatable {
  let name: String
}

/// Scriptable `DaemonClient` for store tests: canned answers per call, a log of calls and of the
/// client signals sent.
final class FakeDaemonClient: DaemonClient, @unchecked Sendable {
  struct Script: Sendable {
    var agentStatus: @Sendable () async throws -> AgentStatusResponse = {
      throw UnscriptedCall(name: "agentStatus")
    }
    var setAgentEnabled: @Sendable (Bool) async throws -> AgentStatusResponse = { _ in
      throw UnscriptedCall(name: "setAgentEnabled")
    }
    var taskRecords: @Sendable (String) async throws -> [TaskAgentRecord] = { _ in [] }
    var threads: @Sendable (String?, String?) async throws -> [ThreadSummary] = { _, _ in [] }
    var thread: @Sendable (String) async throws -> ThreadResponse = { _ in
      throw DaemonClientError.http(
        status: 404, body: ApiErrorBody(error: .notFound, message: "Thread not found"))
    }
    var postMessage: @Sendable (String, String) async throws -> ThreadActionResponse = { _, _ in
      ThreadActionResponse()
    }
    var cancelThread: @Sendable (String) async throws -> ThreadActionResponse = { _ in
      ThreadActionResponse()
    }
    var retryThread: @Sendable (String) async throws -> ThreadActionResponse = { _ in
      ThreadActionResponse()
    }
    var approvals: @Sendable (ApprovalStatus?) async throws -> [ApprovalRequest] = { _ in [] }
    var decideApproval:
      @Sendable (String, ApprovalDecisionRequest) async throws -> ApprovalRequest = { _, _ in
        throw UnscriptedCall(name: "decideApproval")
      }
    var artifact: @Sendable (String, String) async throws -> ArtifactPayload = { _, _ in
      throw UnscriptedCall(name: "artifact")
    }
    var routines: @Sendable () async throws -> RoutineListResponse = {
      RoutineListResponse(routines: [], templates: [])
    }
    var createRoutine: @Sendable (CreateRoutineRequest) async throws -> Routine = { _ in
      throw UnscriptedCall(name: "createRoutine")
    }
    var runRoutine: @Sendable (String) async throws -> RoutineRunResponse = { _ in
      throw UnscriptedCall(name: "runRoutine")
    }
    var pauseRoutine: @Sendable (String, Bool) async throws -> Routine = { _, _ in
      throw UnscriptedCall(name: "pauseRoutine")
    }
    var routineRuns: @Sendable (String) async throws -> [ThreadSummary] = { _ in [] }
  }

  let clientId = "test-client"
  let script = Locked(Script())
  let calls = Locked<[String]>([])
  let sentEvents = Locked<[ClientEvent]>([])

  func script(_ edit: (inout Script) -> Void) { script.mutate(edit) }
  var sent: [ClientEvent] { sentEvents.current }
  var callLog: [String] { calls.current }
  func count(_ prefix: String) -> Int { callLog.filter { $0.hasPrefix(prefix) }.count }

  private func log(_ call: String) { calls.mutate { $0.append(call) } }
  private var current: Script { script.current }
  private static let noVault = DaemonClientError.unreachable("not in tests")

  // Vault
  func health() async throws -> HealthResponse { throw Self.noVault }
  func tree() async throws -> VaultTreeResponse { throw Self.noVault }
  func readNote(_ path: String) async throws -> NoteResponse { throw Self.noVault }
  func writeNote(_ path: String, content: String, baseVersion: BaseVersion) async throws
    -> WriteNoteResponse
  { throw Self.noVault }
  func deleteNote(_ path: String) async throws -> TrashResponse { throw Self.noVault }
  func rename(from: String, to: String) async throws -> RenameResponse { throw Self.noVault }
  func createFolder(_ path: String) async throws -> CreateFolderResponse { throw Self.noVault }
  func deleteFolder(_ path: String) async throws -> TrashResponse { throw Self.noVault }
  func dailyNote(_ date: String, create: Bool) async throws -> DailyNoteResponse {
    throw Self.noVault
  }
  func search(_ query: String, limit: Int?) async throws -> SearchResponse { throw Self.noVault }
  func settings() async throws -> AppSettings { .defaults }
  func updateSettings(_ patch: SettingsPatch) async throws -> AppSettings {
    AppSettings.defaults.applying(patch)
  }
  func connectors() async throws -> [ConnectorStatus] { [] }

  // Agent
  func agentStatus() async throws -> AgentStatusResponse {
    log("agentStatus")
    return try await current.agentStatus()
  }

  func setAgentEnabled(_ enabled: Bool) async throws -> AgentStatusResponse {
    log("setAgentEnabled:\(enabled)")
    return try await current.setAgentEnabled(enabled)
  }

  func taskRecords(notePath: String) async throws -> [TaskAgentRecord] {
    log("taskRecords:\(notePath)")
    return try await current.taskRecords(notePath)
  }

  func threads(notePath: String?, taskId: String?) async throws -> [ThreadSummary] {
    log("threads:\(notePath ?? "*")")
    return try await current.threads(notePath, taskId)
  }

  func thread(_ id: String) async throws -> ThreadResponse {
    log("thread:\(id)")
    return try await current.thread(id)
  }

  func postMessage(threadId: String, text: String) async throws -> ThreadActionResponse {
    log("postMessage:\(threadId)")
    return try await current.postMessage(threadId, text)
  }

  func cancelThread(_ id: String) async throws -> ThreadActionResponse {
    log("cancelThread:\(id)")
    return try await current.cancelThread(id)
  }

  func retryThread(_ id: String) async throws -> ThreadActionResponse {
    log("retryThread:\(id)")
    return try await current.retryThread(id)
  }

  func approvals(status: ApprovalStatus?) async throws -> [ApprovalRequest] {
    log("approvals:\(status?.rawValue ?? "*")")
    return try await current.approvals(status)
  }

  func decideApproval(_ id: String, _ decision: ApprovalDecisionRequest) async throws
    -> ApprovalRequest
  {
    log("decideApproval:\(id):\(decision.decision.rawValue):\(decision.scope?.rawValue ?? "-")")
    return try await current.decideApproval(id, decision)
  }

  func artifact(threadId: String, artifactId: String) async throws -> ArtifactPayload {
    log("artifact:\(threadId)/\(artifactId)")
    return try await current.artifact(threadId, artifactId)
  }

  // Routines
  func routines() async throws -> RoutineListResponse {
    log("routines")
    return try await current.routines()
  }

  func routine(_ id: String) async throws -> Routine {
    log("routine:\(id)")
    guard let routine = try await current.routines().routines.first(where: { $0.id == id }) else {
      throw DaemonClientError.http(
        status: 404, body: ApiErrorBody(error: .notFound, message: "Routine not found"))
    }
    return routine
  }

  func createRoutine(_ request: CreateRoutineRequest) async throws -> Routine {
    log("createRoutine:\(request.name)")
    return try await current.createRoutine(request)
  }

  func runRoutine(_ id: String) async throws -> RoutineRunResponse {
    log("runRoutine:\(id)")
    return try await current.runRoutine(id)
  }

  func pauseRoutine(_ id: String) async throws -> Routine {
    log("pauseRoutine:\(id)")
    return try await current.pauseRoutine(id, true)
  }

  func resumeRoutine(_ id: String) async throws -> Routine {
    log("resumeRoutine:\(id)")
    return try await current.pauseRoutine(id, false)
  }

  func threads(routineId: String) async throws -> [ThreadSummary] {
    log("threads:routine:\(routineId)")
    return try await current.routineRuns(routineId)
  }

  // Events
  func connect() async {}
  func disconnect() async {}
  func events() -> AsyncStream<DaemonStreamItem> { AsyncStream { _ in } }
  func send(_ event: ClientEvent) async { sentEvents.mutate { $0.append(event) } }
}

/// Holds async work until opened (to observe optimistic state mid-request).
actor Gate {
  private var isOpen = false
  private var waiters: [CheckedContinuation<Void, Never>] = []
  private(set) var arrivals = 0

  func wait() async {
    arrivals += 1
    if isOpen { return }
    await withCheckedContinuation { waiters.append($0) }
  }

  func open() {
    isOpen = true
    for waiter in waiters { waiter.resume() }
    waiters.removeAll()
  }
}

/// Polls `condition` on the main actor until it holds or `timeout` passes.
@MainActor
func eventually(timeout: Duration = .seconds(3), _ condition: () -> Bool) async -> Bool {
  let deadline = ContinuousClock.now + timeout
  while ContinuousClock.now < deadline {
    if condition() { return true }
    try? await Task.sleep(for: .milliseconds(5))
  }
  return condition()
}

/// Waits until the gate has at least `count` arrivals.
func waitForArrivals(_ gate: Gate, _ count: Int = 1, timeout: Duration = .seconds(3)) async -> Bool
{
  let deadline = ContinuousClock.now + timeout
  while ContinuousClock.now < deadline {
    if await gate.arrivals >= count { return true }
    try? await Task.sleep(for: .milliseconds(5))
  }
  return await gate.arrivals >= count
}
