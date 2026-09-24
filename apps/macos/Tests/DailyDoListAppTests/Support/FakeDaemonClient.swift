import DailyDoListClient
import DailyDoListModels
import Foundation

/// A controllable in-memory daemon for store tests: `baseVersion` semantics like the daemon,
/// writes that can be held (to test single-flight and coalescing), injectable failures, a call log
/// and a hand-driven event stream.
final class FakeDaemonClient: DaemonClient, @unchecked Sendable {
  let clientId = "test_client"

  private let lock = NSLock()
  private var state = State()
  private var subscribers: [UUID: AsyncStream<DaemonStreamItem>.Continuation] = [:]
  private var heldWrites: [CheckedContinuation<Void, Never>] = []

  struct Note {
    var content: String
    var version: String
  }

  struct State {
    var vaultName = "Test Vault"
    var notes: [String: Note] = [:]
    var folders: Set<String> = []
    var versionCounter = 0
    var settings = AppSettings.defaults
    var health = HealthResponse(version: "0.1.0-test", apiVersion: DaemonProtocol.apiVersion, vaultName: "Test Vault", agentMode: .mock)
    var agentStatus = AgentStatusResponse(
      mode: .mock, enabled: true, model: "test/model", running: 0, queued: 0, pendingApprovals: 0,
      connectors: [], execution: ExecutionStatus(provider: "local", capabilities: ExecutionCapabilities(shell: true, browser: false, computer: false)))
    var records: [String: [TaskAgentRecord]] = [:]
    var searchHits: [SearchHit]?
    var today = "2026-09-23"
    var dailyTemplate = "- [ ] "
    var connectionState: ConnectionState = .idle
    /// method name (e.g. "health", "writeNote", "readNote:Ideas.md") → error to throw.
    var failures: [String: DaemonClientError] = [:]
    var holdWrites = false
    var calls: [String] = []
    var writes: [(path: String, content: String, base: BaseVersion)] = []
    var sent: [ClientEvent] = []
  }

  init(notes: [String: String] = [:], folders: Set<String> = []) {
    for (path, content) in notes { _ = setNote(path, content) }
    lock.withLock { state.folders = folders }
  }

  // MARK: - Test controls

  func withState<T>(_ body: (inout State) -> T) -> T { lock.withLock { body(&state) } }

  /// Writes a note directly (like another program), returning the new version.
  @discardableResult
  func setNote(_ path: String, _ content: String) -> String {
    lock.withLock {
      state.versionCounter += 1
      let version = "v\(state.versionCounter)"
      state.notes[path] = Note(content: content, version: version)
      return version
    }
  }

  func removeNote(_ path: String) { lock.withLock { state.notes[path] = nil } }
  func note(_ path: String) -> Note? { lock.withLock { state.notes[path] } }
  func fail(_ method: String, with error: DaemonClientError?) { lock.withLock { state.failures[method] = error } }
  var calls: [String] { lock.withLock { state.calls } }
  var writes: [(path: String, content: String, base: BaseVersion)] { lock.withLock { state.writes } }
  var sent: [ClientEvent] { lock.withLock { state.sent } }
  func calls(_ prefix: String) -> [String] { calls.filter { $0.hasPrefix(prefix) } }
  func resetLog() { lock.withLock { state.calls = []; state.writes = [] } }

  var holdWrites: Bool {
    get { lock.withLock { state.holdWrites } }
    set { lock.withLock { state.holdWrites = newValue } }
  }

  var heldWriteCount: Int { lock.withLock { heldWrites.count } }

  /// Lets the oldest held write proceed.
  func releaseNextWrite() {
    let next: CheckedContinuation<Void, Never>? = lock.withLock { heldWrites.isEmpty ? nil : heldWrites.removeFirst() }
    next?.resume()
  }

  func releaseAllWrites() {
    let all = lock.withLock { () -> [CheckedContinuation<Void, Never>] in
      defer { heldWrites = [] }
      return heldWrites
    }
    for continuation in all { continuation.resume() }
  }

  func emit(_ item: DaemonStreamItem) {
    let continuations = lock.withLock { Array(subscribers.values) }
    for continuation in continuations { continuation.yield(item) }
  }

  func emit(_ event: ServerEvent) { emit(.event(event)) }

  var subscriberCount: Int { lock.withLock { subscribers.count } }

  // MARK: - Helpers

  private func begin(_ name: String, detail: String? = nil) throws {
    let error: DaemonClientError? = lock.withLock {
      state.calls.append(detail.map { "\(name):\($0)" } ?? name)
      return state.failures[detail.map { "\(name):\($0)" } ?? name] ?? state.failures[name]
    }
    if let error { throw error }
  }

