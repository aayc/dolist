import Foundation

/// Swift mirror of `packages/core/src/protocol.ts` (REST shapes). The canonical, versioned
/// contract is `@ddl/contract`; the Swift tests decode its fixtures to stay in lockstep.
public enum DaemonProtocol {
  /// Major protocol version. A client and a daemon interoperate exactly when these are equal.
  public static let apiVersion = 1
  /// Header clients send so the daemon can tag the origin of a change.
  public static let clientIdHeader = "x-ddl-client-id"
  /// WebSocket close code: the client's `hello.apiVersion` is incompatible.
  public static let incompatibleApiVersionCloseCode = 4426

  public static func isCompatible(apiVersion: Int) -> Bool { apiVersion == Self.apiVersion }
}

// MARK: - Routes

/// Paths of every daemon route (see `API_ROUTES` in protocol.ts).
public enum APIRoute {
  public static let health = "/api/health"
  public static let tree = "/api/vault/tree"
  public static let rename = "/api/notes-rename"
  public static let folders = "/api/folders"
  public static let settings = "/api/settings"
  public static let agentStatus = "/api/agent/status"
  public static let agentEnabled = "/api/agent/enabled"
  public static let threads = "/api/threads"
  public static let approvals = "/api/approvals"
  public static let connectors = "/api/connectors"
  public static let syncStatus = "/api/sync/status"
  /// POST `ComputerPermissionsOpenRequest`: opens System Settings at that privacy pane.
  public static let computerPermissionsOpen = "/api/computer/permissions/open"
  public static let webSocket = "/ws"

  public static func note(_ path: String) -> String { "/api/notes/\(encodeVaultPath(path))" }

  /// `date` is `today` or `YYYY-MM-DD`.
  public static func daily(_ date: String, create: Bool = true) -> String {
    "/api/daily/\(encodeURIComponent(date))\(create ? "?create=1" : "")"
  }

  public static func search(_ query: String, limit: Int? = nil) -> String {
    var path = "/api/search?q=\(encodeURIComponent(query))"
    if let limit { path += "&limit=\(limit)" }
    return path
  }

  public static func tasks(notePath: String) -> String {
    "/api/tasks?notePath=\(encodeURIComponent(notePath))"
  }

  public static func threads(notePath: String? = nil, taskId: String? = nil) -> String {
    var query: [String] = []
    if let notePath { query.append("notePath=\(encodeURIComponent(notePath))") }
    if let taskId { query.append("taskId=\(encodeURIComponent(taskId))") }
    return query.isEmpty ? threads : "\(threads)?\(query.joined(separator: "&"))"
  }

  public static func thread(_ id: String) -> String { "/api/threads/\(encodeURIComponent(id))" }
  public static func threadMessages(_ id: String) -> String { "\(thread(id))/messages" }
  public static func threadCancel(_ id: String) -> String { "\(thread(id))/cancel" }
  public static func threadRetry(_ id: String) -> String { "\(thread(id))/retry" }

  public static func approvals(status: ApprovalStatus?) -> String {
    guard let status else { return approvals }
    return "\(approvals)?status=\(encodeURIComponent(status.rawValue))"
  }

  public static func approval(_ id: String) -> String {
    "/api/approvals/\(encodeURIComponent(id))"
  }

  public static func artifact(threadId: String, artifactId: String, download: Bool = false)
    -> String
  {
    let base = "/api/artifacts/\(encodeURIComponent(threadId))/\(encodeURIComponent(artifactId))"
    return download ? "\(base)?download=1" : base
  }

  public static func deleteFolder(_ path: String) -> String {
    "\(folders)?path=\(encodeURIComponent(path))"
  }

  /// Encodes each vault path segment but keeps `/` separators (same as `encodeVaultPath`).
  public static func encodeVaultPath(_ path: String) -> String {
    path.split(separator: "/", omittingEmptySubsequences: false)
      .map { encodeURIComponent(String($0)) }
      .joined(separator: "/")
  }

