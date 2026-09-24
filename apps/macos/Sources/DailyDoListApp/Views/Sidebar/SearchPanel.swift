import DailyDoListModels
import SwiftUI

/// Vault search: results grouped by note; name hits vs content hits with 1-based line labels.
/// Clicking a hit opens the note at that line (⌘-click: new tab).
struct SearchPanel: View {
  let workspace: Workspace
  @Bindable var search: SearchModel
  @Bindable var ui: UIState
  @FocusState private var fieldFocused: Bool

  var body: some View {
    VStack(spacing: 0) {
      HStack(spacing: 6) {
        Image(systemName: "magnifyingglass").foregroundStyle(Theme.faintText)
        TextField("Search the vault…", text: $search.query)
          .textFieldStyle(.plain)
          .focused($fieldFocused)
          .onSubmit { Task { await search.runNow() } }
          .onExitCommand { ui.sidebarMode = .files }
        if search.isLoading {
          ProgressView().controlSize(.mini)
        } else if !search.query.isEmpty {
          Button {
            search.query = ""
          } label: {
            Image(systemName: "xmark.circle.fill").foregroundStyle(Theme.faintText)
          }
          .buttonStyle(.plain)
          .help("Clear")
        }
      }
      .padding(.horizontal, 8)
      .frame(height: 28)
      .background(Theme.background, in: RoundedRectangle(cornerRadius: 6))
      .overlay(RoundedRectangle(cornerRadius: 6).strokeBorder(Theme.separator))
      .padding(8)

      if let error = search.error {
        Text(error).font(.caption).foregroundStyle(Theme.danger).padding(.horizontal, 10)
      } else if !search.trimmedQuery.isEmpty, !search.isLoading {
        Text("\(TextMetrics.pluralize(search.hitCount, "result")) in \(TextMetrics.pluralize(search.groups.count, "note"))")
          .font(.caption)
          .foregroundStyle(Theme.faintText)
          .frame(maxWidth: .infinity, alignment: .leading)
          .padding(.horizontal, 12)
      }

      List {
        ForEach(search.groups) { group in
          Section {
            ForEach(Array(group.hits.enumerated()), id: \.offset) { _, hit in
              SearchHitRow(hit: hit, query: search.trimmedQuery)
                .contentShape(Rectangle())
                .onTapGesture { open(hit) }
            }
          } header: {
            Button {
              Task { await workspace.openNote(group.path, OpenOptions(newTab: NSEvent.modifierFlags.contains(.command))) }
            } label: {
              HStack(spacing: 6) {
                Text(group.title).font(.system(size: 12, weight: .semibold)).foregroundStyle(Theme.text)
                if !group.folder.isEmpty {
                  Text(group.folder).font(.system(size: 11)).foregroundStyle(Theme.faintText).lineLimit(1)
                }
              }
            }
            .buttonStyle(.plain)
          }
        }
      }
      .listStyle(.sidebar)
    }
    .onAppear { fieldFocused = true }
    .onChange(of: ui.searchFocusToken) { _, _ in fieldFocused = true }
  }

  private func open(_ hit: SearchHit) {
    let newTab = NSEvent.modifierFlags.contains(.command)
    Task {
      await workspace.openNote(hit.path, OpenOptions(newTab: newTab, line: hit.kind == .content ? hit.line : nil))
    }
  }
}

private struct SearchHitRow: View {
  let hit: SearchHit
  let query: String

  var body: some View {
    HStack(alignment: .firstTextBaseline, spacing: 8) {
      Text(SearchGroup.lineLabel(for: hit))
        .font(.system(size: 10, design: .monospaced))
        .foregroundStyle(Theme.faintText)
        .frame(minWidth: 22, alignment: .trailing)
      Text(highlighted)
        .font(.system(size: 12))
        .lineLimit(2)
    }
    .help(hit.kind == .name ? "Name match" : "Line \(hit.line + 1)")
  }

  private var highlighted: AttributedString {
    var text = AttributedString(hit.preview)
    for term in query.split(whereSeparator: \.isWhitespace) where !term.isEmpty {
      var searchStart = text.startIndex
      while let range = text[searchStart...].range(of: String(term), options: .caseInsensitive) {
        text[range].backgroundColor = Theme.warning.opacity(0.28)
        text[range].foregroundColor = Theme.text
        searchStart = range.upperBound
      }
    }
    return text
  }
}
