import SwiftUI

/// Floating prompt over the window: ⌘P command palette or ⌘O quick switcher (Obsidian-style).
struct PaletteOverlay: View {
  let model: AppModel
  let workspace: Workspace
  @State private var palette: PaletteModel

  init(model: AppModel, workspace: Workspace, mode: PaletteMode) {
    self.model = model
    self.workspace = workspace
    _palette = State(
      initialValue: PaletteModel(
        mode: mode, commands: CommandCatalog(model: model).paletteCommands, files: workspace.vault.files,
        recent: workspace.recent, openTabs: workspace.tabs.tabs))
  }

  var body: some View {
    ZStack(alignment: .top) {
      Color.black.opacity(0.14)
        .ignoresSafeArea()
        .onTapGesture { close() }
      PalettePanel(palette: palette, onKey: handle, onChoose: choose)
        .padding(.top, 56)
    }
    .transition(.opacity)
  }

  private func handle(_ key: PaletteKey) {
    switch key {
    case .up: palette.moveSelection(by: -1)
    case .down: palette.moveSelection(by: 1)
    case .cancel: close()
    case .submit(let command, let shift):
      if command, let name = palette.creatableName {
        close()
        Task { await workspace.createNote(name: name) }
      } else if let item = palette.selectedItem {
        choose(item, newTab: shift || command)
      }
    }
  }

  private func choose(_ item: PaletteItem, newTab: Bool) {
    let command = palette.command(for: item)
    close()
    switch item.kind {
    case .command:
      command?.run()
    case .note(let path):
      Task { await workspace.openNote(path, OpenOptions(newTab: newTab)) }
    }
  }

  private func close() {
    model.ui.palette = nil
    workspace.editor.focus()
  }
}

/// The prompt card: search field, results, key hints.
struct PalettePanel: View {
  let palette: PaletteModel
  let onKey: (PaletteKey) -> Void
  let onChoose: (PaletteItem, Bool) -> Void

  var body: some View {
    VStack(spacing: 0) {
      PaletteSearchField(text: Binding(get: { palette.query }, set: { palette.query = $0 }), placeholder: palette.placeholder, onKey: onKey)
        .frame(height: 24)
        .padding(.horizontal, 14)
        .padding(.vertical, 12)
      Divider()
      results
      Divider()
      footer
    }
    .frame(width: 580)
    .background(Theme.elevated, in: RoundedRectangle(cornerRadius: 12))
    .overlay(RoundedRectangle(cornerRadius: 12).strokeBorder(Theme.border))
    .shadow(color: .black.opacity(0.25), radius: 24, y: 10)
    .accessibilityElement(children: .contain)
    .accessibilityLabel(palette.mode == .commands ? "Command palette" : "Quick switcher")
  }

  private var results: some View {
    ScrollViewReader { proxy in
      ScrollView {
        LazyVStack(spacing: 0) {
          if palette.items.isEmpty {
            Text(emptyText)
              .font(.system(size: 13))
              .foregroundStyle(Theme.faintText)
              .frame(maxWidth: .infinity, alignment: .leading)
              .padding(14)
          }
          ForEach(Array(palette.items.enumerated()), id: \.element.id) { index, item in
            PaletteRow(item: item, isSelected: index == palette.selectedIndex)
              .id(item.id)
              .contentShape(Rectangle())
              .onTapGesture { onChoose(item, NSEvent.modifierFlags.contains(.command)) }
              .onHover { if $0 { palette.select(index) } }
          }
        }
        .padding(.vertical, 6)
      }
      .frame(maxHeight: 360)
      .fixedSize(horizontal: false, vertical: palette.items.count < 9)
      .onChange(of: palette.selectedIndex) { _, _ in
        if let id = palette.selectedItem?.id { proxy.scrollTo(id) }
      }
    }
  }

  private var emptyText: String {
    if palette.mode == .switcher, let name = palette.creatableName {
      return "No notes found. Press ⌘↩ to create “\(name)”."
    }
    return palette.mode == .commands ? "No matching commands" : "No notes yet"
  }

  private var footer: some View {
    HStack(spacing: 14) {
      hint("↑↓", "navigate")
      hint("↩", palette.mode == .commands ? "run" : "open")
      if palette.mode == .switcher {
        hint("⇧↩", "new tab")
        hint("⌘↩", "create")
      }
      hint("esc", "close")
      Spacer()
    }
    .font(.system(size: 11))
    .foregroundStyle(Theme.faintText)
    .padding(.horizontal, 14)
    .padding(.vertical, 8)
  }

  private func hint(_ key: String, _ label: String) -> some View {
    HStack(spacing: 4) {
      Text(key).font(.system(size: 10, weight: .semibold, design: .rounded))
        .padding(.horizontal, 4).padding(.vertical, 1)
        .background(Theme.hover, in: RoundedRectangle(cornerRadius: 3))
      Text(label)
    }
  }
}

private struct PaletteRow: View {
  let item: PaletteItem
  let isSelected: Bool

  var body: some View {
    HStack(spacing: 10) {
      Image(systemName: icon)
        .font(.system(size: 12))
        .foregroundStyle(Theme.faintText)
        .frame(width: 16)
      Text(HighlightedText.attributed(item.title, highlights: item.highlights))
        .font(.system(size: 13))
        .lineLimit(1)
      if let subtitle = item.subtitle {
        Text(subtitle)
          .font(.system(size: 12))
          .foregroundStyle(Theme.faintText)
          .lineLimit(1)
          .truncationMode(.head)
      }
      Spacer(minLength: 8)
      if let shortcut = item.shortcut {
        Text(shortcut)
          .font(.system(size: 11, weight: .medium, design: .rounded))
          .foregroundStyle(Theme.mutedText)
          .padding(.horizontal, 6).padding(.vertical, 2)
          .background(Theme.hover, in: RoundedRectangle(cornerRadius: 4))
      }
    }
    .padding(.horizontal, 12)
    .frame(height: 30)
    .background(
      RoundedRectangle(cornerRadius: 6)
        .fill(isSelected ? Theme.accentSoft : .clear)
        .padding(.horizontal, 6))
  }

  private var icon: String {
    switch item.kind {
    case .command: "command"
    case .note: "doc.text"
    }
  }
}

/// Bold, accent-colored matched characters (UTF-16 offsets from the fuzzy matcher).
enum HighlightedText {
  static func attributed(_ text: String, highlights: [Int]) -> AttributedString {
    var result = AttributedString(text)
    guard !highlights.isEmpty else { return result }
    let length = text.utf16.count
    for offset in Set(highlights) where offset >= 0 && offset < length {
      let utf16Index = String.Index(utf16Offset: offset, in: text)
      guard let start = utf16Index.samePosition(in: text) else { continue }
      let end = text.index(after: start)
      guard let lower = AttributedString.Index(start, within: result),
        let upper = AttributedString.Index(end, within: result)
      else { continue }
      result[lower..<upper].foregroundColor = Theme.accent
      result[lower..<upper].font = .system(size: 13, weight: .semibold)
    }
    return result
  }
}
