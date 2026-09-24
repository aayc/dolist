import DailyDoListModels
import Foundation

/// The real `DaemonClient`: REST under `/api/*` and the `/ws` event stream of a local daemon.
///
/// Every request carries `Authorization: Bearer <token>`; writes also carry `x-ddl-client-id`
/// so the daemon can tag the resulting `vault.changed` events with `clientId`. Errors are always
/// `DaemonClientError`. URLSession sends no `Origin` header and `Host: 127.0.0.1:<port>`, which
/// is exactly what the daemon's DNS-rebinding/CSRF guard accepts from a native client.
public final class HTTPDaemonClient: DaemonClient {
  public let endpoint: DaemonEndpoint
  public let clientId: String
  /// Sent in the WebSocket hello for diagnostics, e.g. `macos/1.0`.
  public let clientVersion: String
  let transport: RESTTransport
  let connection: EventConnection

  /// - Parameters:
  ///   - endpoint: Base URL and token, e.g. from `DaemonEndpoint.discover()`.
  ///   - session: Session for REST and the WebSocket (default `.shared`).
  ///   - clientId: Per-launch id matching `^[A-Za-z0-9_-]{1,128}$` (the daemon ignores others).
  ///   - clientVersion: `macos/<version>` by default (from the main bundle).
  ///   - options: Timeouts, reconnect backoff and keep-alive.
  public init(
    endpoint: DaemonEndpoint,
    session: URLSession = .shared,
    clientId: String = HTTPDaemonClient.makeClientID(),
    clientVersion: String = HTTPDaemonClient.defaultClientVersion,
    options: Options = Options()
  ) {
    self.endpoint = endpoint
    self.clientId = clientId
    self.clientVersion = clientVersion
    transport = RESTTransport(
      endpoint: endpoint, session: session, clientId: clientId,
      requestTimeout: options.requestTimeout, artifactTimeout: options.artifactTimeout)
    connection = EventConnection(
      endpoint: endpoint, session: session, clientId: clientId, clientVersion: clientVersion,
      configuration: EventConnection.Configuration(
        backoff: options.reconnectBackoff, helloTimeout: options.helloTimeout,
        pingInterval: options.pingInterval, maximumMessageSize: options.maximumMessageSize))
  }

  deinit {
    let connection = connection
    Task { await connection.disconnect() }
  }

  /// `macos_<32 hex>`: unique per launch, valid for the daemon's client-id pattern.
  public static func makeClientID() -> String {
    "macos_" + UUID().uuidString.lowercased().replacingOccurrences(of: "-", with: "")
  }

  /// `macos/<CFBundleShortVersionString>` (`macos/dev` outside an app bundle).
  public static var defaultClientVersion: String {
    let version = Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String
    return "macos/\(version.flatMap { $0.isEmpty ? nil : $0 } ?? "dev")"
  }

  /// Whether `id` is a client id the daemon accepts for attribution.
  public static func isValidClientID(_ id: String) -> Bool { RequestGuards.isClientID(id) }

  // MARK: - Vault

  public func health() async throws -> HealthResponse {
    try await transport.json(.get, APIRoute.health)
  }

  public func tree() async throws -> VaultTreeResponse {
    try await transport.json(.get, APIRoute.tree)
  }

  public func readNote(_ path: String) async throws -> NoteResponse {
    try await transport.json(.get, try RequestGuards.noteRoute(path))
  }

  public func writeNote(_ path: String, content: String, baseVersion: BaseVersion) async throws -> WriteNoteResponse {
    try await transport.json(
      .put, try RequestGuards.noteRoute(path),
      body: WriteNoteRequest(content: content, baseVersion: baseVersion), conflict: .note)
  }

  public func deleteNote(_ path: String) async throws -> TrashResponse {
    try await transport.json(.delete, try RequestGuards.noteRoute(path))
  }

  public func rename(from: String, to: String) async throws -> RenameResponse {
    try await transport.json(.post, APIRoute.rename, body: RenameRequest(from: from, to: to), conflict: .note)
  }

  public func createFolder(_ path: String) async throws -> CreateFolderResponse {
    try await transport.json(.post, APIRoute.folders, body: CreateFolderRequest(path: path))
  }

  public func deleteFolder(_ path: String) async throws -> TrashResponse {
    try await transport.json(.delete, APIRoute.deleteFolder(path))
  }

  /// With `create`, this GET writes the note, so it is attributed like a write.
  public func dailyNote(_ date: String, create: Bool) async throws -> DailyNoteResponse {
    try await transport.json(.get, APIRoute.daily(date, create: create), attribute: create)
  }

  public func search(_ query: String, limit: Int?) async throws -> SearchResponse {
    try await transport.json(.get, APIRoute.search(query, limit: limit))
  }

  // MARK: - Settings & agent

