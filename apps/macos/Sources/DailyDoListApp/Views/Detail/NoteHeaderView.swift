import DailyDoListDomain
import SwiftUI

/// Above the editor: the folder breadcrumb, the inline-renamable title and, for daily notes, the
/// date navigator. Keyed by path by its parent so edits reset on note switch.
struct NoteHeaderView: View {
  let workspace: Workspace
  let path: String

  var body: some View {
    VStack(alignment: .leading, spacing: 6) {
      if let date = DailyNotes.date(forPath: path, settings: workspace.settings.settings.dailyNotes) {
        DailyHeaderView(workspace: workspace, path: path, date: date)
      } else if !VaultPath.dirname(path).isEmpty {
        Text(VaultPath.dirname(path).split(separator: "/").joined(separator: " / "))
          .font(.system(size: 11))
          .foregroundStyle(Theme.faintText)
      }
      NoteTitleField(workspace: workspace, path: path)
    }
    .lineLimit(1)
    .frame(maxWidth: workspace.settings.settings.editor.readableLineLength ? Theme.readableWidth : .infinity, alignment: .leading)
    .frame(maxWidth: .infinity)
    .padding(.horizontal, 28)
    .padding(.top, 16)
    .padding(.bottom, 4)
  }
}

/// The file stem as an editable title: Return or focus loss renames, Escape reverts.
struct NoteTitleField: View {
  let workspace: Workspace
  let path: String
  @State private var draft: String
  @State private var committing = false
  @FocusState private var focused: Bool

  init(workspace: Workspace, path: String) {
    self.workspace = workspace
    self.path = path
    _draft = State(initialValue: VaultPath.stem(path))
  }

  var body: some View {
    TextField("Untitled", text: $draft)
      .textFieldStyle(.plain)
      .font(.system(size: 26, weight: .bold))
      .foregroundStyle(Theme.text)
      .focused($focused)
      .onSubmit {
        commit()
        workspace.editor.focus()
      }
      .onExitCommand {
        draft = VaultPath.stem(path)
        workspace.editor.focus()
      }
      .onChange(of: focused) { _, isFocused in
        if !isFocused { commit() }
      }
      .onAppear(perform: takeFocusIfRequested)
      .onChange(of: workspace.ui.titleFocusPath) { _, _ in takeFocusIfRequested() }
      .accessibilityLabel("Note title")
  }

  private func takeFocusIfRequested() {
    guard workspace.ui.titleFocusPath == path else { return }
    workspace.ui.titleFocusPath = nil
    focused = true
  }

  private func commit() {
    let original = VaultPath.stem(path)
    let next = draft.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !committing, !next.isEmpty, next != original else {
      if next.isEmpty { draft = original }
      return
    }
    committing = true
    Task {
      let ok = await workspace.renameNoteTitle(path, to: next)
      committing = false
      if !ok { draft = original }
    }
  }
}

/// "‹ Wednesday, September 23, 2026 ›  Today" — arrows go to the nearest EXISTING daily note.
struct DailyHeaderView: View {
  let workspace: Workspace
  let path: String
  let date: LocalDate

  var body: some View {
    let hasPrevious = workspace.adjacentDailyPath(.previous, from: path) != nil
    let hasNext = workspace.adjacentDailyPath(.next, from: path) != nil
    HStack(spacing: 4) {
      IconButton(systemImage: "chevron.left", help: "Previous daily note (⇧⌘P)", isEnabled: hasPrevious) {
        Task { await workspace.openAdjacentDaily(.previous) }
      }
      Text(DailyNotes.friendlyTitle(date))
        .font(.system(size: 13, weight: .medium))
        .foregroundStyle(Theme.mutedText)
      IconButton(systemImage: "chevron.right", help: "Next daily note (⇧⌘N)", isEnabled: hasNext) {
        Task { await workspace.openAdjacentDaily(.next) }
      }
      if date == workspace.today {
        Pill(text: "Today")
          .padding(.leading, 4)
      } else {
        Button("Go to today") { Task { await workspace.openToday() } }
          .buttonStyle(.link)
          .font(.system(size: 12))
          .padding(.leading, 4)
          .help("Open today's note (⇧⌘D)")
      }
    }
    .padding(.leading, -6)
  }
}
