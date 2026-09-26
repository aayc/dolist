import AppKit
import DailyDoListAgent
import DailyDoListUI
import SwiftUI

/// Scene id of the orchestrator's chat window (one; reopening it focuses it).
enum OrchestratorWindowID {
  static let value = "orchestrator"
}

/// The orchestrator's chat in a window of its own (Agent → Orchestrator Chat). A decision's task
/// link opens that task's thread in the main window's agent panel.
struct OrchestratorWindowView: View {
  let model: AppModel

  var body: some View {
    Group {
      if let agent = model.agent {
        OrchestratorChatView(
          store: agent, onOpenTask: { model.openThread($0) },
          noteLinks: model.workspace?.agentNoteLinks, showsErrors: true)
      } else {
        ContentUnavailableView(
          "Agent unavailable", systemImage: "point.3.connected.trianglepath.dotted",
          description: Text("Not connected to the daemon."))
      }
    }
    .frame(minWidth: 360, maxWidth: .infinity, minHeight: 420, maxHeight: .infinity)
    .background(Theme.background)
    .background(
      WindowAccessor { window in
        WindowHandles.shared.orchestratorWindow = window
        window.tabbingMode = .disallowed
      })
  }
}

extension AppModel {
  /// A chip or the orchestrator's indicators: its chat's window, scrolled to the turn (the
  /// turn's first message) when there is one.
  func showOrchestratorTurn(_ turnId: String?) {
    if let turnId { agent?.focusOrchestratorMessage(turnId) }
    showOrchestratorWindow()
  }

  /// Agent → Orchestrator Chat: brings its window forward, opening it if needed.
  func showOrchestratorWindow() {
    if environment.enablesSystemServices { NSApplication.shared.activate() }
    if let window = windows.orchestratorWindow, window.isVisible || window.isMiniaturized {
      if window.isMiniaturized { window.deminiaturize(nil) }
      window.makeKeyAndOrderFront(nil)
    } else {
      windows.openOrchestratorWindow?()
    }
  }
}
