import DailyDoListModels
import Foundation

/// All routing and payload fields freeze before the first network attempt. A pending capture
/// is its own operation, never an ordinary editor mutation or an agent-authored line.
public struct CaptureOperation: Codable, Hashable, Sendable {
  public let id: UUID
  public let scope: WorkspaceScope
  public let localDate: String
  public let capturedAt: EpochMillis
  public let timeZone: String
  public let text: String

  public init(
    id: UUID = UUID(), scope: WorkspaceScope, text: String, capturedAt: Date, timeZone: TimeZone
  ) throws {
    guard !text.isEmpty, text.utf16.count <= 100_000 else { throw CaptureError.invalidText }
    guard
      timeZone.identifier == "GMT" || timeZone.identifier == "UTC"
        || TimeZone.knownTimeZoneIdentifiers.contains(timeZone.identifier)
    else { throw CaptureError.invalidTimeZone }
    // The wire contract uses integer epoch milliseconds, while Foundation dates retain fractions.
    let timestamp = (capturedAt.timeIntervalSince1970 * 1_000).rounded(.down)
    guard timestamp.isFinite, timestamp >= 0 else { throw CaptureError.invalidDate }
    var calendar = Calendar(identifier: .gregorian)
    calendar.timeZone = timeZone
    let parts = calendar.dateComponents([.year, .month, .day], from: capturedAt)
    guard let year = parts.year, let month = parts.month, let day = parts.day,
      (1...9_999).contains(year)
    else {
      throw CaptureError.invalidDate
    }
    self.id = id
    self.scope = scope
    self.text = text
    self.capturedAt = timestamp
    self.timeZone = timeZone.identifier
    self.localDate = String(format: "%04d-%02d-%02d", year, month, day)
  }
}

/// Domain form of the append receipt; the transport adapter maps the shared wire model.
public struct CaptureReceipt: Codable, Hashable, Sendable {
  public enum Outcome: String, Codable, Sendable { case applied, indeterminate }
  public var operationID: UUID
  public var workspaceID: String
  public var hostID: String
  public var hostDate: String
  public var hostTimeZone: String
  public var watched: Bool
  public var outcome: Outcome
  public var note: DailyNoteResponse?
  public var path: String?

  public init(
    operationID: UUID, workspaceID: String, hostID: String, hostDate: String,
    hostTimeZone: String, watched: Bool, outcome: Outcome, note: DailyNoteResponse? = nil,
    path: String? = nil
  ) {
    self.operationID = operationID
    self.workspaceID = workspaceID
    self.hostID = hostID
    self.hostDate = hostDate
    self.hostTimeZone = hostTimeZone
    self.watched = watched
    self.outcome = outcome
    self.note = note
    self.path = path
  }
}

public enum CaptureState: String, Codable, Sendable {
  case queued
  /// A request may already have committed. Resolve only by retrying the identical operation.
  case sending
  case applied
  case indeterminate
  case reconciled
  case cancelled

  public var blocksNoteWrites: Bool {
    self == .queued || self == .sending || self == .indeterminate
  }
}

public struct QueuedCapture: Codable, Sendable, Identifiable {
  public var operation: CaptureOperation
  public var state: CaptureState
  public var attemptCount: Int
  public var receipt: CaptureReceipt?
  public var revision: Int64
  public var id: UUID { operation.id }
}

public enum CaptureError: Error, Equatable, Sendable {
  case invalidText
  case invalidDate
  case invalidTimeZone
  case operationIDReused
  case missingCapture
  case cannotCancelAttemptedCapture
  case receiptMismatch
  case notIndeterminate
}

public protocol CaptureRemote: Sendable {
  var profileID: UUID { get }
  var origin: ConnectionOrigin { get }
  func identity() async throws -> RemoteWorkspaceIdentity
  /// Retry the exact explicit date, operation UUID, original timestamp/timezone/text and host.
  /// Requests require the expected-workspace header. Never substitute another serving host.
  func append(_ capture: CaptureOperation) async throws -> CaptureReceipt
}

/// Read-only host evidence, retained only for the current connection and capture revision.
public struct CaptureInspection: Sendable {
  public let scope: WorkspaceScope
  public let captureID: UUID
  public let revision: Int64
  public let path: String
  public let note: RemoteNote?
  let connectionGeneration: UInt64
}
