import DailyDoListClient
import DailyDoListModels
import Foundation

/// A `DaemonClient` serving `SampleData` for previews, demos and screenshots. Agent reads answer
/// from the sample; decisions, replies and pausing work and push the matching events to
/// `events()` subscribers; vault calls fail with `.unreachable`.
public final class SampleDaemonClient: DaemonClient, @unchecked Sendable {
  public let clientId = "sample"
  private let lock = NSLock()
  private var snapshot: SampleData.Snapshot
  private var sentEvents: [ClientEvent] = []
  private var subscribers: [UUID: AsyncStream<DaemonStreamItem>.Continuation] = [:]

  public init(snapshot: SampleData.Snapshot = SampleData.snapshot()) {
    self.snapshot = snapshot
  }

  /// Client signals received so far (surface subscriptions, `thread.read`).
  public var sent: [ClientEvent] { lock.withLock { sentEvents } }

  private func read<T>(_ body: (SampleData.Snapshot) -> T) -> T {
    lock.withLock { body(snapshot) }
  }

  private func broadcast(_ event: ServerEvent) {
    let continuations = lock.withLock { Array(subscribers.values) }
    for continuation in continuations { continuation.yield(.event(event)) }
  }

  private static func notFound(_ what: String) -> DaemonClientError {
    .http(status: 404, body: ApiErrorBody(error: .notFound, message: "\(what) not found"))
  }

  private static let noVault = DaemonClientError.unreachable("the sample has no vault")

  // MARK: Vault (not part of the sample)

  public func health() async throws -> HealthResponse {
    HealthResponse(
      version: "sample", apiVersion: DaemonProtocol.apiVersion, vaultName: "Sample",
      agentMode: .mock)
  }
  public func tree() async throws -> VaultTreeResponse { throw Self.noVault }
  public func readNote(_ path: String) async throws -> NoteResponse { throw Self.noVault }
  public func writeNote(_ path: String, content: String, baseVersion: BaseVersion) async throws
    -> WriteNoteResponse
  {
    throw Self.noVault
  }
  public func deleteNote(_ path: String) async throws -> TrashResponse { throw Self.noVault }
  public func rename(from: String, to: String) async throws -> RenameResponse { throw Self.noVault }
  public func createFolder(_ path: String) async throws -> CreateFolderResponse {
    throw Self.noVault
  }
  public func deleteFolder(_ path: String) async throws -> TrashResponse { throw Self.noVault }
  public func dailyNote(_ date: String, create: Bool) async throws -> DailyNoteResponse {
    throw Self.noVault
  }
  public func search(_ query: String, limit: Int?) async throws -> SearchResponse {
    SearchResponse(hits: [])
  }

  // MARK: Settings & agent

  public func settings() async throws -> AppSettings { .defaults }
  public func updateSettings(_ patch: SettingsPatch) async throws -> AppSettings {
    AppSettings.defaults.applying(patch)
  }
  public func agentStatus() async throws -> AgentStatusResponse { read(\.status) }

  public func setAgentEnabled(_ enabled: Bool) async throws -> AgentStatusResponse {
    let status = lock.withLock {
      snapshot.status.enabled = enabled
      return snapshot.status
    }
    broadcast(.agentStatus(status))
    return status
  }

  public func connectors() async throws -> [ConnectorStatus] { read(\.status.connectors) }

  public func taskRecords(notePath: String) async throws -> [TaskAgentRecord] {
    read { $0.records.filter { $0.notePath == notePath } }
  }

  public func threads(notePath: String?, taskId: String?) async throws -> [ThreadSummary] {
    read { snapshot in
      snapshot.threads.filter {
        (notePath == nil || $0.notePath == notePath) && (taskId == nil || $0.taskId == taskId)
      }
    }
  }

  public func thread(_ id: String) async throws -> ThreadResponse {
    guard let response = read({ $0.threadResponse(id) }) else { throw Self.notFound("Thread") }
    return response
  }

  public func postMessage(threadId: String, text: String) async throws -> ThreadActionResponse {
    let body = text.trimmingCharacters(in: .whitespacesAndNewlines)
    let message = ThreadMessage.text(
      TextMessage(
        id: "msg_\(UUID().uuidString.prefix(8).lowercased())", author: "you",
        createdAt: Date().epochMillis, role: .user, text: body))
    lock.withLock {
      if let index = snapshot.loadedThreads.firstIndex(where: { $0.id == threadId }) {
        snapshot.loadedThreads[index].messages.append(message)
      }
    }
    broadcast(.threadMessage(ThreadMessageEvent(threadId: threadId, message: message)))
    return ThreadActionResponse(ok: true, pending: true)
  }

