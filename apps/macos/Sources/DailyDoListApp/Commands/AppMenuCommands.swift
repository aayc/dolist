import SwiftUI

/// The menu bar: File, Edit (standard + Find), View, Go and Agent menus built from the
/// ``CommandCatalog``.
struct AppMenuCommands: Commands {
  let model: AppModel

  var body: some Commands {
    let commands = Dictionary(
      uniqueKeysWithValues: CommandCatalog(model: model).all.map { ($0.id, $0) })
    let item = { (id: CommandID) in MenuItem(command: commands[id]) }

    CommandGroup(replacing: .newItem) {
      item(.newNote)
      item(.newFolder)
      Divider()
      item(.todaysNote)
      item(.previousDaily)
      item(.nextDaily)
      item(.tomorrowsNote)
      item(.weeklyNote)
      Divider()
      item(.quickOpen)
    }
    CommandGroup(replacing: .saveItem) {
      item(.save)
      item(.renameNote)
      item(.deleteNote)
      item(.revealNote)
      Divider()
      item(.closeTab)
      item(.reopenTab)
    }
    CommandGroup(replacing: .printItem) {}
    TextEditingCommands()
    CommandGroup(before: .toolbar) {
      item(.toggleSidebar)
      item(.toggleAgentPanel)
      item(.agentInbox)
      item(.search)
      item(.commandPalette)
      Divider()
      item(.toggleLivePreview)
      item(.toggleReadableWidth)
      item(.toggleLineNumbers)
      item(.toggleVim)
      Divider()
      item(.increaseFontSize)
      item(.decreaseFontSize)
      item(.resetFontSize)
      item(.toggleTheme)
      Divider()
    }
    CommandMenu("Go") {
      item(.back)
      item(.forward)
      Divider()
      item(.nextTab)
      item(.previousTab)
      Divider()
      ForEach(CommandID.tabs, id: \.self) { item($0) }
    }
    CommandMenu("Agent") {
      item(.toggleAgent)
      item(.openInbox)
      Divider()
      item(.restartDaemon)
    }
  }
}

/// One catalog command as a menu item.
///
/// SwiftUI refreshes menu items' enabled state only when a menu is opened, and key equivalents
/// are dispatched against that (possibly stale) state — a stale "disabled" swallows the shortcut.
/// So items with a shortcut are never disabled; their actions check availability when they run.
private struct MenuItem: View {
  let command: AppCommand?

  var body: some View {
    if let command {
      if command.isOn != nil {
        Toggle(
          command.title,
          isOn: Binding(get: { command.isOn?() ?? false }, set: { _ in command.run() })
        )
        .disabled(!command.isEnabled())
      } else if let shortcut = command.shortcut?.keyboardShortcut {
        Button(command.title) { command.run() }
          .keyboardShortcut(shortcut)
      } else {
        Button(command.title) { command.run() }
          .disabled(!command.isEnabled())
      }
    }
  }
}
