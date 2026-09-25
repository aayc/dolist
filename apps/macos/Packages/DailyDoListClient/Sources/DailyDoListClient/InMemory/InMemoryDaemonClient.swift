import DailyDoListModels
import Foundation

/// A faithful fake daemon in memory, for tests, SwiftUI previews and the app's demo mode.
///
/// It answers every `DaemonClient` call with the daemon's semantics (paths, versions and
/// `baseVersion` conflicts, soft deletes into `.trash/`, daily notes from the template, search,
/// validated settings, 4xx errors as `DaemonClientError`) and runs a simulated agent: a new open
/// task in a watched daily note gets a record, a thread with streamed messages, tool calls, a
/// markdown artifact and, for risky verbs (buy, order, book, reserve, email, send, pay), an
/// approval that waits for `decideApproval`. Everything is announced through `events()` while
/// connected, exactly like the real WebSocket.
///
/// With a `.manual` or `.immediate` clock, runs are deterministic (ids, timestamps, event order).
public final class InMemoryDaemonClient: DaemonClient {
  public let clientId: String
  let daemon: FakeDaemon

  /// - Parameters:
  ///   - seed: Initial vault (`.demo` by default).
  ///   - clock: `.realTime()` (default) paces the agent like the web demo; tests use `.immediate()`
  ///     or `.manual()`, which start at a fixed date in UTC.
  ///   - agent: Whether the agent simulation runs.
  ///   - clientId: Echoed on `vault.changed` events caused by this client's writes.
  ///   - remote: Sync, the always-on machine and placement at start (`.standalone`: neither, so
  ///     the agent is held on this device).
  public init(
    seed: Seed = .demo,
    clock: SimulationClock = .realTime(),
    agent: AgentSimulation = .enabled,
    clientId: String = "demo_client",
    remote: Remote = .standalone
  ) {
    self.clientId = clientId
    daemon = FakeDaemon(
      seed: seed, clock: clock, simulation: agent, clientId: clientId, remote: remote)
  }

  deinit {
    let daemon = daemon
    Task { await daemon.stop() }
  }

  private func call<T: Sendable>(
    _ body: @Sendable (isolated FakeDaemon) throws(DaemonClientError) -> T
  ) async throws -> T {
    if Task.isCancelled { throw DaemonClientError.cancelled }
    return try await daemon.perform(body)
  }

  // MARK: - Vault

  public func health() async throws -> HealthResponse { try await call { $0.health() } }
  public func tree() async throws -> VaultTreeResponse { try await call { $0.tree() } }

  public func readNote(_ path: String) async throws -> NoteResponse {
    try await call { daemon throws(DaemonClientError) in try daemon.readNote(path) }
  }

  public func writeNote(_ path: String, content: String, baseVersion: BaseVersion) async throws
    -> WriteNoteResponse
  {
    try await call { daemon throws(DaemonClientError) in
      try daemon.writeNote(path, content: content, baseVersion: baseVersion)
    }
  }

  public func deleteNote(_ path: String) async throws -> TrashResponse {
    try await call { daemon throws(DaemonClientError) in try daemon.deleteNote(path) }
  }

  public func rename(from: String, to: String) async throws -> RenameResponse {
    try await call { daemon throws(DaemonClientError) in try daemon.rename(from: from, to: to) }
  }

  public func createFolder(_ path: String) async throws -> CreateFolderResponse {
    try await call { daemon throws(DaemonClientError) in try daemon.createFolder(path) }
  }

  public func deleteFolder(_ path: String) async throws -> TrashResponse {
    try await call { daemon throws(DaemonClientError) in try daemon.deleteFolder(path) }
  }

  public func dailyNote(_ date: String, create: Bool) async throws -> DailyNoteResponse {
    try await call { daemon throws(DaemonClientError) in try daemon.dailyNote(date, create: create)
    }
  }

  public func search(_ query: String, limit: Int?) async throws -> SearchResponse {
    try await call { daemon throws(DaemonClientError) in try daemon.search(query, limit: limit) }
  }

  // MARK: - Settings & agent

  public func settings() async throws -> AppSettings { try await call { $0.settings } }

  public func updateSettings(_ patch: SettingsPatch) async throws -> AppSettings {
    try await call { daemon throws(DaemonClientError) in try daemon.updateSettings(patch) }
  }

  public func agentStatus() async throws -> AgentStatusResponse { try await call { $0.status() } }

  public func setAgentEnabled(_ enabled: Bool) async throws -> AgentStatusResponse {
    try await call { daemon throws(DaemonClientError) in try daemon.setAgentEnabled(enabled) }
  }

  public func connectors() async throws -> [ConnectorStatus] {
    try await call { $0.status().connectors }
  }

  public func taskRecords(notePath: String) async throws -> [TaskAgentRecord] {
    try await call { daemon throws(DaemonClientError) in try daemon.taskRecords(notePath: notePath)
    }
  }