  public func cancelThread(_ id: String) async throws -> ThreadActionResponse {
    ThreadActionResponse()
  }
  public func retryThread(_ id: String) async throws -> ThreadActionResponse {
    ThreadActionResponse()
  }

  public func approvals(status: ApprovalStatus?) async throws -> [ApprovalRequest] {
    read { $0.approvals.filter { status == nil || $0.status == status } }
  }

  public func decideApproval(_ id: String, _ decision: ApprovalDecisionRequest) async throws
    -> ApprovalRequest
  {
    let result: Result<ApprovalRequest, DaemonClientError> = lock.withLock {
      guard let index = snapshot.approvals.firstIndex(where: { $0.id == id }) else {
        return .failure(Self.notFound("Approval"))
      }
      var approval = snapshot.approvals[index]
      guard approval.isPending else {
        return .failure(.approvalConflict(ApprovalConflictResponse(approval: approval)))
      }
      approval.status = decision.decision == .approve ? .approved : .denied
      approval.scope = decision.decision == .approve ? (decision.scope ?? .once) : nil
      approval.decisionNote = decision.note
      approval.decidedAt = Date().epochMillis
      snapshot.approvals[index] = approval
      return .success(approval)
    }
    let approval = try result.get()
    broadcast(.approvalUpsert(approval))
    return approval
  }

  public func artifact(threadId: String, artifactId: String) async throws -> ArtifactPayload {
    guard let payload = read({ $0.artifacts[artifactId] }) else { throw Self.notFound("Artifact") }
    return payload
  }

  // MARK: Routines

  public func routines() async throws -> RoutineListResponse {
    read { RoutineListResponse(routines: $0.routines, templates: $0.routineTemplates) }
  }

  public func routine(_ id: String) async throws -> Routine {
    guard let routine = read({ $0.routines.first { $0.id == id } }) else {
      throw Self.notFound("Routine")
    }
    return routine
  }

  public func createRoutine(_ request: CreateRoutineRequest) async throws -> Routine {
    let routine = Routine(
      id: "rtn_\(UUID().uuidString.prefix(8).lowercased())", path: "Routines/\(request.name).md",
      name: request.name, schedule: request.schedule, notify: request.notify ?? .always,
      uses: request.uses ?? [], instructions: request.instructions)
    let routines = lock.withLock {
      snapshot.routines.append(routine)
      return snapshot.routines
    }
    broadcast(.routinesChanged(routines))
    return routine
  }

  public func runRoutine(_ id: String) async throws -> RoutineRunResponse {
    throw DaemonClientError.http(
      status: 503,
      body: ApiErrorBody(error: .agentUnavailable, message: "The sample doesn't run routines."))
  }

  public func pauseRoutine(_ id: String) async throws -> Routine { try setPaused(id, true) }
  public func resumeRoutine(_ id: String) async throws -> Routine { try setPaused(id, false) }

  private func setPaused(_ id: String, _ paused: Bool) throws -> Routine {
    let result: (Routine, [Routine])? = lock.withLock {
      guard let index = snapshot.routines.firstIndex(where: { $0.id == id }) else { return nil }
      snapshot.routines[index].paused = paused
      return (snapshot.routines[index], snapshot.routines)
    }
    guard let (routine, routines) = result else { throw Self.notFound("Routine") }
    broadcast(.routinesChanged(routines))
    return routine
  }

  public func threads(routineId: String) async throws -> [ThreadSummary] {
    read { $0.threads.filter { $0.routineId == routineId } }
  }

  // MARK: Events

  public func connect() async {}
  public func disconnect() async {}

  public func events() -> AsyncStream<DaemonStreamItem> {
    let id = UUID()
    let (stream, continuation) = AsyncStream.makeStream(of: DaemonStreamItem.self)
    continuation.onTermination = { [weak self] _ in self?.removeSubscriber(id) }
    lock.withLock { subscribers[id] = continuation }
    continuation.yield(.state(.connected(serverVersion: "sample")))
    return stream
  }

  private func removeSubscriber(_ id: UUID) {
    lock.withLock { _ = subscribers.removeValue(forKey: id) }
  }

  public func send(_ event: ClientEvent) async {
    lock.withLock { sentEvents.append(event) }
  }
}
