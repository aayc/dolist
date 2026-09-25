import DailyDoListDomain
import SwiftUI

/// Root of the main window: the boot screen until a daemon is connected, then the workspace.
struct MainWindowView: View {
  let model: AppModel
  @Environment(\.openWindow) private var openWindow
  @Environment(\.openSettings) private var openSettings

  var body: some View {
    Group {
      if model.phase == .ready, let workspace = model.workspace {
        WorkspaceView(model: model, workspace: workspace, ui: model.ui)
      } else {
        BootScreen(model: model)
      }
    }
    .frame(minWidth: 720, maxWidth: .infinity, minHeight: 440, maxHeight: .infinity)
    .tint(Theme.accent)
    .background(
      WindowAccessor { window in
        WindowHandles.shared.mainWindow = window
        window.tabbingMode = .disallowed
        WindowChrome.centerTrafficLights(in: window)
        WindowHandles.shared.fullScreen.observe(window) { model.ui.isFullScreen = $0 }
      }
    )
    .onAppear {
      WindowHandles.shared.openMainWindow = { openWindow(id: MainWindowID.value) }
      WindowHandles.shared.openSettings = { openSettings() }
      WindowHandles.shared.openOrchestratorWindow = { openWindow(id: OrchestratorWindowID.value) }
      model.start()
      model.resumeComputerAccessSetup()
    }
  }
}

/// The connected window, edge to edge under the hidden title bar: sidebar | tabs + note + status
/// | agent panel. Every pane starts with a ``Theme/headerHeight`` row, so their bottom lines meet.
struct WorkspaceView: View {
  let model: AppModel
  let workspace: Workspace
  @Bindable var ui: UIState
  /// The pane being resized and its width so far (committed to `ui` on mouse-up).
  @State private var resizing: (pane: Pane, start: CGFloat, width: CGFloat)?

  enum Pane { case sidebar, inspector }

  var body: some View {
    GeometryReader { proxy in
      let total = proxy.size.width
      let widths = PaneLayout.fit(
        total: total,
        sidebar: ui.sidebarVisible ? width(of: .sidebar) : nil,
        inspector: ui.inspectorPresented ? width(of: .inspector) : nil)
      HStack(spacing: 0) {
        if let sidebar = widths.sidebar {
          SidebarView(workspace: workspace, ui: ui)
            .frame(width: sidebar)
            .transition(.move(edge: .leading))
          Hairline(axis: .vertical)
        }
        DetailColumn(model: model, workspace: workspace, ui: ui)
          .frame(maxWidth: .infinity)
        if let inspector = widths.inspector {
          Hairline(axis: .vertical)
          InspectorPanel(model: model, workspace: workspace, ui: ui)
            .frame(width: inspector)
            .transition(.move(edge: .trailing))
        }
      }
      .overlay(alignment: .topLeading) {
        if let sidebar = widths.sidebar {
          resizeHandle(.sidebar, at: sidebar, total: total, otherPane: widths.inspector)
        }
        if let inspector = widths.inspector {
          resizeHandle(.inspector, at: total - inspector, total: total, otherPane: widths.sidebar)
        }
      }
    }
    .foregroundStyle(Theme.text)
    .animation(.snappy(duration: 0.2), value: ui.sidebarVisible)
    .animation(.snappy(duration: 0.2), value: ui.inspectorPresented)
    .ignoresSafeArea(.container, edges: .top)
    .navigationTitle(windowTitle)
    .frame(minWidth: minimumWidth, maxWidth: .infinity, minHeight: 440, maxHeight: .infinity)
    .overlay {
      if let mode = ui.palette {
        PaletteOverlay(model: model, workspace: workspace, mode: mode)
          .id(mode)
      }
    }
    .overlay(alignment: .bottomTrailing) {
      ToastOverlay(toasts: model.toasts)
        .padding(.bottom, Theme.statusBarHeight + 8)
        .padding(.trailing, 12)
    }
    .alert(
      "Delete “\(ui.pendingDeletion?.name ?? "")”?",
      isPresented: deletionBinding, presenting: ui.pendingDeletion
    ) { deletion in
      Button("Delete", role: .destructive) {
        Task { await workspace.deletePath(deletion.path) }
      }
      Button("Cancel", role: .cancel) {}
    } message: { deletion in
      Text(
        deletion.isFolder
          ? "The folder and everything in it will be moved to the vault's trash (.trash)."
          : "The note will be moved to the vault's trash (.trash).")
    }
  }

