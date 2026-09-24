import DailyDoListClient
import Foundation

/// A failed agent action, shown as a non-blocking toast.
public struct AgentAlert: Identifiable, Hashable, Sendable {
  public let id: UUID
  /// What failed, e.g. "Couldn't send your decision".
  public var title: String
  /// Why (the daemon's message when it gave one).
  public var message: String

  public init(id: UUID = UUID(), title: String, message: String) {
    self.id = id
    self.title = title
    self.message = message
  }

  init(title: String, error: Error) {
    self.init(title: title, message: Self.describe(error))
  }

  static func describe(_ error: Error) -> String {
    if let error = error as? LocalizedError, let description = error.errorDescription {
      return description
    }
    return error.localizedDescription
  }
}
