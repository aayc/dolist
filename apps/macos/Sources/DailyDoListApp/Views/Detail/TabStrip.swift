import DailyDoListDomain
import SwiftUI

/// The note column's header: (show sidebar), back/forward, the open tabs, new tab and (show agent
/// panel). Empty space drags the window, like a title bar.
struct EditorHeader: View {
  let model: AppModel
  let workspace: Workspace
  @Bindable var ui: UIState

  var body: some View {
    HStack(spacing: 2) {
      if !ui.sidebarVisible {
        IconButton(systemImage: "sidebar.left", help: "Show sidebar (⌃⌘S)") {
          ui.sidebarVisible = true
        }
      }
      IconButton(
        systemImage: "chevron.left", help: "Back (⌘[)", isEnabled: workspace.tabs.canGoBack
      ) {
        Task { await workspace.goBack() }
      }
      IconButton(
        systemImage: "chevron.right", help: "Forward (⌘])", isEnabled: workspace.tabs.canGoForward
      ) {
        Task { await workspace.goForward() }
      }
      TabStrip(workspace: workspace)
        .padding(.horizontal, 4)
      IconButton(systemImage: "plus", help: "New note (⌘N)") {
        Task { await workspace.createNote() }
      }
      if !ui.inspectorPresented {
        AgentPanelToggle(pending: model.agent?.pendingApprovalCount ?? 0) {
          ui.inspectorPresented = true
        }
      }
    }
    .padding(.leading, !ui.sidebarVisible && !ui.isFullScreen ? Theme.trafficLightsWidth : 6)
    .padding(.trailing, 6)
    .frame(height: Theme.headerHeight)
    .background(WindowDragArea())
    .overlay(alignment: .bottom) { Hairline() }
  }
}

/// Opens the agent panel; a dot while approvals wait in it.
private struct AgentPanelToggle: View {
  let pending: Int
  let action: () -> Void

  var body: some View {
    IconButton(
      systemImage: "sidebar.right",
      help: pending > 0
        ? "Show agent panel: \(pending) waiting for approval (⌘\\)" : "Show agent panel (⌘\\)",
      action: action
    )
    .overlay(alignment: .topTrailing) {
      if pending > 0 {
        Circle().fill(Theme.warning).frame(width: 6, height: 6).padding(5).allowsHitTesting(false)
      }
    }
  }
}

/// Open-note tabs (Obsidian-style): click to switch, × or ⌘W to close, dot = unsaved. As wide as
/// their titles; they scroll once they no longer fit.
struct TabStrip: View {
  let workspace: Workspace

  var body: some View {
    ViewThatFits(in: .horizontal) {
      tabs.fixedSize(horizontal: true, vertical: false)
      ScrollViewReader { proxy in
        ScrollView(.horizontal, showsIndicators: false) { tabs }
          .onAppear { reveal(workspace.tabs.active, proxy) }
          .onChange(of: workspace.tabs.active) { _, active in
            withAnimation(.easeOut(duration: 0.15)) { reveal(active, proxy) }
          }
      }
    }
    .frame(maxWidth: .infinity, alignment: .leading)
  }

  private var tabs: some View {
    HStack(spacing: 2) {
      ForEach(workspace.tabs.tabs, id: \.self) { path in
        TabItem(
          workspace: workspace, path: path, isActive: workspace.tabs.active == path,
          saveState: workspace.notes.saveStates[path]
        )
        .id(path)
      }
    }
  }

  private func reveal(_ path: String?, _ proxy: ScrollViewProxy) {
    if let path { proxy.scrollTo(path) }
  }
}

private struct TabItem: View {
  let workspace: Workspace
  let path: String
  let isActive: Bool
  let saveState: SaveState?
  @State private var hovering = false

  var body: some View {
    HStack(spacing: 4) {
      Text(VaultPath.stem(path))
        .font(.system(size: 12, weight: isActive ? .medium : .regular))
        .foregroundStyle(isActive ? Theme.text : Theme.mutedText)
        .lineLimit(1)
        .truncationMode(.middle)
      ZStack {
        if hovering || isActive {
          Button {
            workspace.closeTab(path)
          } label: {
            Image(systemName: "xmark")
              .font(.system(size: 8, weight: .bold))
              .foregroundStyle(Theme.faintText)
              .frame(width: 16, height: 16)
              .contentShape(Rectangle())
          }
          .buttonStyle(.plain)
          .help("Close tab (⌘W)")
        } else if saveState?.hasUnsavedChanges == true {
          Circle().fill(saveState == .conflict ? Theme.warning : Theme.mutedText).frame(
            width: 6, height: 6)
        }
      }
      .frame(width: 16)
    }
    .padding(.leading, 10)
    .padding(.trailing, 5)
    .frame(minWidth: 90, maxWidth: 200, minHeight: 28, maxHeight: 28)
    .background(
      RoundedRectangle(cornerRadius: 6)
        .fill(isActive ? Theme.selectedTab : (hovering ? Theme.hover : .clear))
    )
    .contentShape(Rectangle())
    .onTapGesture { workspace.activateTab(path) }
    .onHover { hovering = $0 }
    .help(path)
    .contextMenu {
      Button("Close Tab") { workspace.closeTab(path) }
      Button("Close Other Tabs") { workspace.closeOtherTabs(except: path) }
      Divider()
      Button("Copy Path") {
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(path, forType: .string)
      }
      if workspace.localVaultURL != nil {
        Button("Reveal in Finder") { workspace.revealInFinder(path) }
      }
    }
    .accessibilityElement(children: .combine)
    .accessibilityAddTraits(isActive ? [.isSelected, .isButton] : .isButton)
  }
}
