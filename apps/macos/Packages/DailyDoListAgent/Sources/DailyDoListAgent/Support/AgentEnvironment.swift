import AppKit
import SwiftUI

private struct AgentReferenceDateKey: EnvironmentKey {
  static let defaultValue: Date? = nil
}

/// Where the agent views' copy buttons put text: the general pasteboard (tests record it).
struct AgentClipboard: Sendable {
  var copy: @MainActor @Sendable (String) -> Void

  static let system = AgentClipboard { text in
    NSPasteboard.general.clearContents()
    NSPasteboard.general.setString(text, forType: .string)
  }
}

private struct AgentClipboardKey: EnvironmentKey {
  static let defaultValue = AgentClipboard.system
}

extension EnvironmentValues {
  /// A fixed "now" for relative times and liveness (previews, snapshots); nil = the real clock.
  var agentReferenceDate: Date? {
    get { self[AgentReferenceDateKey.self] }
    set { self[AgentReferenceDateKey.self] = newValue }
  }

  var agentClipboard: AgentClipboard {
    get { self[AgentClipboardKey.self] }
    set { self[AgentClipboardKey.self] = newValue }
  }
}

extension View {
  /// Freezes the agent views' clock (previews, screenshots, demos).
  public func agentReferenceDate(_ date: Date?) -> some View {
    environment(\.agentReferenceDate, date)
  }
}
