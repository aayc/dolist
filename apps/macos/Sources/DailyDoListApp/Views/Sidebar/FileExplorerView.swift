import DailyDoListDomain
import DailyDoListModels
import SwiftUI

/// The vault tree: folders first, natural order, selection follows the active note. Click a
/// folder to expand it; context menus for new note/folder, inline rename, delete and Finder.
struct FileExplorerView: View {
  let workspace: Workspace
  @Bindable var ui: UIState

  private var rows: [VaultTreeRow] {
    VaultTree.visibleRows(workspace.vault.tree, expanded: ui.expandedFolders)
  }

  var body: some View {
    let rows = self.rows
    ScrollViewReader { proxy in
      list(rows)
        .onChange(of: workspace.tabs.active) { _, active in
          guard let active else { return }
          DispatchQueue.main.async { proxy.scrollTo(active) }
        }
    }
  }

  private func list(_ rows: [VaultTreeRow]) -> some View {
    List(selection: selection) {
      ForEach(rows) { row in
        ExplorerRowView(workspace: workspace, ui: ui, row: row)
          .tag(row.id)
          .id(row.id)
      }
    }
    .listStyle(.sidebar)
    .contextMenu(forSelectionType: String.self) { paths in
      menu(for: paths.first)
    } primaryAction: { paths in
      guard let path = paths.first, workspace.vault.isFile(path) else { return }
      Task { await workspace.openNote(path, OpenOptions(newTab: true)) }
    }
    .overlay {
      if workspace.vault.isLoaded, rows.isEmpty {
        Text("No notes yet").foregroundStyle(Theme.faintText)
      }
    }
  }

  /// Selection mirrors the active note; picking a file opens it, picking a folder toggles it.
  private var selection: Binding<String?> {
    Binding(
      get: { workspace.tabs.active },
      set: { path in
        guard let path else { return }
        if workspace.vault.isFolder(path) {
          ui.setExpanded(path, !ui.expandedFolders.contains(path))
        } else if path != workspace.tabs.active {
          Task { await workspace.openNote(path) }
        }
      })
  }

  @ViewBuilder
  private func menu(for path: String?) -> some View {
    let folder = path.map { workspace.vault.isFolder($0) ? $0 : VaultPath.dirname($0) } ?? ""
    Button("New Note") { Task { await workspace.createNote(in: folder) } }
    Button("New Folder") { Task { await workspace.createFolder(in: folder) } }
    if let path {
      Divider()
      if workspace.vault.isFile(path) {
        Button("Open in New Tab") { Task { await workspace.openNote(path, OpenOptions(newTab: true)) } }
      }
      Button("Rename…") { ui.renamingPath = path }
      Button("Delete…", role: .destructive) { workspace.requestDelete(path) }
      Divider()
      Button("Copy Path") {
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(path, forType: .string)
      }
      if workspace.localVaultURL != nil {
        Button("Reveal in Finder") { workspace.revealInFinder(path) }
      }
    }
    Divider()
    Button("Collapse All Folders") { ui.expandedFolders = [] }
      .disabled(ui.expandedFolders.isEmpty)
  }
}

/// One explorer row: indentation, disclosure chevron, icon and name (or the inline rename field).
struct ExplorerRowView: View {
  let workspace: Workspace
  @Bindable var ui: UIState
  let row: VaultTreeRow

  private var isFolder: Bool { row.kind == .folder }

  var body: some View {
    HStack(spacing: 4) {
      Color.clear.frame(width: CGFloat(row.depth) * 14, height: 1)
      if isFolder {
        Image(systemName: "chevron.right")
          .font(.system(size: 9, weight: .semibold))
          .foregroundStyle(Theme.faintText)
          .rotationEffect(.degrees(row.isExpanded ? 90 : 0))
          .frame(width: 12)
          .contentShape(Rectangle())
          .onTapGesture { ui.setExpanded(row.path, !row.isExpanded) }
      } else {
        Color.clear.frame(width: 12, height: 1)
      }
      Image(systemName: icon)
        .font(.system(size: 12))
        .foregroundStyle(isFolder ? Theme.mutedText : Theme.faintText)
        .frame(width: 16)
      if ui.renamingPath == row.path {
        InlineRenameField(initial: row.name) { name in
          ui.renamingPath = nil
          guard let name, name != row.name else { return }
          Task { await workspace.renameEntry(row.path, to: name) }
        }
      } else {
        Text(row.name)
          .lineLimit(1)
          .truncationMode(.middle)
      }
    }
    .font(.system(size: 13))
    .help(row.path)
  }

  private var icon: String {
    if isFolder { return "folder" }
    if DailyNotes.isDailyNote(row.path, settings: workspace.settings.settings.dailyNotes) { return "calendar" }
    return VaultPath.isMarkdown(row.path) ? "doc.text" : "doc"
  }
}

/// Text field that commits on Return or focus loss and cancels on Escape (nil).
struct InlineRenameField: View {
  let initial: String
  let onFinish: (String?) -> Void
  @State private var text: String
  @State private var finished = false
  @FocusState private var focused: Bool

  init(initial: String, onFinish: @escaping (String?) -> Void) {
    self.initial = initial
    self.onFinish = onFinish
    _text = State(initialValue: initial)
  }

  var body: some View {
    TextField("Name", text: $text)
      .textFieldStyle(.plain)
      .focused($focused)
      .onSubmit { finish(text) }
      .onExitCommand { finish(nil) }
      .onChange(of: focused) { _, isFocused in
        if !isFocused { finish(text) }
      }
      .onAppear { DispatchQueue.main.async { focused = true } }
  }

  private func finish(_ value: String?) {
    guard !finished else { return }
    finished = true
    let trimmed = value?.trimmingCharacters(in: .whitespacesAndNewlines)
    onFinish(trimmed?.isEmpty == false ? trimmed : nil)
  }
}
