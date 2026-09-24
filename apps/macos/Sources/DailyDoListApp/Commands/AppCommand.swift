import SwiftUI

/// A menu/palette keyboard shortcut.
struct Shortcut: Hashable, Sendable {
  struct Modifiers: OptionSet, Hashable, Sendable {
    let rawValue: Int
    static let command = Modifiers(rawValue: 1 << 0)
    static let shift = Modifiers(rawValue: 1 << 1)
    static let option = Modifiers(rawValue: 1 << 2)
    static let control = Modifiers(rawValue: 1 << 3)
  }

  /// Printable key (lowercase letters) or `"\t"` for Tab.
  let key: Character
  let modifiers: Modifiers

  init(_ key: Character, _ modifiers: Modifiers = .command) {
    self.key = key
    self.modifiers = modifiers
  }

  var keyboardShortcut: KeyboardShortcut {
    var flags: EventModifiers = []
    if modifiers.contains(.command) { flags.insert(.command) }
    if modifiers.contains(.shift) { flags.insert(.shift) }
    if modifiers.contains(.option) { flags.insert(.option) }
    if modifiers.contains(.control) { flags.insert(.control) }
    let equivalent: KeyEquivalent = key == "\t" ? .tab : KeyEquivalent(key)
    return KeyboardShortcut(equivalent, modifiers: flags)
  }

  /// Apple order: ⌃⌥⇧⌘ then the key (`⇧⌘D`).
  var display: String {
    var text = ""
    if modifiers.contains(.control) { text += "⌃" }
    if modifiers.contains(.option) { text += "⌥" }
    if modifiers.contains(.shift) { text += "⇧" }
    if modifiers.contains(.command) { text += "⌘" }
    return text + (key == "\t" ? "⇥" : String(key).uppercased())
  }
}

/// Stable command identifiers (menus, palette, tests).
enum CommandID: String, CaseIterable, Sendable {
  case newNote = "note.new"
  case newFolder = "folder.new"
  case todaysNote = "daily.today"
  case previousDaily = "daily.previous"
  case nextDaily = "daily.next"
  case tomorrowsNote = "daily.tomorrow"
  case weeklyNote = "weekly.current"
  case quickOpen = "switcher.open"
  case save = "note.save"
  case renameNote = "note.rename"
  case deleteNote = "note.delete"
  case revealNote = "note.reveal"
  case closeTab = "tab.close"
  case reopenTab = "tab.reopen"
  case nextTab = "tab.next"
  case previousTab = "tab.previous"
  case tab1 = "tab.1", tab2 = "tab.2", tab3 = "tab.3", tab4 = "tab.4", tab5 = "tab.5"
  case tab6 = "tab.6", tab7 = "tab.7", tab8 = "tab.8", tab9 = "tab.9"
  case back = "nav.back"
  case forward = "nav.forward"
  case toggleSidebar = "sidebar.toggle"
  case toggleAgentPanel = "panel.agent"
  case agentInbox = "agent.inbox"
  case search = "search.open"
  case commandPalette = "palette.open"
  case toggleLivePreview = "editor.livePreview"
  case toggleReadableWidth = "editor.readable"
  case toggleLineNumbers = "editor.lineNumbers"
  case toggleVim = "editor.vim"
  case increaseFontSize = "font.increase"
  case decreaseFontSize = "font.decrease"
  case resetFontSize = "font.reset"
  case toggleTheme = "theme.toggle"
  case toggleAgent = "agent.toggle"
  case openInbox = "agent.openInbox"
  case restartDaemon = "daemon.restart"

  static let tabs: [CommandID] = [.tab1, .tab2, .tab3, .tab4, .tab5, .tab6, .tab7, .tab8, .tab9]

  /// A command id as vim's `:obcommand` takes it: ours (`daily.today`) or the web app's
  /// (`daily:today`, `editor:live-preview`, `panel:left`), so a vimrc works in both apps.
  init?(vimCommandID id: String) {
    if let exact = CommandID(rawValue: id) {
      self = exact
      return
    }
    if let alias = Self.webAliases[id] {
      self = alias
      return
    }
    let parts = id.split(separator: ":", maxSplits: 1)
    guard parts.count == 2 else { return nil }
    let words = parts[1].split(separator: "-")
    let name = words.enumerated().map { $0.offset == 0 ? String($0.element) : $0.element.capitalized }.joined()
    guard let command = CommandID(rawValue: "\(parts[0]).\(name)") else { return nil }
    self = command
  }

  /// Web command ids that don't follow the naming scheme above.
  private static let webAliases: [String: CommandID] = [
    "panel:left": .toggleSidebar, "panel:right": .toggleAgentPanel, "tab:next": .nextTab, "tab:previous": .previousTab,
  ]
}

/// One user command: what menus and the palette show, when it's available, and what it does.
struct AppCommand: Identifiable {
  let id: CommandID
  /// Menu title.
  let title: String
  /// Palette title (defaults to the menu title).
  let paletteTitle: String
  let shortcut: Shortcut?
  let showsInPalette: Bool
  /// Toggle state for checkmark menu items (nil = plain command).
  let isOn: (@MainActor () -> Bool)?
  let isEnabled: @MainActor () -> Bool
  let perform: @MainActor () -> Void

  init(
    _ id: CommandID, _ title: String, palette: String? = nil, shortcut: Shortcut? = nil,
    inPalette: Bool = true, isOn: (@MainActor () -> Bool)? = nil,
    enabled: @escaping @MainActor () -> Bool = { true }, perform: @escaping @MainActor () -> Void
  ) {
    self.id = id
    self.title = title
    paletteTitle = palette ?? title
    self.shortcut = shortcut
    showsInPalette = inPalette
    self.isOn = isOn
    isEnabled = enabled
    self.perform = perform
  }

  /// Runs the command if it's currently available; returns whether it ran.
  @MainActor
  @discardableResult
  func run() -> Bool {
    guard isEnabled() else { return false }
    perform()
    return true
  }
}
