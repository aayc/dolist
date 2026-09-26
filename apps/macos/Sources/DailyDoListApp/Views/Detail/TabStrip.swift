import DailyDoListAgent
import DailyDoListDomain
import DailyDoListUI
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
        IconButton("sidebar.left", label: "Show sidebar", command: .toggleSidebar) {
          ui.sidebarVisible = true
        }
      }
      IconButton(
        "chevron.left", label: "Back", command: .back, isEnabled: workspace.tabs.canGoBack
      ) {
        Task { await workspace.goBack() }
      }
      IconButton(
        "chevron.right", label: "Forward", command: .forward,
        isEnabled: workspace.tabs.canGoForward
      ) {
        Task { await workspace.goForward() }
      }
      TabStrip(workspace: workspace)
        .padding(.horizontal, 4)
      IconButton("plus", label: "New note", command: .newNote) {
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

/// Opens the agent panel; a dot (popping in) while approvals wait in it.
private struct AgentPanelToggle: View {
  let pending: Int
  let action: () -> Void
  @Environment(\.accessibilityReduceMotion) private var reduceMotion

  var body: some View {
    IconButton(
      "sidebar.right", label: "Show agent panel", command: .toggleAgentPanel,
      detail: pending > 0 ? AgentFormat.approvalsWaiting(pending) : nil, action: action
    )
    .overlay(alignment: .topTrailing) {
      if pending > 0 {
        Circle().fill(Theme.warning).frame(width: 6, height: 6).padding(5).allowsHitTesting(false)
          .countTransition()
      }
    }
    .animation(.countAppearance(reduceMotion: reduceMotion), value: pending > 0)
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
    let weight: NSFont.Weight = isActive ? .medium : .regular
    HStack(spacing: 0) {
      Text(VaultPath.stem(path))
        .font(.system(size: 12, weight: isActive ? .medium : .regular))
        .foregroundStyle(isActive ? Theme.text : Theme.mutedText)
        .lineLimit(1)
        .truncationMode(.middle)
        .tooltip(
          ifTruncated: VaultPath.stem(path), font: .systemFont(ofSize: 12, weight: weight),
          showing: .path(path))
      ZStack {
        if hovering || isActive {
          TabCloseButton(isActive: isActive) { workspace.closeTab(path) }
        } else if saveState?.hasUnsavedChanges == true {
          Circle().fill(saveState == .conflict ? Theme.warning : Theme.mutedText).frame(
            width: 6, height: 6)
        }
      }
      .frame(width: 24)
    }
    .padding(.leading, 10)
    .padding(.trailing, 1)
    .frame(minWidth: 90, maxWidth: 200, minHeight: 28, maxHeight: 28)
    .hoverHighlight(hovering, isSelected: isActive)
    .contentShape(Rectangle())
    .onTapGesture { workspace.activateTab(path) }
    .onHover { hovering = $0 }
    .pointingHandCursor()
    .contextMenu {
      Button("Close Tab") { workspace.closeTab(path) }
      Button("Close Other Tabs") { workspace.closeOtherTabs(except: path) }
      Divider()
      Button("Copy Path") { Clipboard.copy(path) }
      if workspace.localVaultURL != nil {
        Button("Reveal in Finder") { workspace.revealInFinder(path) }
      }
    }
    .accessibilityElement(children: .combine)
    .accessibilityAddTraits(isActive ? [.isSelected, .isButton] : .isButton)
  }
}

/// A tab's ×: a 24 pt target around the glyph. ⌘W closes the active tab, so only the active tab's
/// tooltip shows it.
private struct TabCloseButton: View {
  let isActive: Bool
  let action: () -> Void
  @State private var hovering = false

  var body: some View {
    Button(action: action) {
      Image(systemName: "xmark")
        .font(.system(size: 8, weight: .bold))
        .foregroundStyle(hovering ? Theme.text : Theme.faintText)
        .frame(width: 16, height: 16)
        .background(RoundedRectangle(cornerRadius: 4).fill(Theme.text.opacity(hovering ? 0.1 : 0)))
        .frame(width: 24, height: 24)
        .contentShape(Rectangle())
    }
    .buttonStyle(.plain)
    .onHover { hovering = $0 }
    .pointingHandCursor()
    .animation(.easeOut(duration: 0.11), value: hovering)
    .tooltip(
      "Close tab", keys: isActive ? CommandID.closeTab.shortcut : nil,
      command: isActive ? CommandID.closeTab.rawValue : nil, accessibility: .keysOnly
    )
    .accessibilityLabel("Close tab")
  }
}
