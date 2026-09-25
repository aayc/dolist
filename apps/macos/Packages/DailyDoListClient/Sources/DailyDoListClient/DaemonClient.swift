import DailyDoListModels
import Foundation

/// Everything the apps need from the daemon. `HTTPDaemonClient` is the real implementation;
/// `InMemoryDaemonClient` is a deterministic fake for tests, previews and demo mode.
///
/// Every throwing method throws `DaemonClientError`.
public protocol DaemonClient: AnyObject, Sendable {
  /// Per-launch id sent with writes (`x-ddl-client-id`) and in the WebSocket hello. The daemon
  /// echoes it on `vault.changed` so the app can ignore its own writes.
  var clientId: String { get }

  // Vault
  func health() async throws -> HealthResponse
  func tree() async throws -> VaultTreeResponse
  func readNote(_ path: String) async throws -> NoteResponse
  /// Throws `.conflict` when `baseVersion` no longer matches.
  func writeNote(_ path: String, content: String, baseVersion: BaseVersion) async throws
    -> WriteNoteResponse
  /// Soft delete (moves into `.trash/`).
  func deleteNote(_ path: String) async throws -> TrashResponse
  /// Renames a note or a folder. A note whose target exists throws `.conflict` (with the existing
  /// note); a folder whose target exists throws `.http(status: 409, …)`.
  func rename(from: String, to: String) async throws -> RenameResponse
  func createFolder(_ path: String) async throws -> CreateFolderResponse
  /// Soft delete of a folder and everything in it.
  func deleteFolder(_ path: String) async throws -> TrashResponse
  /// `date` is `today` or `YYYY-MM-DD` (local); `create` makes it from the template if missing.
  func dailyNote(_ date: String, create: Bool) async throws -> DailyNoteResponse
  func search(_ query: String, limit: Int?) async throws -> SearchResponse

  // Settings & agent
  func settings() async throws -> AppSettings
  /// Applies a deep-partial patch; out-of-range values throw `.http(status: 400, …)`.
  func updateSettings(_ patch: SettingsPatch) async throws -> AppSettings
  func agentStatus() async throws -> AgentStatusResponse
  func setAgentEnabled(_ enabled: Bool) async throws -> AgentStatusResponse
  func connectors() async throws -> [ConnectorStatus]
  func taskRecords(notePath: String) async throws -> [TaskAgentRecord]
  func threads(notePath: String?, taskId: String?) async throws -> [ThreadSummary]
  func thread(_ id: String) async throws -> ThreadResponse
  /// `pending == true` when the daemon accepted the action and finishes it in the background.
  func postMessage(threadId: String, text: String) async throws -> ThreadActionResponse
  func cancelThread(_ id: String) async throws -> ThreadActionResponse
  func retryThread(_ id: String) async throws -> ThreadActionResponse
  func approvals(status: ApprovalStatus?) async throws -> [ApprovalRequest]
  /// Throws `.approvalConflict` when it was already decided.
  func decideApproval(_ id: String, _ decision: ApprovalDecisionRequest) async throws
    -> ApprovalRequest
  func artifact(threadId: String, artifactId: String) async throws -> ArtifactPayload

  // Routines
  /// Every routine (sorted by name) and the starter templates of "New Routine…".
  func routines() async throws -> RoutineListResponse
  func routine(_ id: String) async throws -> Routine
  /// Writes `Routines/<name>.md`. Throws `.http(status: 400, …)` for a name or schedule the daemon
  /// can't use (the message says why) and `.http(status: 409, …)` when the name is taken.
  func createRoutine(_ request: CreateRoutineRequest) async throws -> Routine
  /// Starts a run now. Throws `.http(status: 409, …)` while a run is going, when the routine has
  /// a problem or today's extra runs are used up, and `.http(status: 503, …)` when the agent
  /// can't run on this device.
  func runRoutine(_ id: String) async throws -> RoutineRunResponse
  /// Sets `paused: true` in the routine's file.
  func pauseRoutine(_ id: String) async throws -> Routine
  /// Sets `paused: false` in the routine's file.
  func resumeRoutine(_ id: String) async throws -> Routine
  /// A routine's runs (their threads), newest first.
  func threads(routineId: String) async throws -> [ThreadSummary]

  // Events (WebSocket)
  /// Opens the event connection (idempotent); reconnects automatically until `disconnect()`.
  func connect() async
  /// Closes the connection and stops reconnecting. Every stream returned by `events()` so far
  /// receives `.state(.disconnected)` and then finishes.
  func disconnect() async
  /// A new independent stream of connection states and server events (multiple consumers OK).
  /// It starts with the current state and ends at the next `disconnect()`.
  func events() -> AsyncStream<DaemonStreamItem>
  /// Sends a client signal; dropped silently while disconnected (signals are best-effort).
  /// Surface subscriptions are remembered and re-sent after every (re)connect.
  func send(_ event: ClientEvent) async
}

/// Bytes of an artifact as served by `GET /api/artifacts/:threadId/:artifactId`.
public struct ArtifactPayload: Hashable, Sendable {
  public var data: Data
  /// Media type without parameters, e.g. `text/markdown` (not `text/markdown; charset=utf-8`).
  public var mimeType: String

  public init(data: Data, mimeType: String) {
    self.data = data
    self.mimeType = mimeType
  }
}