  /// JavaScript `encodeURIComponent`: everything except `A-Z a-z 0-9 - _ . ! ~ * ' ( )`.
  public static func encodeURIComponent(_ value: String) -> String {
    value.addingPercentEncoding(withAllowedCharacters: uriComponentAllowed) ?? value
  }

  private static let uriComponentAllowed: CharacterSet = {
    var set = CharacterSet()
    set.insert(
      charactersIn: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_.!~*'()")
    return set
  }()
}

// MARK: - REST shapes

public struct AgentMode: WireEnum {
  public let rawValue: String
  public init(rawValue: String) { self.rawValue = rawValue }
  public static let live: Self = "live"
  public static let mock: Self = "mock"
  public static let off: Self = "off"
}

public struct HealthResponse: Codable, Hashable, Sendable {
  public var ok: Bool
  public var version: String
  public var apiVersion: Int
  public var vaultName: String
  public var agentMode: AgentMode

  public init(
    ok: Bool = true, version: String, apiVersion: Int, vaultName: String, agentMode: AgentMode
  ) {
    self.ok = ok
    self.version = version
    self.apiVersion = apiVersion
    self.vaultName = vaultName
    self.agentMode = agentMode
  }
}

public enum VaultEntryKind: String, Codable, Hashable, Sendable {
  case file, folder
}

public struct VaultEntry: Codable, Hashable, Sendable, Identifiable {
  public var path: String
  public var kind: VaultEntryKind
  public var size: Int?
  public var mtime: EpochMillis?
  public var version: String?

  public var id: String { path }

  public init(
    path: String, kind: VaultEntryKind, size: Int? = nil, mtime: EpochMillis? = nil,
    version: String? = nil
  ) {
    self.path = path
    self.kind = kind
    self.size = size
    self.mtime = mtime
    self.version = version
  }
}

public struct VaultTreeResponse: Codable, Hashable, Sendable {
  public var vaultName: String
  public var entries: [VaultEntry]

  public init(vaultName: String, entries: [VaultEntry]) {
    self.vaultName = vaultName
    self.entries = entries
  }
}

public struct NoteResponse: Codable, Hashable, Sendable {
  public var path: String
  public var content: String
  /// Opaque content version. Send back as `baseVersion` for optimistic concurrency.
  public var version: String
  public var mtime: EpochMillis

  public init(path: String, content: String, version: String, mtime: EpochMillis) {
    self.path = path
    self.content = content
    self.version = version
    self.mtime = mtime
  }
}

/// `baseVersion` semantics of a note write.
public enum BaseVersion: Hashable, Sendable {
  /// Overwrite whatever is there (omit `baseVersion`).
  case unconditional
  /// Create only; fails with 409 if the note exists (`baseVersion: null`).
  case createOnly
  /// Only if the note is still at this version.
  case match(String)
}

public struct WriteNoteRequest: Codable, Hashable, Sendable {
  public var content: String
  public var baseVersion: BaseVersion

  public init(content: String, baseVersion: BaseVersion) {
    self.content = content
    self.baseVersion = baseVersion
  }

  enum CodingKeys: String, CodingKey { case content, baseVersion }

  /// Absent `baseVersion` → `.unconditional`, `null` → `.createOnly`, a string → `.match`.
  public init(from decoder: Decoder) throws {
    let c = try decoder.container(keyedBy: CodingKeys.self)
    content = try c.decode(String.self, forKey: .content)
    if !c.contains(.baseVersion) {
      baseVersion = .unconditional
    } else if try c.decodeNil(forKey: .baseVersion) {
      baseVersion = .createOnly
    } else {
      baseVersion = .match(try c.decode(String.self, forKey: .baseVersion))
    }
  }

  public func encode(to encoder: Encoder) throws {
    var c = encoder.container(keyedBy: CodingKeys.self)
    try c.encode(content, forKey: .content)
    switch baseVersion {
    case .unconditional: break
    case .createOnly: try c.encodeNil(forKey: .baseVersion)
    case .match(let version): try c.encode(version, forKey: .baseVersion)
    }
  }
}

public struct WriteNoteResponse: Codable, Hashable, Sendable {
  public var path: String
  public var version: String
  public var mtime: EpochMillis

