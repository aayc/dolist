import Foundation
import Observation

/// Which floating prompt is open over the window.
enum PaletteMode: Hashable, Sendable {
  /// ⌘P: every command.
  case commands
  /// ⌘O: find or create a note.
  case switcher
}

/// A deletion waiting for the user's confirmation.
struct PendingDeletion: Identifiable, Equatable {
  let path: String
  let isFolder: Bool
  var id: String { path }

  var name: String { NotePaths.displayName(path, isFolder: isFolder) }
}

/// Window layout and transient UI state (persisted parts go to ``AppPreferences``).
@MainActor
@Observable
final class UIState {
  @ObservationIgnored private let preferences: AppPreferences

  var sidebarVisible: Bool { didSet { preferences.sidebarVisible = sidebarVisible } }
  var sidebarMode: SidebarMode { didSet { preferences.sidebarMode = sidebarMode } }
  var inspectorPresented: Bool { didSet { preferences.inspectorVisible = inspectorPresented } }
  var sidebarWidth: CGFloat { didSet { preferences.sidebarWidth = sidebarWidth } }
  var inspectorWidth: CGFloat { didSet { preferences.inspectorWidth = inspectorWidth } }
  var expandedFolders: Set<String> { didSet { preferences.expandedFolders = expandedFolders } }
  /// The main window is in full screen, where it has no traffic lights to make room for.
  var isFullScreen = false
  /// The Settings window's pane, so the app can open Settings where a problem gets fixed.
  var settingsPane: SettingsPane = .general

  /// Thread shown in the agent panel; nil = the inbox.
  var selectedThreadId: String?
  var palette: PaletteMode?
  /// Explorer entry being renamed inline.
  var renamingPath: String?
  /// Note whose title field should take focus (e.g. a freshly created "Untitled").
  var titleFocusPath: String?
  /// Bumped to focus (and select) the search field.
  private(set) var searchFocusToken = 0
  var pendingDeletion: PendingDeletion?

  init(preferences: AppPreferences) {
    self.preferences = preferences
    sidebarVisible = preferences.sidebarVisible
    sidebarMode = preferences.sidebarMode
    inspectorPresented = preferences.inspectorVisible
    sidebarWidth = preferences.sidebarWidth
    inspectorWidth = preferences.inspectorWidth
    expandedFolders = preferences.expandedFolders
  }

  func toggleInspector() {
    inspectorPresented.toggle()
  }

  /// ⌘⇧A: the inbox in the agent panel (hides the panel if the inbox is already showing).
  func toggleInbox() {
    if inspectorPresented, selectedThreadId == nil {
      inspectorPresented = false
    } else {
      selectedThreadId = nil
      inspectorPresented = true
    }
  }

  func showInbox() {
    selectedThreadId = nil
    inspectorPresented = true
  }

  func showThread(_ threadId: String) {
    selectedThreadId = threadId
    inspectorPresented = true
  }

  func focusSearch() {
    sidebarVisible = true
    sidebarMode = .search
    searchFocusToken += 1
  }

  func togglePalette(_ mode: PaletteMode) {
    palette = palette == mode ? nil : mode
  }

  func expand(_ folders: some Sequence<String>) {
    let missing = Set(folders).subtracting(expandedFolders)
    if !missing.isEmpty { expandedFolders.formUnion(missing) }
  }

  func setExpanded(_ folder: String, _ expanded: Bool) {
    if expanded { expandedFolders.insert(folder) } else { expandedFolders.remove(folder) }
  }

  func renameExpandedFolders(from: String, to: String) {
    let moved = expandedFolders.compactMap { NotePaths.renamed($0, from: from, to: to) }
    guard !moved.isEmpty else { return }
    expandedFolders = Set(expandedFolders.filter { !NotePaths.isSameOrInside($0, from) }).union(moved)
  }
}
