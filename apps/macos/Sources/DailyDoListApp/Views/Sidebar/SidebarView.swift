import DailyDoListUI
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
      if ui.sidebarMode == .search {
        IconButton("magnifyingglass", label: "Show files", isActive: true) {
          ui.sidebarMode = .files
        }
      } else {
        IconButton("magnifyingglass", label: "Search vault", command: .search) {
          ui.focusSearch()
        }
      }
      IconButton("square.and.pencil", label: "New note", command: .newNote) {
        Task { await workspace.createNote() }
      }
      IconButton("sidebar.left", label: "Hide sidebar", command: .toggleSidebar) {
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