  private static func notFound(_ path: String) -> DaemonClientError {
    .http(status: 404, body: ApiErrorBody(error: .notFound, message: "\(path) not found"))
  }

  private func response(_ path: String, _ note: Note) -> NoteResponse {
    NoteResponse(path: path, content: note.content, version: note.version, mtime: 1_000)
  }

  // MARK: - Vault

  func health() async throws -> HealthResponse {
    try begin("health")
    return lock.withLock { state.health }
  }

  func tree() async throws -> VaultTreeResponse {
    try begin("tree")
    return lock.withLock {
      let files = state.notes.map { VaultEntry(path: $0.key, kind: .file, version: $0.value.version) }
      let folders = state.folders.map { VaultEntry(path: $0, kind: .folder) }
      return VaultTreeResponse(vaultName: state.vaultName, entries: files + folders)
    }
  }

  func readNote(_ path: String) async throws -> NoteResponse {
    try begin("readNote", detail: path)
    return try lock.withLock {
      guard let note = state.notes[path] else { throw Self.notFound(path) }
      return response(path, note)
    }
  }

  func writeNote(_ path: String, content: String, baseVersion: BaseVersion) async throws -> WriteNoteResponse {
    let hold = lock.withLock { () -> Bool in
      state.writes.append((path, content, baseVersion))
      return state.holdWrites
    }
    if hold {
      await withCheckedContinuation { continuation in
        lock.withLock { heldWrites.append(continuation) }
      }
    }
    try begin("writeNote", detail: path)
    return try lock.withLock {
      let existing = state.notes[path]
      switch baseVersion {
      case .unconditional: break
      case .createOnly:
        if let existing { throw DaemonClientError.conflict(ConflictResponse(current: response(path, existing))) }
      case .match(let version):
        guard let existing else { throw DaemonClientError.conflict(ConflictResponse(current: nil)) }
        if existing.version != version {
          throw DaemonClientError.conflict(ConflictResponse(current: response(path, existing)))
        }
      }
      state.versionCounter += 1
      let version = "v\(state.versionCounter)"
      state.notes[path] = Note(content: content, version: version)
      return WriteNoteResponse(path: path, version: version, mtime: 2_000)
    }
  }

  func deleteNote(_ path: String) async throws -> TrashResponse {
    try begin("deleteNote", detail: path)
    return try lock.withLock {
      guard state.notes.removeValue(forKey: path) != nil else { throw Self.notFound(path) }
      return TrashResponse(trashedTo: ".trash/\(path)")
    }
  }

  func rename(from: String, to: String) async throws -> RenameResponse {
    try begin("rename", detail: "\(from)->\(to)")
    return try lock.withLock {
      if let note = state.notes[from] {
        if let existing = state.notes[to] {
          throw DaemonClientError.conflict(ConflictResponse(current: response(to, existing)))
        }
        state.notes[from] = nil
        state.notes[to] = note
        return .note(WriteNoteResponse(path: to, version: note.version, mtime: 3_000))
      }
      let inside = state.notes.keys.filter { $0.hasPrefix("\(from)/") }
      guard state.folders.contains(from) || !inside.isEmpty else { throw Self.notFound(from) }
      for path in inside {
        state.notes["\(to)\(path.dropFirst(from.count))"] = state.notes.removeValue(forKey: path)
      }
      state.folders = Set(state.folders.map { $0 == from || $0.hasPrefix("\(from)/") ? "\(to)\($0.dropFirst(from.count))" : $0 })
      return .folder(FolderRenameResponse(path: to, moved: inside.count))
    }
  }

  func createFolder(_ path: String) async throws -> CreateFolderResponse {
    try begin("createFolder", detail: path)
    lock.withLock { _ = state.folders.insert(path) }
    return CreateFolderResponse(path: path)
  }

  func deleteFolder(_ path: String) async throws -> TrashResponse {
    try begin("deleteFolder", detail: path)
    lock.withLock {
      state.folders = state.folders.filter { $0 != path && !$0.hasPrefix("\(path)/") }
      for key in state.notes.keys where key.hasPrefix("\(path)/") { state.notes[key] = nil }
    }
    return TrashResponse(trashedTo: ".trash/\(path)")
  }

  func dailyNote(_ date: String, create: Bool) async throws -> DailyNoteResponse {
    try begin("dailyNote", detail: date)
    return try lock.withLock {
      let iso = date == "today" ? state.today : date
      let path = "Daily/\(iso).md"
      var created = false
      if state.notes[path] == nil {
        guard create else { throw Self.notFound(path) }
        state.versionCounter += 1
        state.notes[path] = Note(content: state.dailyTemplate, version: "v\(state.versionCounter)")
        created = true
      }
      let note = state.notes[path] ?? Note(content: "", version: "v0")
      return DailyNoteResponse(path: path, content: note.content, version: note.version, mtime: 1_000, date: iso, created: created)
    }
  }

