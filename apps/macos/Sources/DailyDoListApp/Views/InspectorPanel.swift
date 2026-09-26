import DailyDoListAgent
import DailyDoListUI
import SwiftUI

/// Right-hand pane (⌘\): the agent panel — inbox, or the selected thread.
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
            Task {
              await workspace.revealTask(notePath: location.notePath, record: location.record)
            }
          },
          headerHeight: Theme.headerHeight,
          onHide: { ui.inspectorPresented = false },
          noteLinks: workspace.agentNoteLinks,
          shortcuts: .app,
          onOpenOrchestratorWindow: { model.showOrchestratorWindow() },
          section: $ui.agentSection, selectedRoutineId: $ui.selectedRoutineId,
          routineActions: AgentRoutineActions(
            newRoutine: { ui.newRoutine($0) },
            edit: { routine in Task { await workspace.openNote(routine.path) } }),
          placementActions: AgentPlacementActions(openSetUp: { setUp in
            model.showAlwaysOnSettings(AlwaysOnSection(setUp))
          }))
      } else {
        ContentUnavailableView(
          "Agent unavailable", systemImage: "sparkles",
          description: Text("Not connected to the daemon."))
      }
    }
    .frame(maxWidth: .infinity, maxHeight: .infinity)
    .background(alignment: .top) {
      ZStack(alignment: .top) {
        Theme.background
        WindowDragArea().frame(height: Theme.headerHeight)
      }
    }
  }
}
