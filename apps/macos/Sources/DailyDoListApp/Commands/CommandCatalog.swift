import AppKit
import DailyDoListModels
import Foundation

/// Every command of the app, built against the live model (menus and the palette share it).
@MainActor
struct CommandCatalog {
  let model: AppModel

  var all: [AppCommand] { build() }

  func command(_ id: CommandID) -> AppCommand? {
    all.first { $0.id == id }
  }

  /// Commands the palette lists right now (visible and available), sorted by title.
  var paletteCommands: [AppCommand] {
    all.filter { $0.showsInPalette && $0.isEnabled() }
      .sorted { $0.paletteTitle.localizedStandardCompare($1.paletteTitle) == .orderedAscending }
  }

  @discardableResult
  func run(_ id: CommandID) -> Bool {
    command(id)?.run() ?? false
  }

  // MARK: - Definitions

  private func build() -> [AppCommand] {
    let model = self.model
    let ws: () -> Workspace? = { model.phase == .ready ? model.workspace : nil }
    let ready: @MainActor () -> Bool = { ws() != nil }
    let hasNote: @MainActor () -> Bool = { ws()?.tabs.active != nil }
    let ui = model.ui
    func later(_ body: @escaping @MainActor (Workspace) async -> Void) -> @MainActor () -> Void {
      { if let workspace = ws() { Task { await body(workspace) } } }
    }

    var commands: [AppCommand] = [
      // File
      AppCommand(.newNote, "New Note", palette: "Create new note", shortcut: Shortcut("n"), enabled: ready,
        perform: later { await $0.createNote() }),
      AppCommand(.newFolder, "New Folder", palette: "Create new folder", enabled: ready,
        perform: later { await $0.createFolder() }),
      AppCommand(.todaysNote, "Today's Note", palette: "Open today's daily note", shortcut: Shortcut("d", [.command, .shift]),
        enabled: ready, perform: later { await $0.openToday() }),
      AppCommand(.previousDaily, "Previous Daily Note", palette: "Open previous daily note",
        shortcut: Shortcut("p", [.command, .shift]), enabled: ready,
        perform: later { await $0.openAdjacentDaily(.previous) }),
      AppCommand(.nextDaily, "Next Daily Note", palette: "Open next daily note",
        shortcut: Shortcut("n", [.command, .shift]), enabled: ready,
        perform: later { await $0.openAdjacentDaily(.next) }),
      AppCommand(.tomorrowsNote, "Tomorrow's Note", palette: "Open tomorrow's daily note", enabled: ready,
        perform: later { await $0.openTomorrow() }),
      AppCommand(.weeklyNote, "This Week's Note", palette: "Open this week's note",
        shortcut: Shortcut("w", [.command, .shift]), enabled: ready, perform: later { await $0.openWeekly() }),
      AppCommand(.quickOpen, "Quick Open…", palette: "Open quick switcher", shortcut: Shortcut("o"), enabled: ready) {
        ui.togglePalette(.switcher)
      },
      AppCommand(.save, "Save", palette: "Save current note", shortcut: Shortcut("s"), enabled: hasNote) {
        if let workspace = ws(), let path = workspace.tabs.active { workspace.notes.saveNow(path) }
      },
      AppCommand(.renameNote, "Rename Note…", palette: "Rename current note", enabled: hasNote) {
        if let workspace = ws(), let path = workspace.tabs.active { workspace.beginRename(path) }
      },
      AppCommand(.deleteNote, "Delete Note…", palette: "Delete current note", enabled: hasNote) {
        if let workspace = ws(), let path = workspace.tabs.active { workspace.requestDelete(path) }
      },
      AppCommand(.revealNote, "Reveal in Finder", palette: "Reveal current note in Finder",
        enabled: { hasNote() && ws()?.localVaultURL != nil }) {
        if let workspace = ws(), let path = workspace.tabs.active { workspace.revealInFinder(path) }
      },
      AppCommand(.closeTab, "Close Tab", palette: "Close current tab", shortcut: Shortcut("w")) {
        Self.closeTabOrWindow(model: model)
      },
      AppCommand(.reopenTab, "Reopen Closed Tab", shortcut: Shortcut("t", [.command, .shift]),
        enabled: { ws()?.tabs.canReopenClosedTab ?? false }, perform: later { await $0.reopenClosedTab() }),

      // Go
      AppCommand(.back, "Back", palette: "Go back", shortcut: Shortcut("["),
        enabled: { ws()?.tabs.canGoBack ?? false }, perform: later { await $0.goBack() }),
      AppCommand(.forward, "Forward", palette: "Go forward", shortcut: Shortcut("]"),
        enabled: { ws()?.tabs.canGoForward ?? false }, perform: later { await $0.goForward() }),
      AppCommand(.nextTab, "Next Tab", palette: "Go to next tab", shortcut: Shortcut("\t", [.control]),
        enabled: { (ws()?.tabs.tabs.count ?? 0) > 1 }) { ws()?.selectAdjacentTab(1) },
      AppCommand(.previousTab, "Previous Tab", palette: "Go to previous tab", shortcut: Shortcut("\t", [.control, .shift]),
        enabled: { (ws()?.tabs.tabs.count ?? 0) > 1 }) { ws()?.selectAdjacentTab(-1) },

      // View
      AppCommand(.toggleSidebar, "Toggle Sidebar", palette: "Toggle file explorer", shortcut: Shortcut("s", [.command, .control]),
        enabled: ready) { ui.sidebarVisible.toggle() },
      AppCommand(.toggleAgentPanel, "Toggle Agent Panel", shortcut: Shortcut("\\"), enabled: ready) {
        ui.toggleInspector()
      },
      AppCommand(.agentInbox, "Agent Inbox", palette: "Open agent inbox", shortcut: Shortcut("a", [.command, .shift]),
        enabled: ready) { ui.toggleInbox() },
      AppCommand(.search, "Search Vault", palette: "Search vault", shortcut: Shortcut("f", [.command, .shift]),
        enabled: ready) { ui.focusSearch() },
      AppCommand(.commandPalette, "Command Palette…", palette: "Open command palette", shortcut: Shortcut("p"),
        inPalette: false, enabled: ready) { ui.togglePalette(.commands) },
      AppCommand(.toggleLivePreview, "Live Preview", palette: "Toggle live preview",
        isOn: { model.settings.settings.editor.livePreview }, enabled: ready) {
        let value = !model.settings.settings.editor.livePreview
        Task { await model.settings.update(SettingsPatch(editor: .init(livePreview: value))) }
      },
      AppCommand(.toggleReadableWidth, "Readable Line Width", palette: "Toggle readable line width",
        isOn: { model.settings.settings.editor.readableLineLength }, enabled: ready) {
        let value = !model.settings.settings.editor.readableLineLength
        Task { await model.settings.update(SettingsPatch(editor: .init(readableLineLength: value))) }
      },
      AppCommand(.toggleLineNumbers, "Line Numbers", palette: "Toggle line numbers",
        isOn: { model.settings.settings.editor.showLineNumbers }, enabled: ready) {
        let value = !model.settings.settings.editor.showLineNumbers
        Task { await model.settings.update(SettingsPatch(editor: .init(showLineNumbers: value))) }
      },
      AppCommand(.increaseFontSize, "Increase Font Size", shortcut: Shortcut("+"), enabled: ready) {
        Self.adjustFontSize(model: model, by: 1)
      },
      AppCommand(.decreaseFontSize, "Decrease Font Size", shortcut: Shortcut("-"), enabled: ready) {
        Self.adjustFontSize(model: model, by: -1)
      },
      AppCommand(.resetFontSize, "Actual Size", palette: "Reset font size", shortcut: Shortcut("0"), enabled: ready) {
        Self.adjustFontSize(model: model, to: EditorSettings.defaults.fontSize)
      },
      AppCommand(.toggleTheme, "Toggle Light/Dark Theme", enabled: ready) {
        Self.toggleTheme(model: model)
      },

      // Agent
      AppCommand(.toggleAgent, model.agent?.status?.enabled == false ? "Resume Agent" : "Pause Agent",
        palette: "Toggle agent on/off", enabled: { model.agent?.status != nil }) {
        guard let status = model.agent?.status else { return }
        Task { await model.setAgentEnabled(!status.enabled) }
      },
      AppCommand(.openInbox, "Open Inbox", palette: "Show agent inbox", inPalette: false, enabled: ready) {
        ui.showInbox()
      },
      AppCommand(.restartDaemon, "Restart Daemon", palette: "Restart the daemon",
        enabled: { !model.isDemo && model.preferences.daemonMode == .managed }) {
        Task { await model.restartDaemon() }
      },
    ]

    for (index, id) in CommandID.tabs.enumerated() {
      let number = index + 1
      commands.append(
        AppCommand(
          id, number == 9 ? "Last Tab" : "Tab \(number)", shortcut: Shortcut(Character("\(number)")),
          inPalette: false, enabled: { !(ws()?.tabs.tabs.isEmpty ?? true) }) {
          ws()?.selectTab(number: number)
        })
    }
    return commands
  }

