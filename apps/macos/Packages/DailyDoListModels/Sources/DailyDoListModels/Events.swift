import Foundation

public struct VaultChangeOrigin: WireEnum {
  public let rawValue: String
  public init(rawValue: String) { self.rawValue = rawValue }
  public static let external: Self = "external"
  public static let client: Self = "client"
  public static let agent: Self = "agent"
  public static let sync: Self = "sync"
}

public enum VaultChangeKind: String, Codable, Hashable, Sendable {
  case created, modified, deleted
}

public struct VaultChange: Codable, Hashable, Sendable {
  public var path: String
  public var kind: VaultChangeKind
  public var version: String?

  public init(path: String, kind: VaultChangeKind, version: String? = nil) {
    self.path = path
    self.kind = kind
    self.version = version
  }
}

/// Machine-readable reason of a server `error` event.
public struct WsErrorCode: WireEnum {
  public let rawValue: String
  public init(rawValue: String) { self.rawValue = rawValue }
  public static let invalidJSON: Self = "invalid_json"
  public static let invalidMessage: Self = "invalid_message"
  public static let binaryUnsupported: Self = "binary_unsupported"
  public static let tooManySubscriptions: Self = "too_many_subscriptions"
  public static let subscribeFailed: Self = "subscribe_failed"
  public static let incompatibleApiVersion: Self = "incompatible_api_version"
}

// MARK: - Server events

public struct HelloEvent: Codable, Hashable, Sendable {
  public var serverVersion: String
  public var apiVersion: Int
  public init(serverVersion: String, apiVersion: Int) {
    self.serverVersion = serverVersion
    self.apiVersion = apiVersion
  }
}

public struct VaultChangedEvent: Codable, Hashable, Sendable {
  public var changes: [VaultChange]
  public var origin: VaultChangeOrigin
  /// Client that caused the change (so it can ignore its own echo).
  public var clientId: String?
  public init(changes: [VaultChange], origin: VaultChangeOrigin, clientId: String? = nil) {
    self.changes = changes
    self.origin = origin
    self.clientId = clientId
  }
}

public struct TaskRecordsEvent: Codable, Hashable, Sendable {
  public var notePath: String
  public var records: [TaskAgentRecord]
  public init(notePath: String, records: [TaskAgentRecord]) {
    self.notePath = notePath
    self.records = records
  }
}

public struct ThreadMessageEvent: Codable, Hashable, Sendable {
  public var threadId: String
  public var message: ThreadMessage
  public init(threadId: String, message: ThreadMessage) {
    self.threadId = threadId
    self.message = message
  }
}

public struct ThreadDeltaEvent: Codable, Hashable, Sendable {
  public var threadId: String
  public var messageId: String
  public var delta: String
  public init(threadId: String, messageId: String, delta: String) {
    self.threadId = threadId
    self.messageId = messageId
    self.delta = delta
  }
}

public struct ServerErrorEvent: Codable, Hashable, Sendable {
  public var message: String
  public var code: WsErrorCode?
  public init(message: String, code: WsErrorCode? = nil) {
    self.message = message
    self.code = code
  }
}

/// Everything the daemon pushes on `/ws`, discriminated by `type`.
public enum ServerEvent: Hashable, Sendable {
  /// First event on every connection.
  case hello(HelloEvent)
  case vaultChanged(VaultChangedEvent)
  case taskRecords(TaskRecordsEvent)
  case taskRecord(TaskAgentRecord)
  case threadUpsert(ThreadSummary)
  case threadMessage(ThreadMessageEvent)
  case threadDelta(ThreadDeltaEvent)
  case approvalUpsert(ApprovalRequest)
  case agentStatus(AgentStatusResponse)
  case surfaceFrame(SurfaceFrame)
  case settingsChanged(AppSettings)
  /// Every routine, whenever one changed.
  case routinesChanged([Routine])
  /// A run finished and its routine's `notify` says to tell the user.
  case routineNotification(RoutineNotification)
  case error(ServerErrorEvent)
  /// A type this client doesn't know (from a newer daemon): ignore it.
  case unknown(type: String, raw: JSONValue)