  public func threads(notePath: String?, taskId: String?) async throws -> [ThreadSummary] {
    try await call { daemon throws(DaemonClientError) in
      try daemon.threadList(notePath: notePath, taskId: taskId)
    }
  }

  public func thread(_ id: String) async throws -> ThreadResponse {
    try await call { daemon throws(DaemonClientError) in try daemon.thread(id) }
  }

  public func postMessage(threadId: String, text: String) async throws -> ThreadActionResponse {
    try await call { daemon throws(DaemonClientError) in
      try daemon.postMessage(threadId: threadId, text: text)
    }
  }

  public func cancelThread(_ id: String) async throws -> ThreadActionResponse {
    try await call { daemon throws(DaemonClientError) in try daemon.cancelThread(id) }
  }

  public func retryThread(_ id: String) async throws -> ThreadActionResponse {
    try await call { daemon throws(DaemonClientError) in try daemon.retryThread(id) }
  }

  public func approvals(status: ApprovalStatus?) async throws -> [ApprovalRequest] {
    try await call { $0.approvalList(status: status) }
  }

  public func decideApproval(_ id: String, _ decision: ApprovalDecisionRequest) async throws
    -> ApprovalRequest
  {
    try await call { daemon throws(DaemonClientError) in try daemon.decideApproval(id, decision) }
  }

  public func artifact(threadId: String, artifactId: String) async throws -> ArtifactPayload {
    try await call { daemon throws(DaemonClientError) in
      try daemon.artifact(threadId: threadId, artifactId: artifactId)
    }
  }

  // MARK: - Routines

  public func routines() async throws -> RoutineListResponse {
    try await call {
      RoutineListResponse(routines: $0.routineList(), templates: FakeDaemon.templates)
    }
  }

  public func routine(_ id: String) async throws -> Routine {
    try await call { daemon throws(DaemonClientError) in try daemon.routineResponse(id) }
  }

  public func createRoutine(_ request: CreateRoutineRequest) async throws -> Routine {
    try await call { daemon throws(DaemonClientError) in try daemon.createRoutine(request) }
  }

  public func runRoutine(_ id: String) async throws -> RoutineRunResponse {
    try await call { daemon throws(DaemonClientError) in try daemon.runRoutine(id) }
  }

  public func pauseRoutine(_ id: String) async throws -> Routine {
    try await call { daemon throws(DaemonClientError) in try daemon.setRoutinePaused(id, true) }
  }

  public func resumeRoutine(_ id: String) async throws -> Routine {
    try await call { daemon throws(DaemonClientError) in try daemon.setRoutinePaused(id, false) }
  }

  public func threads(routineId: String) async throws -> [ThreadSummary] {
    try await call { $0.routineRuns(routineId) }
  }

  // MARK: - This device, pairing and the always-on machine

  public func syncStatus() async throws -> SyncStatusResponse {
    try await call { $0.syncStatus() }
  }

  public func deviceSettings() async throws -> DeviceSettingsResponse {
    try await call { $0.deviceSettings() }
  }

  public func updateDeviceSettings(_ patch: DeviceSettingsPatch) async throws
    -> DeviceSettingsResponse
  {
    try await call { daemon throws(DaemonClientError) in try daemon.updateDeviceSettings(patch) }
  }

  public func setUpSync(_ request: DeviceSyncSetupRequest) async throws -> DeviceSettingsResponse {
    try await call { daemon throws(DaemonClientError) in try daemon.setUpSync(request) }
  }

  public func turnOffSync() async throws -> DeviceSettingsResponse {
    try await call { daemon throws(DaemonClientError) in try daemon.turnOffSync() }
  }

  public func createPairingCode(_ request: PairingCodeRequest) async throws -> PairingCodeResponse {
    try await call { daemon throws(DaemonClientError) in try daemon.createPairingCode(request) }
  }

  public func pair(_ request: PairRequest) async throws -> PairResponse {
    try await call { daemon throws(DaemonClientError) in try daemon.pair(request) }
  }

  public func pairedDevices() async throws -> [PairedDevice] {
    try await call { $0.pairedDevices() }
  }

  public func revokeDevice(_ id: String) async throws {
    try await call { daemon throws(DaemonClientError) in try daemon.revokeDevice(id) }
  }

  public func machineStatus() async throws -> MachineStatusResponse {
    try await call { $0.machineStatus() }
  }

  public func pairMachine(_ request: MachinePairRequest) async throws -> MachineStatusResponse {
    try await call { daemon throws(DaemonClientError) in try daemon.pairMachine(request) }
  }

  public func checkMachine() async throws -> MachineStatusResponse {
    try await call { $0.checkMachine() }
  }

  public func forgetMachine() async throws -> MachineStatusResponse {
    try await call { $0.forgetMachine() }
  }

  // MARK: - This machine's vault and importing from Obsidian

  public func deviceVault() async throws -> DeviceVaultResponse {
    try await call { daemon throws(DaemonClientError) in try daemon.deviceVault() }
  }

