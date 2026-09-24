import DailyDoListEditor
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
      VStack(alignment: .leading, spacing: 8) {
        action("Open today's note", shortcut: "⇧⌘D") { await workspace.openToday() }
        action("Create a new note", shortcut: "⌘N") { await workspace.createNote() }
        action("Quick open…", shortcut: "⌘O") { workspace.ui.palette = .switcher }
      }
    }
    .frame(maxWidth: .infinity, maxHeight: .infinity)
    .background(Theme.background)
  }

  private func action(
    _ title: String, shortcut: String, _ run: @escaping @MainActor () async -> Void
  ) -> some View {
    Button {
      Task { await run() }
    } label: {
      HStack {
        Text(title)
        Spacer(minLength: 24)
        Text(shortcut).foregroundStyle(Theme.faintText)
      }
      .frame(width: 240)
    }
    .buttonStyle(.link)
  }
}