  private var windowTitle: String {
    guard let path = workspace.tabs.active else { return "Daily Do List" }
    return VaultPath.stem(path)
  }

  private var minimumWidth: CGFloat {
    max(
      720,
      PaneLayout.minimumWindowWidth(sidebar: ui.sidebarVisible, inspector: ui.inspectorPresented))
  }

  private var deletionBinding: Binding<Bool> {
    Binding(get: { ui.pendingDeletion != nil }, set: { if !$0 { ui.pendingDeletion = nil } })
  }

  private func width(of pane: Pane) -> CGFloat {
    if let resizing, resizing.pane == pane { return resizing.width }
    return pane == .sidebar ? ui.sidebarWidth : ui.inspectorWidth
  }

  /// An invisible strip over the line at `x` that drags the pane's edge.
  private func resizeHandle(_ pane: Pane, at x: CGFloat, total: CGFloat, otherPane: CGFloat?)
    -> some View
  {
    let range = pane == .sidebar ? PaneLayout.sidebarRange : PaneLayout.inspectorRange
    return PaneResizeHandle(
      onBegin: {
        let start = pane == .sidebar ? ui.sidebarWidth : ui.inspectorWidth
        resizing = (pane, start, start)
      },
      onDrag: { delta in
        guard let current = resizing, current.pane == pane else { return }
        let proposed = pane == .sidebar ? current.start + delta : current.start - delta
        resizing?.width = PaneLayout.dragged(
          proposed, range: range, total: total, otherPane: otherPane)
      },
      onEnd: {
        guard let current = resizing, current.pane == pane else { return }
        if pane == .sidebar {
          ui.sidebarWidth = current.width
        } else {
          ui.inspectorWidth = current.width
        }
        resizing = nil
      },
      onReset: {
        if pane == .sidebar {
          ui.sidebarWidth = PaneLayout.sidebarDefault
        } else {
          ui.inspectorWidth = PaneLayout.inspectorDefault
        }
      }
    )
    .frame(width: 8)
    .frame(maxHeight: .infinity)
    .offset(x: x - 4)
  }
}

/// Tabs, the note header + editor (or the empty state), and the status line.
struct DetailColumn: View {
  let model: AppModel
  let workspace: Workspace
  @Bindable var ui: UIState

  var body: some View {
    VStack(spacing: 0) {
      EditorHeader(model: model, workspace: workspace, ui: ui)
      if model.connection.showsOfflineBanner {
        OfflineBanner(model: model)
      }
      if let banner = model.computerAccessBanner {
        ComputerAccessBanner(model: model, kind: banner)
          .transition(.move(edge: .top).combined(with: .opacity))
      }
      ZStack {
        VStack(spacing: 0) {
          if let path = workspace.tabs.active {
            NoteHeaderView(workspace: workspace, path: path)
              .id(path)
          }
          EditorPane(controller: workspace.editor.controller)
        }
        .opacity(workspace.tabs.active == nil ? 0 : 1)
        if workspace.tabs.active == nil {
          EmptyNoteView(workspace: workspace)
        }
      }
      StatusBar(model: model, workspace: workspace)
    }
    .background(Theme.background)
    .animation(.snappy(duration: 0.22), value: model.computerAccessBanner)
  }
}

/// Captures the hosting `NSWindow`.
struct WindowAccessor: NSViewRepresentable {
  let onWindow: @MainActor (NSWindow) -> Void

  func makeNSView(context: Context) -> NSView {
    let view = TrackingView()
    view.onWindow = onWindow
    return view
  }

  func updateNSView(_ nsView: NSView, context: Context) {}

  final class TrackingView: NSView {
    var onWindow: (@MainActor (NSWindow) -> Void)?

    override func viewDidMoveToWindow() {
      super.viewDidMoveToWindow()
      if let window { onWindow?(window) }
    }
  }
}
