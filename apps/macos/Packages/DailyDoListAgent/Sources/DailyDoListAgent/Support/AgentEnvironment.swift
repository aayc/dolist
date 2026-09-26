import SwiftUI

private struct AgentReferenceDateKey: EnvironmentKey {
  static let defaultValue: Date? = nil
}

extension EnvironmentValues {
  /// A fixed "now" for relative times and liveness (previews, snapshots); nil = the real clock.
  var agentReferenceDate: Date? {
    get { self[AgentReferenceDateKey.self] }
    set { self[AgentReferenceDateKey.self] = newValue }
  }
}

extension View {
  /// Freezes the agent views' clock (previews, screenshots, demos).
  public func agentReferenceDate(_ date: Date?) -> some View {
    environment(\.agentReferenceDate, date)
  }
}
