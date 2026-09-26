import DailyDoListClient
import DailyDoListModels
import Foundation

/// A controllable daemon for store and view tests: a vault with the daemon's `baseVersion`
/// semantics, writes that can be held (to test single-flight and coalescing), injectable failures,
/// a call log, a hand-driven event stream, and canned answers per call (`script`). Unscripted, the
/// agent and routine calls answer from `State`, and the device, pairing and import calls like a
/// daemon without those routes (404).
public final class FakeDaemonClient: DaemonClient, @unchecked Sendable {
  public let clientId = "test_client"

  private let lock = NSLock()
  private var state = State()
  private var subscribers: [UUID: AsyncStream<DaemonStreamItem>.Continuation] = [:]
  private var heldWrites: [CheckedContinuation<Void, Never>] = []

  public struct Note: Sendable {
    public var content: String
    public var version: String
  }

  public struct State: Sendable {
    public var vaultName = "Test Vault"
    public var notes: [String: Note] = [:]
    public var folders: Set<String> = []
    public var versionCounter = 0
    public var settings = AppSettings.defaults
    public var health = HealthResponse(
      version: "0.1.0-test", apiVersion: DaemonProtocol.apiVersion, vaultName: "Test Vault",
      agentMode: .mock)
    public var agentStatus = AgentStatusResponse(
      mode: .mock, enabled: true, model: "test/model", running: 0, queued: 0, pendingApprovals: 0,
      connectors: [],
      execution: ExecutionStatus(
        provider: "local",
        capabilities: ExecutionCapabilities(shell: true, browser: false, computer: false)))
    public var records: [String: [TaskAgentRecord]] = [:]
    public var today = "2026-09-23"
    public var dailyTemplate = "- [ ] "
    public var connectionState: ConnectionState = .idle
    /// method name (e.g. "health", "writeNote", "readNote:Ideas.md") → error to throw.
    public var failures: [String: DaemonClientError] = [:]
    public var holdWrites = false
    public var calls: [String] = []
    public var writes: [(path: String, content: String, base: BaseVersion)] = []
    /// Writes that landed, with the text they replaced.
    public var landed: [(path: String, before: String?, content: String)] = []
    public var sent: [ClientEvent] = []
    public var routines: [Routine] = []
    public var routineTemplates: [RoutineTemplate] = []
    public var routineRuns: [String: [ThreadSummary]] = [:]
    public var script = Script()
  }