  public init(path: String, version: String, mtime: EpochMillis) {
    self.path = path
    self.version = version
    self.mtime = mtime
  }
}

/// Renames a note, or a folder (moving everything inside it) when `from` is a folder.
public struct RenameRequest: Codable, Hashable, Sendable {
  public var from: String
  public var to: String

  public init(from: String, to: String) {
    self.from = from
    self.to = to
  }
}

public struct FolderRenameResponse: Codable, Hashable, Sendable {
  public var path: String
  /// Number of files moved.
  public var moved: Int

  public init(path: String, moved: Int) {
    self.path = path
    self.moved = moved
  }
}

/// A renamed note answers like a write; a renamed folder reports how many files moved.
public enum RenameResponse: Hashable, Sendable {
  case note(WriteNoteResponse)
  case folder(FolderRenameResponse)

  public var path: String {
    switch self {
    case .note(let r): r.path
    case .folder(let r): r.path
    }
  }
}

extension RenameResponse: Codable {
  private enum Keys: String, CodingKey { case moved }

  public init(from decoder: Decoder) throws {
    let c = try decoder.container(keyedBy: Keys.self)
    if c.contains(.moved) {
      self = .folder(try FolderRenameResponse(from: decoder))
    } else {
      self = .note(try WriteNoteResponse(from: decoder))
    }
  }

  public func encode(to encoder: Encoder) throws {
    switch self {
    case .note(let r): try r.encode(to: encoder)
    case .folder(let r): try r.encode(to: encoder)
    }
  }
}

public struct CreateFolderRequest: Codable, Hashable, Sendable {
  public var path: String
  public init(path: String) { self.path = path }
}

public struct CreateFolderResponse: Codable, Hashable, Sendable {
  public var path: String
  public init(path: String) { self.path = path }
}

/// Deletes are soft: the note/folder moves into the vault's `.trash/` folder.
public struct TrashResponse: Codable, Hashable, Sendable {
  public var ok: Bool
  public var trashedTo: String

  public init(ok: Bool = true, trashedTo: String) {
    self.ok = ok
    self.trashedTo = trashedTo
  }
}

public struct OkResponse: Codable, Hashable, Sendable {
  public var ok: Bool
  public init(ok: Bool = true) { self.ok = ok }
}

/// 200 when the action finished; 202 with `pending: true` when it continues in the background.
public struct ThreadActionResponse: Codable, Hashable, Sendable {
  public var ok: Bool
  public var pending: Bool?

  public init(ok: Bool = true, pending: Bool? = nil) {
    self.ok = ok
    self.pending = pending
  }
}

public struct DailyNoteResponse: Codable, Hashable, Sendable {
  public var path: String
  public var content: String
  public var version: String
  public var mtime: EpochMillis
  /// Local ISO date (YYYY-MM-DD).
  public var date: String
  public var created: Bool

  public init(
    path: String, content: String, version: String, mtime: EpochMillis, date: String, created: Bool
  ) {
    self.path = path
    self.content = content
    self.version = version
    self.mtime = mtime
    self.date = date
    self.created = created
  }

  public var note: NoteResponse {
    NoteResponse(path: path, content: content, version: version, mtime: mtime)
  }
}

public enum SearchHitKind: String, Codable, Hashable, Sendable {
  case name, content
}

public struct SearchHit: Codable, Hashable, Sendable {
  public var path: String
  public var kind: SearchHitKind
  /// 0-based line of a `content` hit (0 for `name` hits).
  public var line: Int
  public var preview: String

