import DailyDoListDomain
import SwiftUI

/// Root of the main window: the boot screen until a daemon is connected, then the workspace.
struct MainWindowView: View {
  let model: AppModel
  @Environment(\.openWindow) private var openWindow

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
    .background(WindowAccessor { window in
      WindowHandles.shared.mainWindow = window
      window.tabbingMode = .disallowed
    })
    .onAppear {
      WindowHandles.shared.openMainWindow = { openWindow(id: MainWindowID.value) }
      model.start()
    }
  }
}

/// The connected window: sidebar | tabs + note + status bar | agent inspector.
struct WorkspaceView: View {
  let model: AppModel
  let workspace: Workspace
  @Bindable var ui: UIState

  var body: some View {
    NavigationSplitView(columnVisibility: sidebarVisibility) {
      SidebarView(workspace: workspace, ui: ui)
        .navigationSplitViewColumnWidth(min: 200, ideal: 250, max: 440)
    } detail: {
      DetailColumn(model: model, workspace: workspace)
        .toolbar { WorkspaceToolbar(model: model, workspace: workspace, ui: ui) }
        .inspector(isPresented: $ui.inspectorPresented) {
          InspectorPanel(model: model, workspace: workspace, ui: ui)
            .inspectorColumnWidth(min: 300, ideal: 340, max: 680)
        }
    }
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

  /// Sidebar, note and agent panel side by side need more room than the split view reports.
  private var minimumWidth: CGFloat {
    guard ui.inspectorPresented else { return 720 }
    return ui.sidebarVisible ? 1060 : 820
  }

  private var sidebarVisibility: Binding<NavigationSplitViewVisibility> {
    Binding(
      get: { ui.sidebarVisible ? .all : .detailOnly },
      set: { ui.sidebarVisible = $0 != .detailOnly })
  }

  private var deletionBinding: Binding<Bool> {
    Binding(get: { ui.pendingDeletion != nil }, set: { if !$0 { ui.pendingDeletion = nil } })
  }
}

/// Tabs, the note header + editor (or the empty state), and the status bar.
struct DetailColumn: View {
  let model: AppModel
  let workspace: Workspace

  var body: some View {
    VStack(spacing: 0) {
      if model.connection.showsOfflineBanner {
        OfflineBanner(model: model)
      }
      TabStrip(workspace: workspace)
      Divider()
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
      Divider()
      StatusBar(model: model, workspace: workspace)
    }
    .background(Theme.background)
  }
}

/// Back/forward and the agent panel toggle.
struct WorkspaceToolbar: ToolbarContent {
  let model: AppModel
  let workspace: Workspace
  @Bindable var ui: UIState

  var body: some ToolbarContent {
    ToolbarItemGroup(placement: .navigation) {
      Button {
        Task { await workspace.goBack() }
      } label: {
        Label("Back", systemImage: "chevron.left")
      }
      .help("Back (⌘[)")
      .disabled(!workspace.tabs.canGoBack)
      Button {
        Task { await workspace.goForward() }
      } label: {
        Label("Forward", systemImage: "chevron.right")
      }
      .help("Forward (⌘])")
      .disabled(!workspace.tabs.canGoForward)
    }
    ToolbarItem(placement: .automatic) {
      Button {
        ui.toggleInspector()
      } label: {
        Label("Agent Panel", systemImage: "sidebar.right")
      }
      .help("Toggle Agent Panel (⌘\\)")
    }
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