  /// Answers that replace the defaults, per call.
  public struct Script: Sendable {
    public var agentStatus: (@Sendable () async throws -> AgentStatusResponse)?
    public var setAgentEnabled: (@Sendable (Bool) async throws -> AgentStatusResponse)?
    public var taskRecords: (@Sendable (String) async throws -> [TaskAgentRecord])?
    public var threads: (@Sendable (String?, String?) async throws -> [ThreadSummary])?
    public var thread: (@Sendable (String) async throws -> ThreadResponse)?
    public var postMessage: (@Sendable (String, String) async throws -> ThreadActionResponse)?
    public var cancelThread: (@Sendable (String) async throws -> ThreadActionResponse)?
    public var retryThread: (@Sendable (String) async throws -> ThreadActionResponse)?
    public var approvals: (@Sendable (ApprovalStatus?) async throws -> [ApprovalRequest])?
    public var decideApproval:
      (@Sendable (String, ApprovalDecisionRequest) async throws -> ApprovalRequest)?
    public var artifact: (@Sendable (String, String) async throws -> ArtifactPayload)?
    public var routines: (@Sendable () async throws -> RoutineListResponse)?
    public var createRoutine: (@Sendable (CreateRoutineRequest) async throws -> Routine)?
    public var runRoutine: (@Sendable (String) async throws -> RoutineRunResponse)?
    /// Pause (true) and resume (false).
    public var pauseRoutine: (@Sendable (String, Bool) async throws -> Routine)?
    public var routineRuns: (@Sendable (String) async throws -> [ThreadSummary])?
    public var syncStatus: (@Sendable () async throws -> SyncStatusResponse)?
    public var deviceSettings: (@Sendable () async throws -> DeviceSettingsResponse)?
    public var updateDeviceSettings:
      (@Sendable (DeviceSettingsPatch) async throws -> DeviceSettingsResponse)?
    public var setUpSync:
      (@Sendable (DeviceSyncSetupRequest) async throws -> DeviceSettingsResponse)?
    public var turnOffSync: (@Sendable () async throws -> DeviceSettingsResponse)?
    public var createPairingCode:
      (@Sendable (PairingCodeRequest) async throws -> PairingCodeResponse)?
    public var pairedDevices: (@Sendable () async throws -> [PairedDevice])?
    public var revokeDevice: (@Sendable (String) async throws -> Void)?
    public var machineStatus: (@Sendable () async throws -> MachineStatusResponse)?
    public var pairMachine: (@Sendable (MachinePairRequest) async throws -> MachineStatusResponse)?
    public var checkMachine: (@Sendable () async throws -> MachineStatusResponse)?
    public var forgetMachine: (@Sendable () async throws -> MachineStatusResponse)?
    public var deviceVault: (@Sendable () async throws -> DeviceVaultResponse)?
    public var switchVault: (@Sendable (DeviceVaultRequest) async throws -> DeviceVaultResponse)?
    public var previewObsidianImport:
      (@Sendable (ObsidianImportPreviewRequest) async throws -> ObsidianImportPreview)?
    public var obsidianImportStatus: (@Sendable () async throws -> ObsidianImportStatusResponse)?
    public var startObsidianImport:
      (@Sendable (ObsidianImportRequest) async throws -> ObsidianImportJob)?
    public var cancelObsidianImport: (@Sendable () async throws -> ObsidianImportJob)?
    public var updateFromObsidian: (@Sendable () async throws -> ObsidianImportJob)?

    public init() {}
  }

  public init(notes: [String: String] = [:], folders: Set<String> = []) {
    for (path, content) in notes { _ = setNote(path, content) }
    lock.withLock { state.folders = folders }
  }

  // MARK: - Test controls

  public func withState<T>(_ body: (inout State) -> T) -> T { lock.withLock { body(&state) } }

  public func script(_ edit: (inout Script) -> Void) { lock.withLock { edit(&state.script) } }

  /// Writes a note directly (like another program), returning the new version.
  @discardableResult
  public func setNote(_ path: String, _ content: String) -> String {
    lock.withLock {
      state.versionCounter += 1
      let version = "v\(state.versionCounter)"
      state.notes[path] = Note(content: content, version: version)
      return version
    }
  }

  public func removeNote(_ path: String) { lock.withLock { state.notes[path] = nil } }
  public func note(_ path: String) -> Note? { lock.withLock { state.notes[path] } }
  public func fail(_ method: String, with error: DaemonClientError?) {
    lock.withLock { state.failures[method] = error }
  }
  public var calls: [String] { lock.withLock { state.calls } }
  public var writes: [(path: String, content: String, base: BaseVersion)] {
    lock.withLock { state.writes }
  }
  public var landed: [(path: String, before: String?, content: String)] {
    lock.withLock { state.landed }
  }
  public var sent: [ClientEvent] { lock.withLock { state.sent } }
  public func calls(_ prefix: String) -> [String] { calls.filter { $0.hasPrefix(prefix) } }
  public func resetLog() {
    lock.withLock {
      state.calls = []
      state.writes = []
    }
  }

  public var holdWrites: Bool {
    get { lock.withLock { state.holdWrites } }
    set { lock.withLock { state.holdWrites = newValue } }
  }

  public var heldWriteCount: Int { lock.withLock { heldWrites.count } }

  public func releaseAllWrites() {
    let all = lock.withLock { () -> [CheckedContinuation<Void, Never>] in
      defer { heldWrites = [] }
      return heldWrites
    }
    for continuation in all { continuation.resume() }
  }

  public func emit(_ item: DaemonStreamItem) {
    let continuations = lock.withLock { Array(subscribers.values) }
    for continuation in continuations { continuation.yield(item) }
  }

  public func emit(_ event: ServerEvent) { emit(.event(event)) }

  // MARK: - Helpers