  public func switchVault(_ request: DeviceVaultRequest) async throws -> DeviceVaultResponse {
    try await call { daemon throws(DaemonClientError) in try daemon.switchVault(request) }
  }

  public func previewObsidianImport(_ request: ObsidianImportPreviewRequest) async throws
    -> ObsidianImportPreview
  {
    try await call { daemon throws(DaemonClientError) in try daemon.previewObsidianImport(request) }
  }

  public func obsidianImportStatus() async throws -> ObsidianImportStatusResponse {
    try await call { daemon throws(DaemonClientError) in try daemon.obsidianImportStatus() }
  }

  public func startObsidianImport(_ request: ObsidianImportRequest) async throws
    -> ObsidianImportJob
  {
    try await call { daemon throws(DaemonClientError) in try daemon.startObsidianImport(request) }
  }

  public func cancelObsidianImport() async throws -> ObsidianImportJob {
    try await call { daemon throws(DaemonClientError) in try daemon.cancelObsidianImport() }
  }

  public func updateFromObsidian() async throws -> ObsidianImportJob {
    try await call { daemon throws(DaemonClientError) in try daemon.updateFromObsidian() }
  }

  // MARK: - Events

  /// Emits `.connecting`, `.connected`, the `hello` event, and `.resync` when reconnecting.
  public func connect() async { _ = try? await call { $0.connect() } }

  public func disconnect() async { _ = try? await call { $0.disconnect() } }

  public func events() -> AsyncStream<DaemonStreamItem> { daemon.broadcaster.stream() }

  public func send(_ event: ClientEvent) async { _ = try? await call { $0.receive(event) } }

  /// The connection state as of now.
  public var connectionState: ConnectionState { daemon.broadcaster.currentState }

  // MARK: - Simulation controls

  /// Moves virtual time forward, running everything that falls due (`.manual` clocks).
  public func advance(by duration: Duration) async {
    _ = try? await call { $0.advance(by: duration.seconds * 1000) }
  }

  /// Runs every scheduled action, however far in the future (the agent then waits only on
  /// approvals).
  public func runUntilIdle() async { _ = try? await call { $0.runUntilIdle() } }

  /// Number of scheduled actions that haven't run yet.
  public var pendingActions: Int {
    get async { (try? await call { $0.pendingActionCount }) ?? 0 }
  }

  /// The fake's current (virtual) time.
  public var now: Date {
    get async { (try? await call { $0.now }) ?? Date() }
  }

  /// Changes the vault as another program (e.g. Obsidian) would: `vault.changed` with origin
  /// `external`; `nil` content deletes the file.
  public func simulateExternalEdit(_ path: String, content: String?) async throws {
    try await call { daemon throws(DaemonClientError) in
      try daemon.simulateExternalEdit(path, content: content)
    }
  }

  /// The always-on machine stops (or starts) answering, refuses every pairing code, or no longer
  /// accepts this device (it was revoked there; pairing again fixes it). A change of what the
  /// relay reports is announced with `agent.status`.
  public func simulateMachine(
    reachable: Bool? = nil, rejectsCodes: Bool? = nil, acceptsThisDevice: Bool? = nil
  ) async {
    _ = try? await call {
      $0.simulateMachine(
        reachable: reachable, rejectsCodes: rejectsCodes, acceptsThisDevice: acceptsThisDevice)
    }
  }

  /// This client is a paired device (the import and vault routes answer 403), or `DDL_VAULT`
  /// fixes the vault (switching answers 409 `locked_by_env`); `nil` leaves a setting as it is.
  public func simulateImportSettings(pairedDevice: Bool? = nil, lockedByEnv: Bool? = nil) async {
    _ = try? await call {
      $0.simulateImportSetting(pairedDevice: pairedDevice, lockedByEnv: lockedByEnv)
    }
  }

  /// Another device set to run the agent itself holds it (`nil`: it lets go), announced with
  /// `agent.status`.
  public func simulateAgentElsewhere(_ deviceName: String?) async {
    _ = try? await call { $0.simulateAgentElsewhere(deviceName) }
  }
}

extension InMemoryDaemonClient {
  /// Initial vault content of an `InMemoryDaemonClient`.
  public struct Seed: Sendable {
    enum Content: Sendable {
      case demo
      case files([String: String])
    }

    let content: Content
    public let vaultName: String

    /// Today's daily note from the `- [ ] ` template with two tasks the agent already finished,
    /// previous days (with a gap) with done tasks and their threads, `Templates/Daily.md`,
    /// `Projects/…`, `Ideas.md` and `Welcome.md`.
    public static let demo = Seed(content: .demo, vaultName: "Demo Vault")

    /// No notes, no folders.
    public static let empty = Seed(content: .files([:]), vaultName: "Empty Vault")

    /// Exactly these notes (path → content). Tasks already in them are not acted on.
    public static func files(_ files: [String: String], vaultName: String = "Test Vault") -> Seed {
      Seed(content: .files(files), vaultName: vaultName)
    }
  }
}
