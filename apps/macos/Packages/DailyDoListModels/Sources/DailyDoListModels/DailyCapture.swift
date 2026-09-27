import Foundation

/// A durable, explicit-date capture. Reuse every field unchanged when resolving an uncertain send.
public struct DailyAppendRequest: Codable, Hashable, Sendable {
  public var operationId: String
  public var hostId: String
  public var text: String
  public var capturedAt: EpochMillis
  public var timeZone: String

  public init(
    operationId: String, hostId: String, text: String, capturedAt: EpochMillis, timeZone: String
  ) {
    self.operationId = operationId
    self.hostId = hostId
    self.text = text
    self.capturedAt = capturedAt
    self.timeZone = timeZone
  }
}

/// Applied receipts include the exact saved base, even when the note has changed since capture.
/// Indeterminate receipts require reconciliation; they must never trigger another append.
public struct DailyAppendResponse: Codable, Hashable, Sendable {
  public enum Outcome: String, Codable, Hashable, Sendable { case applied, indeterminate }
  public var operationId: String
  public var workspaceId: String
  public var hostId: String
  public var hostDate: String
  public var hostTimeZone: String
  public var watched: Bool
  public var outcome: Outcome
  public var note: DailyNoteResponse?
  public var path: String?

  public init(
    operationId: String, workspaceId: String, hostId: String, hostDate: String,
    hostTimeZone: String, watched: Bool, outcome: Outcome, note: DailyNoteResponse? = nil,
    path: String? = nil
  ) {
    self.operationId = operationId
    self.workspaceId = workspaceId
    self.hostId = hostId
    self.hostDate = hostDate
    self.hostTimeZone = hostTimeZone
    self.watched = watched
    self.outcome = outcome
    self.note = note
    self.path = path
  }

  public init(from decoder: Decoder) throws {
    let c = try decoder.container(keyedBy: CodingKeys.self)
    operationId = try c.decode(String.self, forKey: .operationId)
    workspaceId = try c.decode(String.self, forKey: .workspaceId)
    hostId = try c.decode(String.self, forKey: .hostId)
    hostDate = try c.decode(String.self, forKey: .hostDate)
    hostTimeZone = try c.decode(String.self, forKey: .hostTimeZone)
    watched = try c.decode(Bool.self, forKey: .watched)
    outcome = try c.decode(Outcome.self, forKey: .outcome)
    switch outcome {
    case .applied:
      note = try c.decode(DailyNoteResponse.self, forKey: .note)
      path = nil
    case .indeterminate:
      path = try c.decode(String.self, forKey: .path)
      note = nil
    }
  }
}
