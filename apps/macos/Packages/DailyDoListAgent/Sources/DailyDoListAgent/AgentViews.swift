import DailyDoListModels
import SwiftUI

// Public views of the agent package. (Initial stubs — replaced by the full agent UI.)

/// Right-hand agent panel: the inbox, or one thread when `selectedThreadId` is set.
public struct AgentPanel: View {
  @Bindable var store: AgentStore
  @Binding var selectedThreadId: String?

  public init(store: AgentStore, selectedThreadId: Binding<String?>) {
    self.store = store
    self._selectedThreadId = selectedThreadId
  }

  public var body: some View {
    List(store.threads.values.sorted { $0.updatedAt > $1.updatedAt }) { thread in
      Text(thread.title)
    }
  }
}

/// Content of the menu bar extra: agent status, pending approvals, quick actions.
public struct AgentMenuBarContent: View {
  @Bindable var store: AgentStore
  let openTodaysNote: () -> Void

  public init(store: AgentStore, openTodaysNote: @escaping () -> Void) {
    self.store = store
    self.openTodaysNote = openTodaysNote
  }

  public var body: some View {
    Button("Open Today's Note", action: openTodaysNote)
  }
}
