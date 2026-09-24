import DailyDoListModels
import Foundation

/// Where a daemon lives and how to authenticate to it.
public struct DaemonEndpoint: Hashable, Sendable {
  /// e.g. `http://127.0.0.1:7331`
  public var baseURL: URL
  /// Bearer token (`$DDL_HOME/daemon-token`).
  public var token: String

  public init(baseURL: URL, token: String) {
    self.baseURL = baseURL
    self.token = token
  }

  /// `ws://…/ws?token=…`
  public var webSocketURL: URL {
    var components = URLComponents(url: baseURL, resolvingAgainstBaseURL: false)!
    components.scheme = baseURL.scheme == "https" ? "wss" : "ws"
    components.path = APIRoute.webSocket
    components.queryItems = [URLQueryItem(name: "token", value: token)]
    return components.url!
  }
}

public enum DaemonClientError: Error, Equatable, Sendable {
  /// The daemon could not be reached (not running, wrong port, offline).
  case unreachable(String)
  /// 401: missing or wrong token.
  case unauthorized
  /// 409 on a note write or rename: the target changed (or is gone when `current` is nil).
  case conflict(ConflictResponse)
  /// 409 on an approval decision: it is no longer pending.
  case approvalConflict(ApprovalConflictResponse)
  /// Any other non-2xx answer.
  case http(status: Int, body: ApiErrorBody?)
  /// The response did not match the protocol.
  case decoding(String)
  /// The daemon speaks a different major API version.
  case incompatibleApiVersion(server: Int)
  case cancelled
}

extension DaemonClientError: LocalizedError {
  public var errorDescription: String? {
    switch self {
    case .unreachable(let reason): "Can't reach the Daily Do List daemon (\(reason))."
    case .unauthorized: "The daemon rejected this app's token."
    case .conflict: "The note changed on disk before this edit was saved."
    case .approvalConflict: "That approval was already decided."
    case .http(let status, let body): body?.message ?? "The daemon answered HTTP \(status)."
    case .decoding(let detail): "Unexpected response from the daemon: \(detail)"
    case .incompatibleApiVersion(let server):
      "The daemon speaks API v\(server); this app needs v\(DaemonProtocol.apiVersion)."
    case .cancelled: "Cancelled."
    }
  }
}

/// State of the WebSocket event connection.
public enum ConnectionState: Equatable, Sendable {
  case idle
  case connecting
  case connected(serverVersion: String)
  /// Lost; the client reconnects automatically (with backoff) until `disconnect()`.
  case reconnecting(attempt: Int, reason: String?)
  /// The daemon's major API version differs; the client stops reconnecting.
  case incompatible(serverApiVersion: Int)
  case disconnected
}

/// Items of the event stream: connection state changes and server events, in order.
public enum DaemonStreamItem: Sendable {
  case state(ConnectionState)
  case event(ServerEvent)
  /// Emitted after a reconnect: state may have been missed, so consumers should refetch.
  case resync
}

/// Everything the apps need from the daemon. `HTTPDaemonClient` is the real implementation;
/// `InMemoryDaemonClient` is a deterministic fake for tests, previews and demo mode.
public protocol DaemonClient: AnyObject, Sendable {
  /// Per-launch id sent with writes (`x-ddl-client-id`) and in the WebSocket hello.
  var clientId: String { get }

  // Vault
  func health() async throws -> HealthResponse
  func tree() async throws -> VaultTreeResponse
  func readNote(_ path: String) async throws -> NoteResponse
  /// Throws `.conflict` when `baseVersion` no longer matches.
  func writeNote(_ path: String, content: String, baseVersion: BaseVersion) async throws -> WriteNoteResponse
  /// Soft delete (moves into `.trash/`).
  func deleteNote(_ path: String) async throws -> TrashResponse
  /// Renames a note or a folder.
  func rename(from: String, to: String) async throws -> RenameResponse
  func createFolder(_ path: String) async throws -> CreateFolderResponse
  /// Soft delete of a folder and everything in it.
  func deleteFolder(_ path: String) async throws -> TrashResponse
  /// `date` is `today` or `YYYY-MM-DD` (local); `create` makes it from the template if missing.
  func dailyNote(_ date: String, create: Bool) async throws -> DailyNoteResponse
  func search(_ query: String, limit: Int?) async throws -> SearchResponse

  // Settings & agent
  func settings() async throws -> AppSettings
  func updateSettings(_ patch: SettingsPatch) async throws -> AppSettings
  func agentStatus() async throws -> AgentStatusResponse
  func setAgentEnabled(_ enabled: Bool) async throws -> AgentStatusResponse
  func connectors() async throws -> [ConnectorStatus]
  func taskRecords(notePath: String) async throws -> [TaskAgentRecord]
  func threads(notePath: String?, taskId: String?) async throws -> [ThreadSummary]
  func thread(_ id: String) async throws -> ThreadResponse
  func postMessage(threadId: String, text: String) async throws -> ThreadActionResponse
  func cancelThread(_ id: String) async throws -> ThreadActionResponse
  func retryThread(_ id: String) async throws -> ThreadActionResponse
  func approvals(status: ApprovalStatus?) async throws -> [ApprovalRequest]
  /// Throws `.approvalConflict` when it was already decided.
  func decideApproval(_ id: String, _ decision: ApprovalDecisionRequest) async throws -> ApprovalRequest
  func artifact(threadId: String, artifactId: String) async throws -> ArtifactPayload

  // Events (WebSocket)
  /// Opens the event connection (idempotent); reconnects automatically until `disconnect()`.
  func connect() async
  func disconnect() async
  /// A new independent stream of connection states and server events (multiple consumers OK).
  func events() -> AsyncStream<DaemonStreamItem>
  /// Sends a client signal; dropped silently while disconnected (signals are best-effort).
  func send(_ event: ClientEvent) async
}

public struct ArtifactPayload: Hashable, Sendable {
  public var data: Data
  public var mimeType: String

  public init(data: Data, mimeType: String) {
    self.data = data
    self.mimeType = mimeType
  }
}
