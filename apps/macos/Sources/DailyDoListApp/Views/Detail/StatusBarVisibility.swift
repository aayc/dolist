import DailyDoListClient
import DailyDoListModels

/// What the status bar shows besides the agent items and the word count. The normal state (note
/// saved, daemon connected, live agent) shows nothing, so only changes and problems draw the eye.
struct StatusBarVisibility: Equatable {
  enum Connection: Equatable {
    /// Connected to the in-memory demo daemon: a small "Demo" marker.
    case demo
    /// Connecting, reconnecting, offline or incompatible: dot, label and details.
    case problem
  }

  /// The active note's save state while it isn't saved (unsaved, saving, conflict, error).
  var saveState: SaveState?
  var connection: Connection?
  /// The agent's mode next to the on/off item while it isn't `live` (mock, off).
  var agentMode: AgentMode?

  init(saveState: SaveState?, connection: ConnectionState, isDemo: Bool, agentMode: AgentMode?) {
    self.saveState = saveState == .saved ? nil : saveState
    switch connection {
    case .connected: self.connection = isDemo ? .demo : nil
    case .idle, .connecting, .reconnecting, .incompatible, .disconnected: self.connection = .problem
    }
    self.agentMode = agentMode == .live ? nil : agentMode
  }
}