  public init(path: String, kind: SearchHitKind, line: Int, preview: String) {
    self.path = path
    self.kind = kind
    self.line = line
    self.preview = preview
  }
}

public struct SearchResponse: Codable, Hashable, Sendable {
  public var hits: [SearchHit]
  public init(hits: [SearchHit]) { self.hits = hits }
}

public struct SettingsResponse: Codable, Hashable, Sendable {
  public var settings: AppSettings
  public init(settings: AppSettings) { self.settings = settings }
}

public struct ConnectorTransport: WireEnum {
  public let rawValue: String
  public init(rawValue: String) { self.rawValue = rawValue }
  public static let stdio: Self = "stdio"
  public static let http: Self = "http"
  public static let sse: Self = "sse"
}

public struct ConnectorState: WireEnum {
  public let rawValue: String
  public init(rawValue: String) { self.rawValue = rawValue }
  public static let disabled: Self = "disabled"
  public static let idle: Self = "idle"
  public static let connecting: Self = "connecting"
  public static let connected: Self = "connected"
  public static let error: Self = "error"
}

public struct ConnectorStatus: Codable, Hashable, Sendable, Identifiable {
  public var name: String
  public var transport: ConnectorTransport
  public var state: ConnectorState
  public var toolCount: Int
  public var error: String?

  public var id: String { name }

  public init(
    name: String, transport: ConnectorTransport, state: ConnectorState, toolCount: Int,
    error: String? = nil
  ) {
    self.name = name
    self.transport = transport
    self.state = state
    self.toolCount = toolCount
    self.error = error
  }
}

public struct ExecutionCapabilities: Codable, Hashable, Sendable {
  public var shell: Bool
  public var browser: Bool
  public var computer: Bool

  public init(shell: Bool, browser: Bool, computer: Bool) {
    self.shell = shell
    self.browser = browser
    self.computer = computer
  }
}

/// The app macOS attributes the daemon's privacy permissions to (the Daily Do List app, or the
/// terminal or editor the daemon was started from).
public struct ComputerHostApp: Codable, Hashable, Sendable {
  /// As listed in System Settings.
  public var name: String
  /// The `.app` bundle.
  public var path: String?
  public var bundleId: String?

  public init(name: String, path: String? = nil, bundleId: String? = nil) {
    self.name = name
    self.path = path
    self.bundleId = bundleId
  }
}

/// Computer use on this Mac: its two privacy permissions and whether agents can operate apps in
/// the background (the `ddl-computer` helper).
public struct ComputerAccess: Codable, Hashable, Sendable {
  /// Input and reading other apps' UI.
  public var accessibility: Bool
  /// Screenshots. macOS applies a new grant after the host app restarts.
  public var screenRecording: Bool
  /// App control is available; otherwise computer use is screen-level only.
  public var appControl: Bool
  /// Absent when it can't be determined.
  public var hostApp: ComputerHostApp?

  public init(
    accessibility: Bool, screenRecording: Bool, appControl: Bool, hostApp: ComputerHostApp? = nil
  ) {
    self.accessibility = accessibility
    self.screenRecording = screenRecording
    self.appControl = appControl
    self.hostApp = hostApp
  }

  /// Both permissions are granted.
  public var isComplete: Bool { accessibility && screenRecording }
}

public struct ExecutionStatus: Codable, Hashable, Sendable {
  public var provider: String
  public var capabilities: ExecutionCapabilities
  /// Present where computer use exists (macOS with computer use enabled).
  public var computerAccess: ComputerAccess?

  public init(
    provider: String, capabilities: ExecutionCapabilities, computerAccess: ComputerAccess? = nil
  ) {
    self.provider = provider
    self.capabilities = capabilities
    self.computerAccess = computerAccess
  }
}

public struct AgentStatusResponse: Codable, Hashable, Sendable {
  public var mode: AgentMode
  public var enabled: Bool
  public var model: String
  public var running: Int
  public var queued: Int
  public var pendingApprovals: Int
  public var connectors: [ConnectorStatus]
  public var execution: ExecutionStatus
  /// Present when the agent cannot run (e.g. missing or rejected API key).
  public var problem: String?