  func search(_ query: String, limit: Int?) async throws -> SearchResponse {
    try begin("search", detail: query)
    return lock.withLock {
      if let hits = state.searchHits { return SearchResponse(hits: hits) }
      var hits: [SearchHit] = []
      for (path, note) in state.notes.sorted(by: { $0.key < $1.key }) {
        if path.localizedCaseInsensitiveContains(query) {
          hits.append(SearchHit(path: path, kind: .name, line: 0, preview: path))
        }
        for (index, line) in note.content.components(separatedBy: "\n").enumerated() where line.localizedCaseInsensitiveContains(query) {
          hits.append(SearchHit(path: path, kind: .content, line: index, preview: line))
        }
      }
      return SearchResponse(hits: hits)
    }
  }

  // MARK: - Settings & agent

  func settings() async throws -> AppSettings {
    try begin("settings")
    return lock.withLock { state.settings }
  }

  func updateSettings(_ patch: SettingsPatch) async throws -> AppSettings {
    try begin("updateSettings")
    return lock.withLock {
      state.settings = state.settings.applying(patch)
      return state.settings
    }
  }

  func agentStatus() async throws -> AgentStatusResponse {
    try begin("agentStatus")
    return lock.withLock { state.agentStatus }
  }

  func setAgentEnabled(_ enabled: Bool) async throws -> AgentStatusResponse {
    try begin("setAgentEnabled")
    return lock.withLock {
      state.agentStatus.enabled = enabled
      return state.agentStatus
    }
  }

  func connectors() async throws -> [ConnectorStatus] {
    try begin("connectors")
    return [ConnectorStatus(name: "calendar", transport: .stdio, state: .connected, toolCount: 4)]
  }

  func taskRecords(notePath: String) async throws -> [TaskAgentRecord] {
    try begin("taskRecords", detail: notePath)
    return lock.withLock { state.records[notePath] ?? [] }
  }

  func threads(notePath: String?, taskId: String?) async throws -> [ThreadSummary] {
    try begin("threads")
    return []
  }

  func thread(_ id: String) async throws -> ThreadResponse {
    try begin("thread", detail: id)
    throw Self.notFound(id)
  }

  func postMessage(threadId: String, text: String) async throws -> ThreadActionResponse {
    try begin("postMessage")
    return ThreadActionResponse()
  }

  func cancelThread(_ id: String) async throws -> ThreadActionResponse {
    try begin("cancelThread")
    return ThreadActionResponse()
  }

  func retryThread(_ id: String) async throws -> ThreadActionResponse {
    try begin("retryThread")
    return ThreadActionResponse()
  }

  func approvals(status: ApprovalStatus?) async throws -> [ApprovalRequest] {
    try begin("approvals")
    return []
  }

  func decideApproval(_ id: String, _ decision: ApprovalDecisionRequest) async throws -> ApprovalRequest {
    try begin("decideApproval")
    throw Self.notFound(id)
  }

  func artifact(threadId: String, artifactId: String) async throws -> ArtifactPayload {
    try begin("artifact")
    return ArtifactPayload(data: Data("# Artifact".utf8), mimeType: "text/markdown")
  }

  // MARK: - Events

  func connect() async {
    lock.withLock { state.calls.append("connect") }
    setConnection(.connecting)
    setConnection(.connected(serverVersion: "0.1.0-test"))
  }

  /// Like the real client: reports `.disconnected`, then finishes every event stream.
  func disconnect() async {
    lock.withLock { state.calls.append("disconnect") }
    setConnection(.disconnected)
    let finished = lock.withLock { () -> [AsyncStream<DaemonStreamItem>.Continuation] in
      defer { subscribers = [:] }
      return Array(subscribers.values)
    }
    for continuation in finished { continuation.finish() }
  }

  func setConnection(_ connection: ConnectionState) {
    lock.withLock { state.connectionState = connection }
    emit(.state(connection))
  }

  func events() -> AsyncStream<DaemonStreamItem> {
    let (stream, continuation) = AsyncStream.makeStream(of: DaemonStreamItem.self)
    let id = UUID()
    let current = lock.withLock { () -> ConnectionState in
      subscribers[id] = continuation
      return state.connectionState
    }
    continuation.onTermination = { [weak self] _ in
      self?.lock.withLock { _ = self?.subscribers.removeValue(forKey: id) }
    }
    continuation.yield(.state(current))
    return stream
  }

  func send(_ event: ClientEvent) async {
    lock.withLock { state.sent.append(event) }
  }
}
