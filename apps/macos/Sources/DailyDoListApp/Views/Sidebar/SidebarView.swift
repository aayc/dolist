import SwiftUI

/// Left column: file explorer or vault search (⌘⇧F).
struct SidebarView: View {
  let workspace: Workspace
  @Bindable var ui: UIState

  var body: some View {
    VStack(spacing: 0) {
      header
      Divider()
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
      IconButton(systemImage: "folder", help: "Files", isActive: ui.sidebarMode == .files) {
        ui.sidebarMode = .files
      }
      IconButton(systemImage: "magnifyingglass", help: "Search (⇧⌘F)", isActive: ui.sidebarMode == .search) {
        ui.focusSearch()
      }
      Spacer()
      if ui.sidebarMode == .files {
        IconButton(systemImage: "square.and.pencil", help: "New note (⌘N)") {
          Task { await workspace.createNote() }
        }
        IconButton(systemImage: "folder.badge.plus", help: "New folder") {
          Task { await workspace.createFolder() }
        }
        IconButton(systemImage: "arrow.down.right.and.arrow.up.left", help: "Collapse all") {
          ui.expandedFolders = []
        }
      }
    }
    .padding(.horizontal, 8)
    .frame(height: 30)
  }
}