  /// Logs the call, throws its injected failure, and returns the script.
  private func begin(_ name: String, detail: String? = nil) throws -> Script {
    let (error, script): (DaemonClientError?, Script) = lock.withLock {
      let call = detail.map { "\(name):\($0)" } ?? name
      state.calls.append(call)
      return (state.failures[call] ?? state.failures[name], state.script)
    }
    if let error { throw error }
    return script
  }

  private static func notFound(_ what: String) -> DaemonClientError {
    .http(status: 404, body: ApiErrorBody(error: .notFound, message: "\(what) not found"))
  }

  /// What a daemon without the route answers.
  private static func notServed(_ route: String) -> DaemonClientError {
    .http(
      status: 404,
      body: ApiErrorBody(error: .notFound, message: "This daemon doesn't serve \(route)."))
  }

  private func response(_ path: String, _ note: Note) -> NoteResponse {
    NoteResponse(path: path, content: note.content, version: note.version, mtime: 1_000)
  }

  // MARK: - Vault

  public func health() async throws -> HealthResponse {
    _ = try begin("health")
    return lock.withLock { state.health }
  }

  public func tree() async throws -> VaultTreeResponse {
    _ = try begin("tree")
    return lock.withLock {
      let files = state.notes.map {
        VaultEntry(path: $0.key, kind: .file, version: $0.value.version)
      }
      let folders = state.folders.map { VaultEntry(path: $0, kind: .folder) }
      return VaultTreeResponse(vaultName: state.vaultName, entries: files + folders)
    }
  }

  public func readNote(_ path: String) async throws -> NoteResponse {
    _ = try begin("readNote", detail: path)
    return try lock.withLock {
      guard let note = state.notes[path] else { throw Self.notFound(path) }
      return response(path, note)
    }
  }

  public func writeNote(_ path: String, content: String, baseVersion: BaseVersion) async throws
    -> WriteNoteResponse
  {
    let hold = lock.withLock { () -> Bool in
      state.writes.append((path, content, baseVersion))
      return state.holdWrites
    }
    if hold {
      await withCheckedContinuation { continuation in
        lock.withLock { heldWrites.append(continuation) }
      }
    }
    _ = try begin("writeNote", detail: path)
    return try lock.withLock {
      let existing = state.notes[path]
      switch baseVersion {
      case .unconditional: break
      case .createOnly:
        if let existing {
          throw DaemonClientError.conflict(ConflictResponse(current: response(path, existing)))
        }
      case .match(let version):
        guard let existing else { throw DaemonClientError.conflict(ConflictResponse(current: nil)) }
        if existing.version != version {
          throw DaemonClientError.conflict(ConflictResponse(current: response(path, existing)))
        }
      }
      state.versionCounter += 1
      let version = "v\(state.versionCounter)"
      state.landed.append((path, existing?.content, content))
      state.notes[path] = Note(content: content, version: version)
      return WriteNoteResponse(path: path, version: version, mtime: 2_000)
    }
  }

  public func deleteNote(_ path: String) async throws -> TrashResponse {
    _ = try begin("deleteNote", detail: path)
    return try lock.withLock {
      guard state.notes.removeValue(forKey: path) != nil else { throw Self.notFound(path) }
      return TrashResponse(trashedTo: ".trash/\(path)")
    }
  }