  public init(
    mode: AgentMode, enabled: Bool, model: String, running: Int, queued: Int,
    pendingApprovals: Int, connectors: [ConnectorStatus], execution: ExecutionStatus,
    problem: String? = nil
  ) {
    self.mode = mode
    self.enabled = enabled
    self.model = model
    self.running = running
    self.queued = queued
    self.pendingApprovals = pendingApprovals
    self.connectors = connectors
    self.execution = execution
    self.problem = problem
  }
}

public struct SetAgentEnabledRequest: Codable, Hashable, Sendable {
  public var enabled: Bool
  public init(enabled: Bool) { self.enabled = enabled }
}

public struct TaskRecordsResponse: Codable, Hashable, Sendable {
  public var records: [TaskAgentRecord]
  public init(records: [TaskAgentRecord]) { self.records = records }
}

public struct ThreadListResponse: Codable, Hashable, Sendable {
  public var threads: [ThreadSummary]
  public init(threads: [ThreadSummary]) { self.threads = threads }
}

public struct ThreadResponse: Codable, Hashable, Sendable {
  public var thread: AgentThread
  public var approvals: [ApprovalRequest]

  public init(thread: AgentThread, approvals: [ApprovalRequest]) {
    self.thread = thread
    self.approvals = approvals
  }
}

public struct PostMessageRequest: Codable, Hashable, Sendable {
  public var text: String
  public init(text: String) { self.text = text }
}

public struct ApprovalListResponse: Codable, Hashable, Sendable {
  public var approvals: [ApprovalRequest]
  public init(approvals: [ApprovalRequest]) { self.approvals = approvals }
}

public struct ApprovalResponse: Codable, Hashable, Sendable {
  public var approval: ApprovalRequest
  public init(approval: ApprovalRequest) { self.approval = approval }
}

public struct ConnectorsResponse: Codable, Hashable, Sendable {
  public var connectors: [ConnectorStatus]
  public init(connectors: [ConnectorStatus]) { self.connectors = connectors }
}

public struct ApprovalDecisionRequest: Codable, Hashable, Sendable {
  public var decision: ApprovalDecision
  public var scope: ApprovalScope?
  public var note: String?

  public init(decision: ApprovalDecision, scope: ApprovalScope? = nil, note: String? = nil) {
    self.decision = decision
    self.scope = scope
    self.note = note
  }
}

// MARK: - Sync

public struct SyncState: WireEnum {
  public let rawValue: String
  public init(rawValue: String) { self.rawValue = rawValue }
  public static let idle: Self = "idle"
  public static let syncing: Self = "syncing"
  public static let error: Self = "error"
  /// No sync target is configured.
  public static let disabled: Self = "disabled"
}

/// Where the vault syncs: nowhere, another folder, S3, or the sync service (other devices).
public struct SyncTargetKind: WireEnum {
  public let rawValue: String
  public init(rawValue: String) { self.rawValue = rawValue }
  public static let none: Self = "none"
  public static let local: Self = "local"
  public static let s3: Self = "s3"
  public static let remote: Self = "remote"
}

/// `GET /api/sync/status`.
public struct SyncStatusResponse: Codable, Hashable, Sendable {
  public var state: SyncState
  public var target: SyncTargetKind
  /// When the last pass finished; nil before the first one.
  public var lastSyncedAt: EpochMillis?
  /// Files changed on either side and not synced yet.
  public var pendingChanges: Int
  /// Conflict copies (vault paths) waiting to be resolved.
  public var conflicts: [String]
  public var lastError: String?
  /// `host[:port]` of the sync server (`remote` only).
  public var remoteHost: String?
  /// This device's name as other devices see it (`remote` only).
  public var deviceName: String?

  public init(
    state: SyncState, target: SyncTargetKind, lastSyncedAt: EpochMillis?, pendingChanges: Int,
    conflicts: [String], lastError: String? = nil, remoteHost: String? = nil,
    deviceName: String? = nil
  ) {
    self.state = state
    self.target = target
    self.lastSyncedAt = lastSyncedAt
    self.pendingChanges = pendingChanges
    self.conflicts = conflicts
    self.lastError = lastError
    self.remoteHost = remoteHost
    self.deviceName = deviceName
  }