  // MARK: - Helpers

  /// ⌘W: closes the active tab in the main window, else the key window (Settings, a closed tab
  /// strip).
  static func closeTabOrWindow(model: AppModel) {
    let keyWindow = NSApp.keyWindow
    let isMain = keyWindow == nil || keyWindow === WindowHandles.shared.mainWindow
    if isMain, model.phase == .ready, let workspace = model.workspace, workspace.tabs.active != nil {
      workspace.closeActiveTab()
    } else {
      keyWindow?.performClose(nil)
    }
  }

  static func adjustFontSize(model: AppModel, by delta: Double = 0, to absolute: Double? = nil) {
    let current = model.settings.settings.editor.fontSize
    let target = absolute ?? current + delta
    let clamped = min(SettingsRanges.fontSize.upperBound, max(SettingsRanges.fontSize.lowerBound, target))
    guard clamped != current else { return }
    Task { await model.settings.update(SettingsPatch(editor: .init(fontSize: clamped))) }
  }

  static func toggleTheme(model: AppModel) {
    let effectiveDark: Bool =
      switch model.settings.settings.theme {
      case .dark: true
      case .light: false
      case .system: NSApp?.effectiveAppearance.bestMatch(from: [.aqua, .darkAqua]) == .darkAqua
      }
    Task { await model.settings.update(SettingsPatch(theme: effectiveDark ? .light : .dark)) }
  }
}
