import DailyDoListModels
import Foundation

/// Every failure of a `DaemonClient` call.
public enum DaemonClientError: Error, Equatable, Sendable {
  /// The daemon could not be reached (not running, wrong port, timed out, connection lost).
  case unreachable(String)
  /// 401: missing or wrong token.
  case unauthorized
  /// 401 `pairing_rejected` from `pair` or `pairMachine`: the pairing code was wrong, expired or
  /// already used (the token is fine). Carries the daemon's message.
  case pairingRejected(String?)
  /// 409 on a note write or rename: the target changed (or is gone when `current` is nil).
  case conflict(ConflictResponse)
  /// 409 on an approval decision: it is no longer pending.
  case approvalConflict(ApprovalConflictResponse)
  /// 429: too many requests (pairing attempts, pairing codes waiting). `retryAfter` is the
  /// daemon's `Retry-After` in seconds, when it sent one.
  case rateLimited(retryAfter: Int?, body: ApiErrorBody?)
  /// Any other non-2xx answer. `body` is nil when it isn't an `ApiErrorBody`.
  case http(status: Int, body: ApiErrorBody?)
  /// The response did not match the protocol: `"<Type> at <codingPath>: <reason>"`.
  case decoding(String)
  /// The daemon speaks a different major API version.
  case incompatibleApiVersion(server: Int)
  /// The calling task was cancelled.
  case cancelled
}

extension DaemonClientError: LocalizedError {
  public var errorDescription: String? {
    switch self {
    case .unreachable(let reason): "Can't reach the Daily Do List daemon (\(reason))."
    case .unauthorized: "The daemon rejected this app's token."
    case .pairingRejected(let message):
      message ?? "That pairing code is wrong, expired or already used."
    case .conflict: "The note changed on disk before this edit was saved."
    case .approvalConflict: "That approval was already decided."
    case .rateLimited(_, let body): body?.message ?? "Too many attempts: try again later."
    case .http(let status, let body): body?.message ?? "The daemon answered HTTP \(status)."
    case .decoding(let detail): "Unexpected response from the daemon: \(detail)"
    case .incompatibleApiVersion(let server):
      "The daemon speaks API v\(server); this app needs v\(DaemonProtocol.apiVersion)."
    case .cancelled: "Cancelled."
    }
  }
}

extension DaemonClientError {
  /// The `ApiErrorBody.error` code, when the daemon answered with one.
  public var apiErrorCode: ApiErrorCode? {
    switch self {
    case .http(_, let body): body?.error
    case .conflict(let response): response.error
    case .approvalConflict(let response): response.error
    case .rateLimited(_, let body): body?.error ?? .rateLimited
    case .unauthorized: .unauthorized
    case .pairingRejected: .pairingRejected
    default: nil
    }
  }

  /// HTTP status of the answer, when there was one.
  public var httpStatus: Int? {
    switch self {
    case .http(let status, _): status
    case .conflict, .approvalConflict: 409
    case .rateLimited: 429
    case .unauthorized, .pairingRejected: 401
    default: nil
    }
  }

  static func invalidRequest(_ message: String) -> Self {
    .http(status: 400, body: ApiErrorBody(error: .invalidRequest, message: message))
  }

  static func invalidPath(_ message: String) -> Self {
    .http(status: 400, body: ApiErrorBody(error: .invalidPath, message: message))
  }

  static func notFound(_ message: String) -> Self {
    .http(status: 404, body: ApiErrorBody(error: .notFound, message: message))
  }

  /// `"<Type> at <codingPath>: <reason>"` for a decoding failure.
  static func decoding(_ error: any Error, type: Any.Type) -> Self {
    let name = String(describing: type)
    guard let error = error as? DecodingError else {
      return .decoding("\(name): \(error.localizedDescription)")
    }
    let (path, reason): ([any CodingKey], String) =
      switch error {
      case .typeMismatch(_, let context), .valueNotFound(_, let context),
        .dataCorrupted(let context):
        (context.codingPath, context.debugDescription)
      case .keyNotFound(let key, let context):
        (context.codingPath + [key], context.debugDescription)
      @unknown default:
        ([], error.localizedDescription)
      }
    return .decoding("\(name) at \(codingPathDescription(path)): \(reason)")
  }

  /// `thread.messages[0].input`, or `<root>`.
  static func codingPathDescription(_ path: [any CodingKey]) -> String {
    var out = ""
    for key in path {
      if let index = key.intValue {
        out += "[\(index)]"
      } else {
        out += out.isEmpty ? key.stringValue : ".\(key.stringValue)"
      }
    }
    return out.isEmpty ? "<root>" : out
  }
}