  public func rename(from: String, to: String) async throws -> RenameResponse {
    _ = try begin("rename", detail: "\(from)->\(to)")
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
      state.folders = Set(
        state.folders.map {
          $0 == from || $0.hasPrefix("\(from)/") ? "\(to)\($0.dropFirst(from.count))" : $0
        })
      return .folder(FolderRenameResponse(path: to, moved: inside.count))
    }
  }

  public func createFolder(_ path: String) async throws -> CreateFolderResponse {
    _ = try begin("createFolder", detail: path)
    lock.withLock { _ = state.folders.insert(path) }
    return CreateFolderResponse(path: path)
  }

  public func deleteFolder(_ path: String) async throws -> TrashResponse {
    _ = try begin("deleteFolder", detail: path)
    lock.withLock {
      state.folders = state.folders.filter { $0 != path && !$0.hasPrefix("\(path)/") }
      for key in state.notes.keys where key.hasPrefix("\(path)/") { state.notes[key] = nil }
    }
    return TrashResponse(trashedTo: ".trash/\(path)")
  }

  public func dailyNote(_ date: String, create: Bool) async throws -> DailyNoteResponse {
    _ = try begin("dailyNote", detail: date)
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
      return DailyNoteResponse(
        path: path, content: note.content, version: note.version, mtime: 1_000, date: iso,
        created: created)
    }
  }

  public func search(_ query: String, limit: Int?) async throws -> SearchResponse {
    _ = try begin("search", detail: query)
    return lock.withLock {
      var hits: [SearchHit] = []
      for (path, note) in state.notes.sorted(by: { $0.key < $1.key }) {
        if path.localizedCaseInsensitiveContains(query) {
          hits.append(SearchHit(path: path, kind: .name, line: 0, preview: path))
        }
        for (index, line) in note.content.components(separatedBy: "\n").enumerated()
        where line.localizedCaseInsensitiveContains(query) {
          hits.append(SearchHit(path: path, kind: .content, line: index, preview: line))
        }
      }
      return SearchResponse(hits: hits)
    }
  }

  // MARK: - Settings & agent

  public func settings() async throws -> AppSettings {
    _ = try begin("settings")
    return lock.withLock { state.settings }
  }

  public func updateSettings(_ patch: SettingsPatch) async throws -> AppSettings {
    _ = try begin("updateSettings")
    return lock.withLock {
      state.settings = state.settings.applying(patch)
      return state.settings
    }
  }

  public func agentStatus() async throws -> AgentStatusResponse {
    if let scripted = try begin("agentStatus").agentStatus { return try await scripted() }
    return lock.withLock { state.agentStatus }
  }

  public func setAgentEnabled(_ enabled: Bool) async throws -> AgentStatusResponse {
    if let scripted = try begin("setAgentEnabled", detail: "\(enabled)").setAgentEnabled {
      return try await scripted(enabled)
    }
    return lock.withLock {
      state.agentStatus.enabled = enabled
      return state.agentStatus
    }
  }

  public func connectors() async throws -> [ConnectorStatus] {
    _ = try begin("connectors")
    return [ConnectorStatus(name: "calendar", transport: .stdio, state: .connected, toolCount: 4)]
  }

  public func taskRecords(notePath: String) async throws -> [TaskAgentRecord] {
    if let scripted = try begin("taskRecords", detail: notePath).taskRecords {
      return try await scripted(notePath)
    }
    return lock.withLock { state.records[notePath] ?? [] }
  }

  public func threads(notePath: String?, taskId: String?) async throws -> [ThreadSummary] {
    try await begin("threads", detail: notePath ?? "*").threads?(notePath, taskId) ?? []
  }

  public func thread(_ id: String) async throws -> ThreadResponse {
    guard let scripted = try begin("thread", detail: id).thread else { throw Self.notFound(id) }
    return try await scripted(id)
  }

  public func postMessage(threadId: String, text: String) async throws -> ThreadActionResponse {
    try await begin("postMessage", detail: threadId).postMessage?(threadId, text)
      ?? ThreadActionResponse()
  }

  public func cancelThread(_ id: String) async throws -> ThreadActionResponse {
    try await begin("cancelThread", detail: id).cancelThread?(id) ?? ThreadActionResponse()
  }

  public func retryThread(_ id: String) async throws -> ThreadActionResponse {
    try await begin("retryThread", detail: id).retryThread?(id) ?? ThreadActionResponse()
  }

  public func approvals(status: ApprovalStatus?) async throws -> [ApprovalRequest] {
    try await begin("approvals", detail: status?.rawValue ?? "*").approvals?(status) ?? []
  }

  public func decideApproval(_ id: String, _ decision: ApprovalDecisionRequest) async throws
    -> ApprovalRequest
  {
    let detail = "\(id):\(decision.decision.rawValue):\(decision.scope?.rawValue ?? "-")"
    guard let scripted = try begin("decideApproval", detail: detail).decideApproval else {
      throw Self.notFound(id)
    }
    return try await scripted(id, decision)
  }

  public func artifact(threadId: String, artifactId: String) async throws -> ArtifactPayload {
    try await begin("artifact", detail: "\(threadId)/\(artifactId)").artifact?(threadId, artifactId)
      ?? ArtifactPayload(data: Data("# Artifact".utf8), mimeType: "text/markdown")
  }

  // MARK: - Routines

  public func routines() async throws -> RoutineListResponse {
    if let scripted = try begin("routines").routines { return try await scripted() }
    return lock.withLock {
      RoutineListResponse(routines: state.routines, templates: state.routineTemplates)
    }
  }

  public func routine(_ id: String) async throws -> Routine {
    guard let routine = try await routines().routines.first(where: { $0.id == id }) else {
      throw Self.notFound(id)
    }
    return routine
  }

  public func createRoutine(_ request: CreateRoutineRequest) async throws -> Routine {
    if let scripted = try begin("createRoutine", detail: request.name).createRoutine {
      return try await scripted(request)
    }
    return lock.withLock {
      let routine = Routine(
        id: "rtn_\(state.routines.count + 1)", path: "Routines/\(request.name).md",
        name: request.name, schedule: request.schedule, notify: request.notify ?? .always,
        uses: request.uses ?? [], instructions: request.instructions)
      state.routines.append(routine)
      return routine
    }
  }

  public func runRoutine(_ id: String) async throws -> RoutineRunResponse {
    if let scripted = try begin("runRoutine", detail: id).runRoutine {
      return try await scripted(id)
    }
    return try lock.withLock {
      guard let index = state.routines.firstIndex(where: { $0.id == id }) else {
        throw Self.notFound(id)
      }
      let threadId = "thr_run_\(state.routines[index].runCount + 1)"
      state.routines[index].runCount += 1
      state.routines[index].lastRun = RoutineRun(
        threadId: threadId, trigger: .manual, status: .working, startedAt: 1_000)
      return RoutineRunResponse(routine: state.routines[index], threadId: threadId)
    }
  }

  public func pauseRoutine(_ id: String) async throws -> Routine { try await setPaused(id, true) }
  public func resumeRoutine(_ id: String) async throws -> Routine { try await setPaused(id, false) }

  private func setPaused(_ id: String, _ paused: Bool) async throws -> Routine {
    let script = try begin(paused ? "pauseRoutine" : "resumeRoutine", detail: id)
    if let scripted = script.pauseRoutine { return try await scripted(id, paused) }
    return try lock.withLock {
      guard let index = state.routines.firstIndex(where: { $0.id == id }) else {
        throw Self.notFound(id)
      }
      state.routines[index].paused = paused
      return state.routines[index]
    }
  }

  public func threads(routineId: String) async throws -> [ThreadSummary] {
    if let scripted = try begin("threads", detail: "routine:\(routineId)").routineRuns {
      return try await scripted(routineId)
    }
    return lock.withLock { state.routineRuns[routineId] ?? [] }
  }

  // MARK: - This device, pairing, the always-on machine, the vault and importing from Obsidian

  public func syncStatus() async throws -> SyncStatusResponse {
    try await served(APIRoute.syncStatus, \.syncStatus)
  }

  public func deviceSettings() async throws -> DeviceSettingsResponse {
    try await served(APIRoute.device, \.deviceSettings)
  }

  public func updateDeviceSettings(_ patch: DeviceSettingsPatch) async throws
    -> DeviceSettingsResponse
  {
    try await served(
      APIRoute.device, \.updateDeviceSettings, patch, detail: patch.placement?.rawValue ?? "-")
  }

  public func setUpSync(_ request: DeviceSyncSetupRequest) async throws -> DeviceSettingsResponse {
    try await served(APIRoute.deviceSync, \.setUpSync, request)
  }

  public func turnOffSync() async throws -> DeviceSettingsResponse {
    try await served(APIRoute.deviceSync, \.turnOffSync)
  }

  public func createPairingCode(_ request: PairingCodeRequest) async throws -> PairingCodeResponse {
    try await served(APIRoute.pairingCodes, \.createPairingCode, request)
  }

  public func pairedDevices() async throws -> [PairedDevice] {
    try await served(APIRoute.devices, \.pairedDevices)
  }

  public func revokeDevice(_ id: String) async throws {
    try await served(APIRoute.devices, \.revokeDevice, id, detail: id)
  }

  public func machineStatus() async throws -> MachineStatusResponse {
    try await served(APIRoute.machine, \.machineStatus)
  }

  public func pairMachine(_ request: MachinePairRequest) async throws -> MachineStatusResponse {
    try await served(APIRoute.machinePair, \.pairMachine, request)
  }

  public func checkMachine() async throws -> MachineStatusResponse {
    try await served(APIRoute.machineCheck, \.checkMachine)
  }

  public func forgetMachine() async throws -> MachineStatusResponse {
    try await served(APIRoute.machinePairing, \.forgetMachine)
  }

  public func deviceVault() async throws -> DeviceVaultResponse {
    try await served(APIRoute.deviceVault, \.deviceVault)
  }

  public func switchVault(_ request: DeviceVaultRequest) async throws -> DeviceVaultResponse {
    try await served(APIRoute.deviceVault, \.switchVault, request, detail: request.path)
  }

  public func previewObsidianImport(_ request: ObsidianImportPreviewRequest) async throws
    -> ObsidianImportPreview
  {
    try await served(APIRoute.importObsidianPreview, \.previewObsidianImport, request)
  }

  public func obsidianImportStatus() async throws -> ObsidianImportStatusResponse {
    try await served(APIRoute.importObsidian, \.obsidianImportStatus)
  }

  public func startObsidianImport(_ request: ObsidianImportRequest) async throws
    -> ObsidianImportJob
  {
    try await served(APIRoute.importObsidian, \.startObsidianImport, request)
  }

  public func cancelObsidianImport() async throws -> ObsidianImportJob {
    try await served(APIRoute.importObsidianCancel, \.cancelObsidianImport)
  }

  public func updateFromObsidian() async throws -> ObsidianImportJob {
    try await served(APIRoute.importObsidianUpdate, \.updateFromObsidian)
  }

  /// The scripted answer (logged as the calling method), or what a daemon without `route` answers.
  private func served<Answer>(
    _ route: String, _ answer: KeyPath<Script, (@Sendable () async throws -> Answer)?>,
    method: String = #function
  ) async throws -> Answer {
    guard let scripted = try begin(Self.name(method))[keyPath: answer] else {
      throw Self.notServed(route)
    }
    return try await scripted()
  }

  private func served<Argument, Answer>(
    _ route: String, _ answer: KeyPath<Script, (@Sendable (Argument) async throws -> Answer)?>,
    _ argument: Argument, detail: String? = nil, method: String = #function
  ) async throws -> Answer {
    guard let scripted = try begin(Self.name(method), detail: detail)[keyPath: answer] else {
      throw Self.notServed(route)
    }
    return try await scripted(argument)
  }

  /// `deviceVault()` → `deviceVault`.
  private static func name(_ method: String) -> String { String(method.prefix { $0 != "(" }) }

  // MARK: - Events

  public func connect() async {
    lock.withLock { state.calls.append("connect") }
    setConnection(.connecting)
    setConnection(.connected(serverVersion: "0.1.0-test"))
  }

  /// Like the real client: reports `.disconnected`, then finishes every event stream.
  public func disconnect() async {
    lock.withLock { state.calls.append("disconnect") }
    setConnection(.disconnected)
    let finished = lock.withLock { () -> [AsyncStream<DaemonStreamItem>.Continuation] in
      defer { subscribers = [:] }
      return Array(subscribers.values)
    }
    for continuation in finished { continuation.finish() }
  }

  public func setConnection(_ connection: ConnectionState) {
    lock.withLock { state.connectionState = connection }
    emit(.state(connection))
  }

  public func events() -> AsyncStream<DaemonStreamItem> {
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

  public func send(_ event: ClientEvent) async {
    lock.withLock { state.sent.append(event) }
  }
}
