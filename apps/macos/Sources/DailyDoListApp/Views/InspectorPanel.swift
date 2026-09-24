import DailyDoListAgent
import SwiftUI

/// Right-hand inspector (⌘\): the agent panel — inbox, or the selected thread.
struct InspectorPanel: View {
  let model: AppModel
  let workspace: Workspace
  @Bindable var ui: UIState

  var body: some View {
    Group {
      if let agent = model.agent {
        AgentPanel(
          store: agent, selectedThreadId: $ui.selectedThreadId,
          onShowInNote: { location in
            Task { await workspace.revealTask(notePath: location.notePath, record: location.record) }
          },
          onClose: { ui.inspectorPresented = false })
      } else {
        ContentUnavailableView("Agent unavailable", systemImage: "sparkles", description: Text("Not connected to the daemon."))
      }
    }
    .frame(maxWidth: .infinity, maxHeight: .infinity)
    .background(Theme.background)
  }
}
