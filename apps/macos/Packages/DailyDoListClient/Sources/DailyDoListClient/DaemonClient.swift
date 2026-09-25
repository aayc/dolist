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

  // This device, pairing and the always-on machine (a daemon without these routes answers 404,
  // which is what the default implementations throw)
  /// The vault's sync state (and, with the sync service, this device's name there).
  func syncStatus() async throws -> SyncStatusResponse
  /// This daemon's device-local settings: its name, placement, remote hosts and sync setup.
  func deviceSettings() async throws -> DeviceSettingsResponse
  /// Changes device settings live. Throws `.http(status: 400, …)` for a value the daemon refuses
  /// and `.http(status: 409, …)` (`locked_by_env`) for a field an environment variable sets.
  func updateDeviceSettings(_ patch: DeviceSettingsPatch) async throws -> DeviceSettingsResponse
  /// Points this device at the sync service; a nil `token` keeps the saved one. 400 for an
  /// address, vault or token it refuses, 409 `locked_by_env`.
  func setUpSync(_ request: DeviceSyncSetupRequest) async throws -> DeviceSettingsResponse
  /// Stops syncing with the sync service and removes the saved token. 409 `locked_by_env`.
  func turnOffSync() async throws -> DeviceSettingsResponse
  /// A single-use pairing code for a new device. 429 `rate_limited` with too many outstanding.
  func createPairingCode(_ request: PairingCodeRequest) async throws -> PairingCodeResponse
  /// Exchanges a pairing code for a device credential, without sending the token (the code is
  /// the credential). Throws `.pairingRejected` for a wrong, expired or used code, and
  /// `.http(status: 429, …)` after too many attempts.
  func pair(_ request: PairRequest) async throws -> PairResponse
  /// The devices paired with this daemon.
  func pairedDevices() async throws -> [PairedDevice]
  /// Revokes a paired device: its credential stops working and its sockets close. 404 for an
  /// unknown device.
  func revokeDevice(_ id: String) async throws
  /// The always-on machine from this device's side: its address, this device's pairing, and
  /// what the machine last reported.
  func machineStatus() async throws -> MachineStatusResponse
  /// Pairs this device with the always-on machine using a code the machine issued, and makes it
  /// the vault's always-on machine. Throws `.pairingRejected` when the machine refuses the code,
  /// 429 `rate_limited`, 502 `machine_unreachable`.
  func pairMachine(_ request: MachinePairRequest) async throws -> MachineStatusResponse
  /// Checks the always-on machine now (reachability, version, agent, readiness).
  func checkMachine() async throws -> MachineStatusResponse
  /// Forgets this device's credential for the always-on machine (revoked there when it answers).
  func forgetMachine() async throws -> MachineStatusResponse

  // This machine's vault and importing from Obsidian (a paired device gets 403
  // `forbidden_device`; a daemon without these routes answers 404)
  /// The vault the daemon opens, and whether `DDL_VAULT` fixes it.
  func deviceVault() async throws -> DeviceVaultResponse
  /// Restarts the daemon on another vault (`restart` says who starts it again; none: already that
  /// vault). 409 `locked_by_env`, or `conflict` while an import runs or the vault syncs.
  func switchVault(_ request: DeviceVaultRequest) async throws -> DeviceVaultResponse
  /// What importing a folder would do; reads it, writes nothing. 400 for a folder it can't use.
  func previewObsidianImport(_ request: ObsidianImportPreviewRequest) async throws
    -> ObsidianImportPreview
  /// The running or last job, and where this vault was imported from.
  func obsidianImportStatus() async throws -> ObsidianImportStatusResponse
  /// Starts an import; `importProgress` events follow. 400 for a bad source or destination, 409
  /// while a job runs.
  func startObsidianImport(_ request: ObsidianImportRequest) async throws -> ObsidianImportJob
  /// Stops the running job once its partial work is removed. 404 when nothing runs.
  func cancelObsidianImport() async throws -> ObsidianImportJob
  /// Copies what changed in Obsidian since the import. 404 when this vault wasn't imported or the
  /// Obsidian vault moved, 409 while a job runs.
  func updateFromObsidian() async throws -> ObsidianImportJob

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

extension DaemonClient {
  public func syncStatus() async throws -> SyncStatusResponse {
    throw notServed(APIRoute.syncStatus)
  }

  public func deviceSettings() async throws -> DeviceSettingsResponse {
    throw notServed(APIRoute.device)
  }

  public func updateDeviceSettings(_ patch: DeviceSettingsPatch) async throws
    -> DeviceSettingsResponse
  {
    throw notServed(APIRoute.device)
  }

  public func setUpSync(_ request: DeviceSyncSetupRequest) async throws -> DeviceSettingsResponse {
    throw notServed(APIRoute.deviceSync)
  }

  public func turnOffSync() async throws -> DeviceSettingsResponse {
    throw notServed(APIRoute.deviceSync)
  }

  public func createPairingCode(_ request: PairingCodeRequest) async throws -> PairingCodeResponse {
    throw notServed(APIRoute.pairingCodes)
  }

  public func pair(_ request: PairRequest) async throws -> PairResponse {
    throw notServed(APIRoute.pair)
  }

  public func pairedDevices() async throws -> [PairedDevice] { throw notServed(APIRoute.devices) }

  public func revokeDevice(_ id: String) async throws { throw notServed(APIRoute.devices) }

  public func machineStatus() async throws -> MachineStatusResponse {
    throw notServed(APIRoute.machine)
  }

  public func pairMachine(_ request: MachinePairRequest) async throws -> MachineStatusResponse {
    throw notServed(APIRoute.machinePair)
  }

  public func checkMachine() async throws -> MachineStatusResponse {
    throw notServed(APIRoute.machineCheck)
  }

  public func forgetMachine() async throws -> MachineStatusResponse {
    throw notServed(APIRoute.machinePairing)
  }

  public func deviceVault() async throws -> DeviceVaultResponse {
    throw notServed(APIRoute.deviceVault)
  }

  public func switchVault(_ request: DeviceVaultRequest) async throws -> DeviceVaultResponse {
    throw notServed(APIRoute.deviceVault)
  }

  public func previewObsidianImport(_ request: ObsidianImportPreviewRequest) async throws
    -> ObsidianImportPreview
  {
    throw notServed(APIRoute.importObsidianPreview)
  }

  public func obsidianImportStatus() async throws -> ObsidianImportStatusResponse {
    throw notServed(APIRoute.importObsidian)
  }

  public func startObsidianImport(_ request: ObsidianImportRequest) async throws
    -> ObsidianImportJob
  {
    throw notServed(APIRoute.importObsidian)
  }

  public func cancelObsidianImport() async throws -> ObsidianImportJob {
    throw notServed(APIRoute.importObsidianCancel)
  }

  public func updateFromObsidian() async throws -> ObsidianImportJob {
    throw notServed(APIRoute.importObsidianUpdate)
  }

  private func notServed(_ route: String) -> DaemonClientError {
    .notFound("This daemon doesn't serve \(route).")
  }
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