  public func settings() async throws -> AppSettings {
    try await transport.json(.get, APIRoute.settings, as: SettingsResponse.self).settings
  }

  public func updateSettings(_ patch: SettingsPatch) async throws -> AppSettings {
    try await transport.json(.put, APIRoute.settings, body: patch, as: SettingsResponse.self).settings
  }

  public func agentStatus() async throws -> AgentStatusResponse {
    try await transport.json(.get, APIRoute.agentStatus)
  }

  public func setAgentEnabled(_ enabled: Bool) async throws -> AgentStatusResponse {
    try await transport.json(.put, APIRoute.agentEnabled, body: SetAgentEnabledRequest(enabled: enabled))
  }

  public func connectors() async throws -> [ConnectorStatus] {
    try await transport.json(.get, APIRoute.connectors, as: ConnectorsResponse.self).connectors
  }

  public func taskRecords(notePath: String) async throws -> [TaskAgentRecord] {
    try await transport.json(.get, APIRoute.tasks(notePath: notePath), as: TaskRecordsResponse.self).records
  }

  public func threads(notePath: String?, taskId: String?) async throws -> [ThreadSummary] {
    try await transport.json(
      .get, APIRoute.threads(notePath: notePath, taskId: taskId), as: ThreadListResponse.self
    ).threads
  }

  public func thread(_ id: String) async throws -> ThreadResponse {
    try await transport.json(.get, APIRoute.thread(try RequestGuards.runtimeID(id, "thread id")))
  }

  public func postMessage(threadId: String, text: String) async throws -> ThreadActionResponse {
    let id = try RequestGuards.runtimeID(threadId, "thread id")
    return try await transport.json(.post, APIRoute.threadMessages(id), body: PostMessageRequest(text: text))
  }

  public func cancelThread(_ id: String) async throws -> ThreadActionResponse {
    try await transport.json(.post, APIRoute.threadCancel(try RequestGuards.runtimeID(id, "thread id")))
  }

  public func retryThread(_ id: String) async throws -> ThreadActionResponse {
    try await transport.json(.post, APIRoute.threadRetry(try RequestGuards.runtimeID(id, "thread id")))
  }

  public func approvals(status: ApprovalStatus?) async throws -> [ApprovalRequest] {
    try await transport.json(.get, APIRoute.approvals(status: status), as: ApprovalListResponse.self).approvals
  }

  public func decideApproval(_ id: String, _ decision: ApprovalDecisionRequest) async throws -> ApprovalRequest {
    let id = try RequestGuards.runtimeID(id, "approval id")
    return try await transport.json(
      .post, APIRoute.approval(id), body: decision, conflict: .approval, as: ApprovalResponse.self
    ).approval
  }

  public func artifact(threadId: String, artifactId: String) async throws -> ArtifactPayload {
    let thread = try RequestGuards.runtimeID(threadId, "threadId")
    let artifact = try RequestGuards.runtimeID(artifactId, "artifactId")
    return try await transport.bytes(APIRoute.artifact(threadId: thread, artifactId: artifact))
  }

  // MARK: - Events

  public func connect() async {
    await connection.connect()
  }

  public func disconnect() async {
    await connection.disconnect()
  }

  public func events() -> AsyncStream<DaemonStreamItem> {
    connection.broadcaster.stream()
  }

  public func send(_ event: ClientEvent) async {
    await connection.send(event)
  }

  /// The connection state as of now (streams from `events()` report every change).
  public var connectionState: ConnectionState {
    connection.broadcaster.currentState
  }
}

extension HTTPDaemonClient {
  /// Tunables of an `HTTPDaemonClient`. The defaults suit the local daemon.
  public struct Options: Sendable {
    /// Per-request timeout of JSON calls.
    public var requestTimeout: Duration
    /// Timeout of artifact downloads.
    public var artifactTimeout: Duration
    /// Delays between WebSocket reconnect attempts.
    public var reconnectBackoff: ReconnectBackoff
    /// How long to wait for the daemon's `hello` after connecting before retrying.
    public var helloTimeout: Duration
    /// Interval of `{"type":"ping"}` keep-alives while connected; nil disables them.
    public var pingInterval: Duration?
    /// Largest server message accepted (surface frames can be large).
    public var maximumMessageSize: Int

    public init(
      requestTimeout: Duration = .seconds(15),
      artifactTimeout: Duration = .seconds(60),
      reconnectBackoff: ReconnectBackoff = .default,
      helloTimeout: Duration = .seconds(10),
      pingInterval: Duration? = .seconds(25),
      maximumMessageSize: Int = 16 * 1024 * 1024
    ) {
      self.requestTimeout = requestTimeout
      self.artifactTimeout = artifactTimeout
      self.reconnectBackoff = reconnectBackoff
      self.helloTimeout = helloTimeout
      self.pingInterval = pingInterval
      self.maximumMessageSize = maximumMessageSize
    }
  }
}