  enum CodingKeys: String, CodingKey {
    case state, target, lastSyncedAt, pendingChanges, conflicts, lastError, remoteHost, deviceName
  }

  public func encode(to encoder: Encoder) throws {
    var c = encoder.container(keyedBy: CodingKeys.self)
    try c.encode(state, forKey: .state)
    try c.encode(target, forKey: .target)
    // Required on the wire: null before the first pass.
    try c.encode(lastSyncedAt, forKey: .lastSyncedAt)
    try c.encode(pendingChanges, forKey: .pendingChanges)
    try c.encode(conflicts, forKey: .conflicts)
    try c.encodeIfPresent(lastError, forKey: .lastError)
    try c.encodeIfPresent(remoteHost, forKey: .remoteHost)
    try c.encodeIfPresent(deviceName, forKey: .deviceName)
  }
}

// MARK: - Computer use
/// A System Settings privacy pane computer use needs. Clients send it, so it is closed.
public enum ComputerPermissionPane: String, Codable, Hashable, Sendable, CaseIterable {
  case accessibility
  case screenRecording
}

/// Body of `POST /api/computer/permissions/open`.
public struct ComputerPermissionsOpenRequest: Codable, Hashable, Sendable {
  public var pane: ComputerPermissionPane

  public init(pane: ComputerPermissionPane) { self.pane = pane }
}

// MARK: - Errors

/// Every `error` code the daemon answers with. Unknown codes are handled like any other failure
/// with that HTTP status.
public struct ApiErrorCode: WireEnum {
  public let rawValue: String
  public init(rawValue: String) { self.rawValue = rawValue }
  public static let invalidJSON: Self = "invalid_json"
  public static let invalidRequest: Self = "invalid_request"
  public static let invalidPath: Self = "invalid_path"
  public static let invalidSettings: Self = "invalid_settings"
  public static let unauthorized: Self = "unauthorized"
  public static let forbiddenHost: Self = "forbidden_host"
  public static let forbiddenOrigin: Self = "forbidden_origin"
  public static let notFound: Self = "not_found"
  public static let conflict: Self = "conflict"
  public static let payloadTooLarge: Self = "payload_too_large"
  public static let upgradeRequired: Self = "upgrade_required"
  public static let httpError: Self = "http_error"
  public static let agentError: Self = "agent_error"
  public static let internalError: Self = "internal_error"
  public static let agentUnavailable: Self = "agent_unavailable"
}

public struct ApiErrorBody: Codable, Hashable, Sendable {
  public var error: ApiErrorCode
  public var message: String?

  public init(error: ApiErrorCode, message: String? = nil) {
    self.error = error
    self.message = message
  }
}

/// 409 body of a note write or rename whose target changed; `current` is nil if it's gone.
public struct ConflictResponse: Codable, Hashable, Sendable {
  public var error: ApiErrorCode
  public var message: String?
  public var current: NoteResponse?

  public init(error: ApiErrorCode = .conflict, message: String? = nil, current: NoteResponse?) {
    self.error = error
    self.message = message
    self.current = current
  }

  enum CodingKeys: String, CodingKey { case error, message, current }

  public func encode(to encoder: Encoder) throws {
    var c = encoder.container(keyedBy: CodingKeys.self)
    try c.encode(error, forKey: .error)
    try c.encodeIfPresent(message, forKey: .message)
    try c.encode(current, forKey: .current)
  }
}

/// 409 body of an approval decision when the approval is no longer pending.
public struct ApprovalConflictResponse: Codable, Hashable, Sendable {
  public var error: ApiErrorCode
  public var message: String?
  public var approval: ApprovalRequest

  public init(error: ApiErrorCode = .conflict, message: String? = nil, approval: ApprovalRequest) {
    self.error = error
    self.message = message
    self.approval = approval
  }
}
