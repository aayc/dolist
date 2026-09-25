import DailyDoListEditor
import DailyDoListUI
import SwiftUI

/// Hosts the window's single native editor (one `MarkdownEditorController` for every note).
struct EditorPane: View {
  let controller: MarkdownEditorController

  var body: some View {
    MarkdownEditorView(controller: controller)
      .frame(maxWidth: .infinity, maxHeight: .infinity)
      .accessibilityLabel("Note editor")
  }
}

/// Shown when no tab is open.
struct EmptyNoteView: View {
  let workspace: Workspace

  var body: some View {
    VStack(spacing: 14) {
      Image(systemName: "checklist")
        .font(.system(size: 36, weight: .light))
        .foregroundStyle(Theme.faintText)
      Text("No note open")
        .font(.title3.weight(.semibold))
        .foregroundStyle(Theme.mutedText)
      VStack(alignment: .leading, spacing: 2) {
        action("Open today's note", .todaysNote) { await workspace.openToday() }
        action("Create a new note", .newNote) { await workspace.createNote() }
        action("Quick open…", .quickOpen) { workspace.ui.palette = .switcher }
      }
    }
    .frame(maxWidth: .infinity, maxHeight: .infinity)
    .background(Theme.background)
  }

  /// A row with its shortcut as keycaps (no tooltip: the keys are right there).
  private func action(
    _ title: String, _ command: CommandID, _ run: @escaping @MainActor () async -> Void
  ) -> some View {
    Button {
      Task { await run() }
    } label: {
      HStack {
        Text(title).foregroundStyle(Theme.accent)
        Spacer(minLength: 24)
        CommandKeycaps(command: command)
      }
      .frame(width: 240)
      .font(.system(size: 13))
    }
    .buttonStyle(ChromeButtonStyle(horizontalPadding: 8, verticalPadding: 5))
  }
}
