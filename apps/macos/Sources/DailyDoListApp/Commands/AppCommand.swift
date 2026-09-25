import DailyDoListUI
import SwiftUI

/// A menu/palette keyboard shortcut (`Shortcut("n")` is ⌘N); drawn as keycaps, printed in Apple's
/// order (`⇧⌘D`).
typealias Shortcut = KeyShortcut

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
  case tab1 = "tab.1"
  case tab2 = "tab.2"
  case tab3 = "tab.3"
  case tab4 = "tab.4"
  case tab5 = "tab.5"
  case tab6 = "tab.6"
  case tab7 = "tab.7"
  case tab8 = "tab.8"
  case tab9 = "tab.9"
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
  case insertDrawing = "editor.insertDrawing"
  case increaseFontSize = "font.increase"
  case decreaseFontSize = "font.decrease"
  case resetFontSize = "font.reset"
  case toggleTheme = "theme.toggle"
  case toggleAgent = "agent.toggle"
  case stopTask = "agent.stop"
  case openInbox = "agent.openInbox"
  case orchestratorChat = "agent.orchestrator"
  case runOrchestratorHere = "agent.runHere"
  case runOrchestratorOnMachine = "agent.runOnMachine"
  case showRoutines = "routines.show"
  case newRoutine = "routine.new"
  case setUpComputerUse = "computerUse.setUp"
  case approvalPolicy = "settings.approvals"
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
    let name = words.enumerated().map {
      $0.offset == 0 ? String($0.element) : $0.element.capitalized
    }.joined()
    guard let command = CommandID(rawValue: "\(parts[0]).\(name)") else { return nil }
    self = command
  }

  /// Web command ids that don't follow the naming scheme above.
  private static let webAliases: [String: CommandID] = [
    "panel:left": .toggleSidebar, "panel:right": .toggleAgentPanel, "tab:next": .nextTab,
    "tab:previous": .previousTab,
  ]

  /// The command's keyboard shortcut. This is the only place shortcuts are defined: the menus,
  /// the palette and the tooltips of the controls that run a command all read it here.
  var shortcut: Shortcut? {
    switch self {
    case .newNote: Shortcut("n")
    case .todaysNote: Shortcut("d", [.command, .shift])
    case .previousDaily: Shortcut("p", [.command, .shift])
    case .nextDaily: Shortcut("n", [.command, .shift])
    case .weeklyNote: Shortcut("w", [.command, .shift])
    case .quickOpen: Shortcut("o")
    case .save: Shortcut("s")
    case .closeTab: Shortcut("w")
    case .reopenTab: Shortcut("t", [.command, .shift])
    case .back: Shortcut("[")
    case .forward: Shortcut("]")
    case .nextTab: Shortcut("\t", [.control])
    case .previousTab: Shortcut("\t", [.control, .shift])
    case .toggleSidebar: Shortcut("s", [.command, .control])
    case .toggleAgentPanel: Shortcut("\\")
    case .agentInbox: Shortcut("a", [.command, .shift])
    case .showRoutines: Shortcut("r", [.command, .shift])
    case .newRoutine: Shortcut("n", [.command, .option])
    case .stopTask: Shortcut(".")
    case .search: Shortcut("f", [.command, .shift])
    case .insertDrawing: Shortcut("x", [.command, .shift])
    case .commandPalette: Shortcut("p")
    case .increaseFontSize: Shortcut("+")
    case .decreaseFontSize: Shortcut("-")
    case .resetFontSize: Shortcut("0")
    case .tab1: Shortcut("1")
    case .tab2: Shortcut("2")
    case .tab3: Shortcut("3")
    case .tab4: Shortcut("4")
    case .tab5: Shortcut("5")
    case .tab6: Shortcut("6")
    case .tab7: Shortcut("7")
    case .tab8: Shortcut("8")
    case .tab9: Shortcut("9")
    case .newFolder, .tomorrowsNote, .renameNote, .deleteNote, .revealNote, .toggleLivePreview,
      .toggleReadableWidth, .toggleLineNumbers, .toggleVim, .toggleTheme, .toggleAgent, .openInbox,
      .orchestratorChat, .runOrchestratorHere, .runOrchestratorOnMachine, .setUpComputerUse,
      .approvalPolicy, .restartDaemon:
      nil
    }
  }
}

/// One user command: what menus and the palette show, when it's available, and what it does.
struct AppCommand: Identifiable {
  let id: CommandID
  /// Menu title.
  let title: String
  /// Palette title (defaults to the menu title).
  let paletteTitle: String
  /// ``CommandID/shortcut``.
  var shortcut: Shortcut? { id.shortcut }
  let showsInPalette: Bool
  /// Toggle state for checkmark menu items (nil = plain command).
  let isOn: (@MainActor () -> Bool)?
  let isEnabled: @MainActor () -> Bool
  let perform: @MainActor () -> Void

  init(
    _ id: CommandID, _ title: String, palette: String? = nil, inPalette: Bool = true,
    isOn: (@MainActor () -> Bool)? = nil, enabled: @escaping @MainActor () -> Bool = { true },
    perform: @escaping @MainActor () -> Void
  ) {
    self.id = id
    self.title = title
    paletteTitle = palette ?? title
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
