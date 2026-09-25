import DailyDoListDomain
import DailyDoListUI
import SwiftUI

/// Above the editor. A daily note shows its date as the title with the date navigator below it;
/// any other note shows its folder breadcrumb and the inline-renamable title. Keyed by path by its
/// parent so edits reset on note switch.
struct NoteHeaderView: View {
  let workspace: Workspace
  let path: String

  var body: some View {
    VStack(alignment: .leading, spacing: 6) {
      if let date = DailyNotes.date(forPath: path, settings: workspace.settings.settings.dailyNotes)
      {
        DailyHeaderView(workspace: workspace, path: path, date: date)
      } else {
        if !VaultPath.dirname(path).isEmpty {
          Text(VaultPath.dirname(path).split(separator: "/").joined(separator: " / "))
            .font(.system(size: 11))
            .foregroundStyle(Theme.faintText)
        }
        NoteTitleField(workspace: workspace, path: path)
      }
    }
    .lineLimit(1)
    .frame(
      maxWidth: workspace.settings.settings.editor.readableLineLength
        ? Theme.readableWidth : .infinity, alignment: .leading
    )
    .frame(maxWidth: .infinity)
    .padding(.horizontal, 28)
    .padding(.top, 22)
    .padding(.bottom, 6)
  }
}

extension Font {
  /// A note's title: the editable file name, or a daily note's date.
  fileprivate static let noteTitle = Font.system(size: 26, weight: .bold)
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
      .font(.noteTitle)
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

/// A daily note's title is its date ("Thursday, September 24", with the year only when it isn't
/// this year's), not editable, with "‹ Today ›" at the end of the same row: ‹ › go to the nearest
/// EXISTING daily notes.
struct DailyHeaderView: View {
  let workspace: Workspace
  let path: String
  let date: LocalDate

  var body: some View {
    let today = workspace.today
    let title = DailyNotes.friendlyTitle(date, today: today)
    HStack(spacing: 12) {
      Text(title)
        .font(.noteTitle)
        .foregroundStyle(Theme.text)
        .accessibilityLabel("Note title")
        .accessibilityValue(title)
        .accessibilityAddTraits(.isHeader)
      Spacer(minLength: 0)
      DailyNavigationRow(workspace: workspace, path: path, isToday: date == today)
    }
  }
}

/// "‹ Today ›" beside a daily note's title: small, muted controls.
struct DailyNavigationRow: View {
  let workspace: Workspace
  let path: String
  let isToday: Bool

  var body: some View {
    let hasPrevious = workspace.adjacentDailyPath(.previous, from: path) != nil
    let hasNext = workspace.adjacentDailyPath(.next, from: path) != nil
    HStack(spacing: 2) {
      IconButton(
        "chevron.left", label: "Previous daily note", command: .previousDaily,
        isEnabled: hasPrevious, size: .compact
      ) {
        Task { await workspace.openAdjacentDaily(.previous) }
      }
      TodayButton(isToday: isToday) { Task { await workspace.openToday() } }
      IconButton(
        "chevron.right", label: "Next daily note", command: .nextDaily, isEnabled: hasNext,
        size: .compact
      ) {
        Task { await workspace.openAdjacentDaily(.next) }
      }
    }
  }
}

/// "Today" between the daily arrows: opens today's note, and rests (dimmed, saying why) while it's
/// open.
struct TodayButton: View {
  let isToday: Bool
  let action: () -> Void

  var body: some View {
    Button(action: action) {
      Text("Today")
        .font(.system(size: 11, weight: .medium))
        .frame(height: 20)
    }
    .buttonStyle(
      ChromeButtonStyle(
        horizontalPadding: 8, verticalPadding: 1, showsBorder: true, brightensLabel: true)
    )
    .tooltip("Open today's note", command: .todaysNote, whenDisabled: "Today's note is open")
    .disabled(isToday)
    .accessibilityLabel(isToday ? "Today" : "Go to today")
  }
}