  public var type: String {
    switch self {
    case .hello: "hello"
    case .vaultChanged: "vault.changed"
    case .taskRecords: "task.records"
    case .taskRecord: "task.record"
    case .threadUpsert: "thread.upsert"
    case .threadMessage: "thread.message"
    case .threadDelta: "thread.delta"
    case .approvalUpsert: "approval.upsert"
    case .agentStatus: "agent.status"
    case .surfaceFrame: "surface.frame"
    case .settingsChanged: "settings.changed"
    case .routinesChanged: "routines.changed"
    case .routineNotification: "routine.notification"
    case .error: "error"
    case .unknown(let type, _): type
    }
  }
}

extension ServerEvent: Codable {
  private enum Keys: String, CodingKey {
    case type, record, thread, approval, status, settings, routines, notification
  }

  public init(from decoder: Decoder) throws {
    let c = try decoder.container(keyedBy: Keys.self)
    let type = try c.decode(String.self, forKey: .type)
    switch type {
    case "hello": self = .hello(try HelloEvent(from: decoder))
    case "vault.changed": self = .vaultChanged(try VaultChangedEvent(from: decoder))
    case "task.records": self = .taskRecords(try TaskRecordsEvent(from: decoder))
    case "task.record": self = .taskRecord(try c.decode(TaskAgentRecord.self, forKey: .record))
    case "thread.upsert": self = .threadUpsert(try c.decode(ThreadSummary.self, forKey: .thread))
    case "thread.message": self = .threadMessage(try ThreadMessageEvent(from: decoder))
    case "thread.delta": self = .threadDelta(try ThreadDeltaEvent(from: decoder))
    case "approval.upsert":
      self = .approvalUpsert(try c.decode(ApprovalRequest.self, forKey: .approval))
    case "agent.status":
      self = .agentStatus(try c.decode(AgentStatusResponse.self, forKey: .status))
    case "surface.frame": self = .surfaceFrame(try SurfaceFrame(from: decoder))
    case "settings.changed":
      self = .settingsChanged(try c.decode(AppSettings.self, forKey: .settings))
    case "routines.changed":
      self = .routinesChanged(try c.decode([Routine].self, forKey: .routines))
    case "routine.notification":
      self = .routineNotification(
        try c.decode(RoutineNotification.self, forKey: .notification))
    case "error": self = .error(try ServerErrorEvent(from: decoder))
    default: self = .unknown(type: type, raw: try JSONValue(from: decoder))
    }
  }

  public func encode(to encoder: Encoder) throws {
    switch self {
    case .hello(let e): try encodeTagged(e, kind: "hello", key: "type", to: encoder)
    case .vaultChanged(let e): try encodeTagged(e, kind: "vault.changed", key: "type", to: encoder)
    case .taskRecords(let e): try encodeTagged(e, kind: "task.records", key: "type", to: encoder)
    case .taskRecord(let record):
      try encodeWrapped(record, key: .record, type: "task.record", to: encoder)
    case .threadUpsert(let thread):
      try encodeWrapped(thread, key: .thread, type: "thread.upsert", to: encoder)
    case .threadMessage(let e):
      try encodeTagged(e, kind: "thread.message", key: "type", to: encoder)
    case .threadDelta(let e): try encodeTagged(e, kind: "thread.delta", key: "type", to: encoder)
    case .approvalUpsert(let approval):
      try encodeWrapped(approval, key: .approval, type: "approval.upsert", to: encoder)
    case .agentStatus(let status):
      try encodeWrapped(status, key: .status, type: "agent.status", to: encoder)
    case .surfaceFrame(let frame):
      try encodeTagged(frame, kind: "surface.frame", key: "type", to: encoder)
    case .settingsChanged(let settings):
      try encodeWrapped(settings, key: .settings, type: "settings.changed", to: encoder)
    case .routinesChanged(let routines):
      try encodeWrapped(routines, key: .routines, type: "routines.changed", to: encoder)
    case .routineNotification(let notification):
      try encodeWrapped(
        notification, key: .notification, type: "routine.notification", to: encoder)
    case .error(let e): try encodeTagged(e, kind: "error", key: "type", to: encoder)
    case .unknown(_, let raw): try raw.encode(to: encoder)
    }
  }

