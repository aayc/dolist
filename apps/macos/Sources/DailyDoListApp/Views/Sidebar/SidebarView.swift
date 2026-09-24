import SwiftUI

/// Left column: file explorer or vault search (⌘⇧F). Its header holds the window's traffic lights.
struct SidebarView: View {
  let workspace: Workspace
  @Bindable var ui: UIState

  var body: some View {
    VStack(spacing: 0) {
      header
      switch ui.sidebarMode {
      case .files: FileExplorerView(workspace: workspace, ui: ui)
      case .search: SearchPanel(workspace: workspace, search: workspace.search, ui: ui)
      }
    }
    .scrollContentBackground(.hidden)
    .background(Theme.secondaryBackground)
  }

  private var header: some View {
    HStack(spacing: 2) {
      Spacer(minLength: 0)
      IconButton(
        systemImage: "magnifyingglass", help: ui.sidebarMode == .search ? "Show files" : "Search (⇧⌘F)",
        isActive: ui.sidebarMode == .search
      ) {
        if ui.sidebarMode == .search { ui.sidebarMode = .files } else { ui.focusSearch() }
      }
      IconButton(systemImage: "square.and.pencil", help: "New note (⌘N)") {
        Task { await workspace.createNote() }
      }
      IconButton(systemImage: "sidebar.left", help: "Hide sidebar (⌃⌘S)") {
        ui.sidebarVisible = false
      }
    }
    .padding(.leading, ui.isFullScreen ? 8 : Theme.trafficLightsWidth)
    .padding(.trailing, 6)
    .frame(height: Theme.headerHeight)
    .background(WindowDragArea())
    .overlay(alignment: .bottom) { Hairline() }
  }
}