  private func encodeWrapped<T: Encodable>(_ value: T, key: Keys, type: String, to encoder: Encoder)
    throws
  {
    var c = encoder.container(keyedBy: Keys.self)
    try c.encode(type, forKey: .type)
    try c.encode(value, forKey: key)
  }
}

// MARK: - Client events

/// Signals a client sends on `/ws`.
public enum ClientEvent: Hashable, Sendable {
  case hello(
    clientId: String, apiVersion: Int = DaemonProtocol.apiVersion, clientVersion: String? = nil)
  case ping
  case surfaceSubscribe(threadId: String, surface: SurfaceKind)
  case surfaceUnsubscribe(threadId: String, surface: SurfaceKind)
  case threadRead(threadId: String)
  /// Where the user is typing, so the orchestrator never jumps on a half-written task.
  case editorActivity(notePath: String, line: Int)

  public var type: String {
    switch self {
    case .hello: "hello"
    case .ping: "ping"
    case .surfaceSubscribe: "surface.subscribe"
    case .surfaceUnsubscribe: "surface.unsubscribe"
    case .threadRead: "thread.read"
    case .editorActivity: "editor.activity"
    }
  }
}

extension ClientEvent: Codable {
  private enum Keys: String, CodingKey {
    case type, clientId, apiVersion, clientVersion, threadId, surface, notePath, line
  }

  public init(from decoder: Decoder) throws {
    let c = try decoder.container(keyedBy: Keys.self)
    let type = try c.decode(String.self, forKey: .type)
    switch type {
    case "hello":
      self = .hello(
        clientId: try c.decode(String.self, forKey: .clientId),
        apiVersion: try c.decodeIfPresent(Int.self, forKey: .apiVersion) ?? 1,
        clientVersion: try c.decodeIfPresent(String.self, forKey: .clientVersion))
    case "ping": self = .ping
    case "surface.subscribe":
      self = .surfaceSubscribe(
        threadId: try c.decode(String.self, forKey: .threadId),
        surface: try c.decode(SurfaceKind.self, forKey: .surface))
    case "surface.unsubscribe":
      self = .surfaceUnsubscribe(
        threadId: try c.decode(String.self, forKey: .threadId),
        surface: try c.decode(SurfaceKind.self, forKey: .surface))
    case "thread.read": self = .threadRead(threadId: try c.decode(String.self, forKey: .threadId))
    case "editor.activity":
      self = .editorActivity(
        notePath: try c.decode(String.self, forKey: .notePath),
        line: try c.decode(Int.self, forKey: .line))
    default:
      throw DecodingError.dataCorruptedError(
        forKey: .type, in: c, debugDescription: "Unknown client event type \(type)")
    }
  }

  public func encode(to encoder: Encoder) throws {
    var c = encoder.container(keyedBy: Keys.self)
    try c.encode(type, forKey: .type)
    switch self {
    case .hello(let clientId, let apiVersion, let clientVersion):
      try c.encode(clientId, forKey: .clientId)
      try c.encode(apiVersion, forKey: .apiVersion)
      try c.encodeIfPresent(clientVersion, forKey: .clientVersion)
    case .ping:
      break
    case .surfaceSubscribe(let threadId, let surface),
      .surfaceUnsubscribe(let threadId, let surface):
      try c.encode(threadId, forKey: .threadId)
      try c.encode(surface, forKey: .surface)
    case .threadRead(let threadId):
      try c.encode(threadId, forKey: .threadId)
    case .editorActivity(let notePath, let line):
      try c.encode(notePath, forKey: .notePath)
      try c.encode(line, forKey: .line)
    }
  }
}

// MARK: - JSON coding helpers

extension JSONDecoder {
  /// Decoder configured for daemon payloads.
  public static var daemon: JSONDecoder { JSONDecoder() }
}

extension JSONEncoder {
  /// Encoder configured for daemon payloads (stable key order for tests and logs).
  public static var daemon: JSONEncoder {
    let encoder = JSONEncoder()
    encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
    return encoder
  }
}
